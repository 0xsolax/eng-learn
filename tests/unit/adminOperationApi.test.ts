import { describe, expect, it } from 'vitest'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'

const ORIGIN = 'https://eng-learn.test'
const SOURCE_TOKEN = 'a'.repeat(64)
const COURSE_TOKEN = 'b'.repeat(64)
const ROTATE_TOKEN_A = 'c'.repeat(64)
const ROTATE_TOKEN_B = 'd'.repeat(64)
const NEXT_VERSION_TOKEN = 'e'.repeat(64)

describe('admin operation API', () => {
  it('shares one ledger across operation kinds and replays a lost new-source response', async () => {
    const app = createTestWorkerApp({ adminIdentity: { id: 'admin-1' } })
    const command = {
      mode: 'new_source',
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: createWords(),
    }

    const first = await postSuccess<ImportedVersion>(
      app,
      '/api/admin/source-versions/import',
      command,
    )
    const replay = await postSuccess<ImportedVersion>(
      app,
      '/api/admin/source-versions/import',
      command,
    )

    expect(replay).toEqual(first)
    const versions = await getSuccess<ImportedVersion[]>(app, '/api/admin/source-versions')
    expect(versions).toHaveLength(1)

    const conflict = await app.fetch(
      adminRequest('/api/admin/courses', {
        method: 'POST',
        body: {
          operationToken: SOURCE_TOKEN,
          learnerName: 'Alice',
          loginAccount: 'alice01',
          pin: '123456',
          sourceVersionId: first.versionId,
        },
      }),
    )

    await expectFailure(conflict, 409, 'idempotency_conflict')
  })

  it('replays a next-version import through the public API without a duplicate draft', async () => {
    const app = createTestWorkerApp({ adminIdentity: { id: 'admin-1' } })
    const publishedVersionId = await createPublishedVersion(app)
    const [published] = await getSuccess<Array<{ sourceId: string }>>(
      app,
      '/api/admin/source-versions',
    )

    if (!published) throw new Error('Expected one published source version')

    const command = {
      mode: 'next_version',
      operationToken: NEXT_VERSION_TOKEN,
      sourceId: published.sourceId,
      words: createWords(),
    }
    const first = await postSuccess<ImportedVersion>(
      app,
      '/api/admin/source-versions/import',
      command,
    )
    const replay = await postSuccess<ImportedVersion>(
      app,
      '/api/admin/source-versions/import',
      command,
    )

    expect(replay).toEqual(first)
    expect(first.versionId).not.toBe(publishedVersionId)
    await expect(
      getSuccess<ImportedVersion[]>(app, '/api/admin/source-versions'),
    ).resolves.toHaveLength(2)

    const changedContext = await app.fetch(
      adminRequest('/api/admin/source-versions/import', {
        method: 'POST',
        body: {
          ...command,
          words: command.words.map((word, index) =>
            index === 0
              ? { ...word, examplePhrase: 'A fresh apple' }
              : word,
          ),
        },
      }),
    )
    await expectFailure(changedContext, 409, 'idempotency_conflict')
  })

  it('creates account login, updates it idempotently, and revokes the old login paths', async () => {
    const app = createTestWorkerApp({ adminIdentity: { id: 'admin-1' } })
    const sourceVersionId = await createPublishedVersion(app)
    const courseCommand = {
      operationToken: COURSE_TOKEN,
      learnerName: 'Alice',
      loginAccount: 'alice01',
      pin: '123456',
      sourceVersionId,
    }
    const created = await postSuccess<CreatedCourse>(app, '/api/admin/courses', courseCommand)
    const replay = await postSuccess<CreatedCourse>(app, '/api/admin/courses', courseCommand)
    expect(replay).toEqual(created)
    expect(created.learner).toMatchObject({ loginAccount: 'alice01' })
    expect(JSON.stringify(created)).not.toMatch(/123456|accessCode|loginPinHash/u)

    const before = await getSuccess<AdminCourseList>(app, '/api/admin/courses')
    expect(before.courses).toHaveLength(1)
    expect(before.courses[0]?.credentialVersion).toBe(1)

    const sessionResponse = await app.fetch(
      new Request(`${ORIGIN}/api/app/session/by-account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ loginAccount: 'alice01', pin: '123456' }),
      }),
    )
    expect(sessionResponse.status).toBe(200)
    const oldCookie = sessionResponse.headers.get('set-cookie')?.split(';')[0] ?? ''

    const updatePath = `/api/admin/learners/${created.learner.id}/login-credential`
    const updateCommand = {
      operationToken: ROTATE_TOKEN_A,
      expectedCredentialVersion: 1,
      loginAccount: 'alice02',
      pin: '654321',
    }
    const updated = await postSuccess<UpdatedLogin>(app, updatePath, updateCommand)
    const updateReplay = await postSuccess<UpdatedLogin>(app, updatePath, updateCommand)
    expect(updateReplay).toEqual(updated)
    expect(updated).toEqual({
      loginAccount: 'alice02',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })

    const revokedSession = await app.fetch(
      new Request(`${ORIGIN}/api/app/session`, {
        headers: { cookie: oldCookie, origin: ORIGIN },
      }),
    )
    await expectFailure(revokedSession, 401, 'learner_session_revoked')
    const oldLogin = await app.fetch(
      new Request(`${ORIGIN}/api/app/session/by-account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ loginAccount: 'alice01', pin: '123456' }),
      }),
    )
    await expectFailure(oldLogin, 401, 'invalid_learner_credentials')
    const newLogin = await app.fetch(
      new Request(`${ORIGIN}/api/app/session/by-account`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ loginAccount: 'alice02', pin: '654321' }),
      }),
    )
    expect(newLogin.status).toBe(200)

    await postSuccess<UpdatedLogin>(app, updatePath, {
      operationToken: ROTATE_TOKEN_B,
      expectedCredentialVersion: 2,
      loginAccount: 'alice03',
    })

    const staleReplay = await app.fetch(
      adminRequest(updatePath, { method: 'POST', body: updateCommand }),
    )
    await expectFailure(staleReplay, 409, 'operation_superseded')

    const changedPayload = await app.fetch(
      adminRequest(updatePath, {
        method: 'POST',
        body: { ...updateCommand, loginAccount: 'other01' },
      }),
    )
    await expectFailure(changedPayload, 409, 'idempotency_conflict')

    const createReplayAfterRotation = await app.fetch(
      adminRequest('/api/admin/courses', { method: 'POST', body: courseCommand }),
    )
    await expectFailure(createReplayAfterRotation, 409, 'operation_superseded')
  })

  it('keeps invalid account responses indistinguishable and returns a Retry-After cooldown', async () => {
    const app = createTestWorkerApp({ adminIdentity: { id: 'admin-1' } })
    const sourceVersionId = await createPublishedVersion(app)
    await postSuccess<CreatedCourse>(app, '/api/admin/courses', {
      operationToken: COURSE_TOKEN,
      learnerName: 'Alice',
      loginAccount: 'alice01',
      pin: '123456',
      sourceVersionId,
    })

    const knownWrong = await learnerLogin(app, 'alice01', '999999')
    const unknownWrong = await learnerLogin(app, 'nobody01', '999999')
    expect(knownWrong.status).toBe(401)
    expect(unknownWrong.status).toBe(401)
    expect(await knownWrong.json()).toEqual(await unknownWrong.json())

    for (let attempt = 2; attempt < 5; attempt += 1) {
      await expectFailure(await learnerLogin(app, 'nobody01', '999999'), 401, 'invalid_learner_credentials')
    }
    const limited = await learnerLogin(app, 'nobody01', '999999')
    await expectFailure(limited.clone(), 429, 'learner_login_rate_limited')
    expect(limited.headers.get('retry-after')).toBe('900')
  })
})

type ImportedVersion = {
  sourceId: string
  versionId: string
}

type CreatedCourse = {
  learner: { id: string; loginAccount: string }
  course: { id: string }
}

type UpdatedLogin = {
  loginAccount: string
  credentialVersion: number
  revokedSessionCount: number
}

type AdminCourseList = {
  courses: Array<{ credentialVersion: number }>
}

const createPublishedVersion = async (app: WorkerApp): Promise<string> => {
  const imported = await postSuccess<ImportedVersion>(
    app,
    '/api/admin/source-versions/import',
    {
      mode: 'new_source',
      operationToken: SOURCE_TOKEN,
      sourceName: 'Published source',
      words: createWords(),
    },
  )
  await postSuccess(app, `/api/admin/source-versions/${imported.versionId}/build`, {})
  const items = await getSuccess<Array<{ id: string }>>(
    app,
    `/api/admin/source-versions/${imported.versionId}/exercises`,
  )
  await postSuccess(app, '/api/admin/exercise-items/batch-approve', {
    itemIds: items.map((item) => item.id),
  })
  await postSuccess(app, `/api/admin/source-versions/${imported.versionId}/publish`, {})

  return imported.versionId
}

const createWords = () =>
  Array.from({ length: 10 }, (_, index) => ({
    word: `word-${String(index + 1)}`,
    meaning: `meaning-${String(index + 1)}`,
    examplePhrase: `word-${String(index + 1)}`,
    exampleSentence: `I use word-${String(index + 1)} here.`,
    exampleSentenceExtended: `I use word-${String(index + 1)} here every day.`,
  }))

const adminRequest = (
  path: string,
  input: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      'cf-access-jwt-assertion': 'controlled-test-assertion',
      origin: ORIGIN,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })

const postSuccess = async <T = unknown>(
  app: WorkerApp,
  path: string,
  body: unknown,
): Promise<T> => readSuccess(await app.fetch(adminRequest(path, { method: 'POST', body })))

const getSuccess = async <T>(app: WorkerApp, path: string): Promise<T> =>
  readSuccess(await app.fetch(adminRequest(path)))

const learnerLogin = (app: WorkerApp, loginAccount: string, pin: string): Promise<Response> =>
  app.fetch(
    new Request(`${ORIGIN}/api/app/session/by-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ loginAccount, pin }),
    }),
  )

const readSuccess = async <T>(response: Response): Promise<T> => {
  const body = await response.json<{ ok: boolean; data?: T; error?: unknown }>()
  expect(response.status, JSON.stringify(body.error)).toBe(200)
  expect(body.ok).toBe(true)

  return body.data as T
}

const expectFailure = async (
  response: Response,
  status: number,
  code: string,
): Promise<void> => {
  expect(response.status).toBe(status)
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code },
  })
}
