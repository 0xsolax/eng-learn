import { describe, expect, it } from 'vitest'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'

const ORIGIN = 'https://eng-learn.test'
const SOURCE_TOKEN = 'a'.repeat(64)
const COURSE_TOKEN = 'b'.repeat(64)
const ROTATE_TOKEN_A = 'c'.repeat(64)
const ROTATE_TOKEN_B = 'd'.repeat(64)

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
          sourceVersionId: first.versionId,
        },
      }),
    )

    await expectFailure(conflict, 409, 'idempotency_conflict')
  })

  it('replays create and rotate, exposes credential version, and rejects stale recovery', async () => {
    const app = createTestWorkerApp({ adminIdentity: { id: 'admin-1' } })
    const sourceVersionId = await createPublishedVersion(app)
    const courseCommand = {
      operationToken: COURSE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId,
    }
    const created = await postSuccess<CreatedCourse>(app, '/api/admin/courses', courseCommand)
    const replay = await postSuccess<CreatedCourse>(app, '/api/admin/courses', courseCommand)
    expect(replay).toEqual(created)

    const before = await getSuccess<AdminCourseList>(app, '/api/admin/courses')
    expect(before.courses).toHaveLength(1)
    expect(before.courses[0]?.credentialVersion).toBe(1)

    const sessionResponse = await app.fetch(
      new Request(`${ORIGIN}/api/app/session/by-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ accessCode: created.learner.accessCode }),
      }),
    )
    expect(sessionResponse.status).toBe(200)

    const rotatePath = `/api/admin/learners/${created.learner.id}/access-code/rotate`
    const rotateCommand = {
      operationToken: ROTATE_TOKEN_A,
      expectedCredentialVersion: 1,
    }
    const rotated = await postSuccess<RotatedCode>(app, rotatePath, rotateCommand)
    const rotateReplay = await postSuccess<RotatedCode>(app, rotatePath, rotateCommand)
    expect(rotateReplay).toEqual(rotated)
    expect(rotated).toMatchObject({ credentialVersion: 2, revokedSessionCount: 1 })

    await postSuccess<RotatedCode>(app, rotatePath, {
      operationToken: ROTATE_TOKEN_B,
      expectedCredentialVersion: 2,
    })

    const staleReplay = await app.fetch(
      adminRequest(rotatePath, { method: 'POST', body: rotateCommand }),
    )
    await expectFailure(staleReplay, 409, 'operation_superseded')

    const changedPayload = await app.fetch(
      adminRequest(rotatePath, {
        method: 'POST',
        body: { ...rotateCommand, expectedCredentialVersion: 2 },
      }),
    )
    await expectFailure(changedPayload, 409, 'idempotency_conflict')

    const createReplayAfterRotation = await app.fetch(
      adminRequest('/api/admin/courses', { method: 'POST', body: courseCommand }),
    )
    await expectFailure(createReplayAfterRotation, 409, 'operation_superseded')
  })
})

type ImportedVersion = {
  sourceId: string
  versionId: string
}

type CreatedCourse = {
  learner: { id: string; accessCode: string }
  course: { id: string }
}

type RotatedCode = {
  accessCode: string
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
    exampleSentence: `I use word-${String(index + 1)} here.`,
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
