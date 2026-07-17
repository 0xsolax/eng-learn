import { describe, expect, it } from 'vitest'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const ORIGIN = 'https://eng-learn.test'

describe('worker learner session security contract', () => {
  it('exchanges a one-time learning code for an HttpOnly cookie and restores the session', async () => {
    const fixture = await createPublishedCourseFixture()
    const response = await fixture.app.fetch(
      request('/api/app/session/by-code', {
        method: 'POST',
        origin: ORIGIN,
        body: { accessCode: fixture.accessCode },
      }),
    )
    const body = await readSuccess<{
      learner: { id: string; name: string }
      course: { id: string }
    }>(response)
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(setCookie).toMatch(/^__Host-eng_learn_session=[^;]+;/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(JSON.stringify(body)).not.toContain(fixture.accessCode)
    expect(body).not.toHaveProperty('token')

    const cookie = setCookie.split(';')[0]
    const restored = await readSuccess<{
      learner: { id: string }
      course: { id: string; currentLessonNo: number }
    }>(
      await fixture.app.fetch(
        request('/api/app/session', {
          method: 'GET',
          ...(cookie ? { cookie } : {}),
        }),
      ),
    )

    expect(restored).toMatchObject({
      learner: { id: body.learner.id },
      course: { id: fixture.courseId, currentLessonNo: 1 },
    })
  })

  it('rejects missing sessions, cross-course access, and a mismatched write origin', async () => {
    const first = await createPublishedCourseFixture()
    const secondCourse = await createCourse(first.app, first.sourceVersionId, 'Bob')
    const firstCookie = await exchangeCode(first.app, first.accessCode)

    const withoutSession = await first.app.fetch(
      request(`/api/app/courses/${first.courseId}/lessons/start`, {
        method: 'POST',
        origin: ORIGIN,
      }),
    )
    expect(withoutSession.status).toBe(401)
    expect(await readErrorCode(withoutSession)).toBe('learner_session_required')

    const crossCourse = await first.app.fetch(
      request(`/api/app/courses/${secondCourse.course.id}/lessons/start`, {
        method: 'POST',
        origin: ORIGIN,
        cookie: firstCookie,
      }),
    )
    expect(crossCourse.status).toBe(403)
    expect(await readErrorCode(crossCourse)).toBe('forbidden_resource')

    const wrongOrigin = await first.app.fetch(
      request(`/api/app/courses/${first.courseId}/lessons/start`, {
        method: 'POST',
        origin: 'https://attacker.example',
        cookie: firstCookie,
      }),
    )
    expect(wrongOrigin.status).toBe(403)
    expect(await readErrorCode(wrongOrigin)).toBe('origin_forbidden')
  })

  it('validates ownership before idempotent answer lookup and clears the current cookie on logout', async () => {
    const first = await createPublishedCourseFixture()
    const secondCourse = await createCourse(first.app, first.sourceVersionId, 'Bob')
    const firstCookie = await exchangeCode(first.app, first.accessCode)
    const secondCookie = await exchangeCode(first.app, secondCourse.learner.accessCode)
    const secondLesson = await readSuccess<{
      session: { id: string }
      tasks: Array<{ id: string; taskType: string }>
    }>(
      await first.app.fetch(
        request(`/api/app/courses/${secondCourse.course.id}/lessons/start`, {
          method: 'POST',
          origin: ORIGIN,
          cookie: secondCookie,
        }),
      ),
    )
    const secondTask = secondLesson.tasks[0]

    if (!secondTask) throw new Error('Expected a lesson task')
    const forbidden = await first.app.fetch(
      request(`/api/app/lessons/${secondLesson.session.id}/tasks/${secondTask.id}/answer`, {
        method: 'POST',
        origin: ORIGIN,
        cookie: firstCookie,
        body: { taskType: 'recognize_meaning', response: 'known' },
      }),
    )

    expect(forbidden.status).toBe(403)
    expect(await readErrorCode(forbidden)).toBe('forbidden_resource')

    const logout = await first.app.fetch(
      request('/api/app/session/logout', {
        method: 'POST',
        origin: ORIGIN,
        cookie: firstCookie,
      }),
    )

    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toMatch(
      /__Host-eng_learn_session=;.*Max-Age=0.*HttpOnly.*SameSite=Strict/,
    )
    const afterLogout = await first.app.fetch(
      request('/api/app/session', { method: 'GET', cookie: firstCookie }),
    )
    expect(afterLogout.status).toBe(401)
    expect(await readErrorCode(afterLogout)).toBe('learner_session_revoked')
  })

  it('keeps v2 queue policy and disposition out of learner answer payloads', async () => {
    const fixture = await createPublishedCourseFixture()
    const cookie = await exchangeCode(fixture.app, fixture.accessCode)
    const lesson = await readSuccess<{
      session: { id: string }
      tasks: Array<{ id: string }>
    }>(
      await fixture.app.fetch(
        request(`/api/app/courses/${fixture.courseId}/lessons/start`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
        }),
      ),
    )
    const firstTask = lesson.tasks[0]

    if (!firstTask) throw new Error('Expected a lesson task')
    const submitted = await readSuccess<Record<string, unknown>>(
      await fixture.app.fetch(
        request(`/api/app/lessons/${lesson.session.id}/tasks/${firstTask.id}/answer`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: { taskType: 'recognize_meaning', response: 'learning' },
        }),
      ),
    )

    expect(submitted).toMatchObject({ taskId: firstTask.id, score: 0, correct: false })
    expect(JSON.stringify(submitted)).not.toMatch(/queueDisposition|queuePolicyVersion/u)
  })
})

const createPublishedCourseFixture = async () => {
  const app = createTestWorkerApp({
    adminIdentity: { id: 'admin-1', email: 'admin@example.test' },
    allowedOrigin: ORIGIN,
  })
  const imported = await readSuccess<{ versionId: string }>(
    await app.fetch(
      request('/api/admin/source-versions/import', {
        method: 'POST',
        body: {
          mode: 'new_source',
          operationToken: generateAdminOperationToken(),
          sourceName: 'Security source',
          words: Array.from({ length: 5 }, (_, index) => ({
            word: `word-${String(index + 1)}`,
            meaning: `meaning-${String(index + 1)}`,
            examplePhrase: `word-${String(index + 1)}`,
            exampleSentence: `I use word-${String(index + 1)} here.`,
            exampleSentenceExtended: `I use word-${String(index + 1)} here every day.`,
          })),
        },
      }),
    ),
  )

  await readSuccess(
    await app.fetch(
      request(`/api/admin/source-versions/${imported.versionId}/build`, {
        method: 'POST',
      }),
    ),
  )
  const items = await readSuccess<Array<{ id: string }>>(
    await app.fetch(request(`/api/admin/source-versions/${imported.versionId}/exercises`)),
  )
  await readSuccess(
    await app.fetch(
      request('/api/admin/exercise-items/batch-approve', {
        method: 'POST',
        body: { itemIds: items.map((item) => item.id) },
      }),
    ),
  )
  await readSuccess(
    await app.fetch(
      request(`/api/admin/source-versions/${imported.versionId}/publish`, {
        method: 'POST',
      }),
    ),
  )
  const created = await createCourse(app, imported.versionId, 'Alice')

  return {
    app,
    sourceVersionId: imported.versionId,
    courseId: created.course.id,
    accessCode: created.learner.accessCode,
  }
}

const createCourse = async (app: WorkerApp, sourceVersionId: string, learnerName: string) =>
  readSuccess<{
    learner: { id: string; name: string; accessCode: string }
    course: { id: string }
  }>(
    await app.fetch(
      request('/api/admin/courses', {
        method: 'POST',
        body: {
          operationToken: generateAdminOperationToken(),
          learnerName,
          sourceVersionId,
        },
      }),
    ),
  )

const exchangeCode = async (app: WorkerApp, accessCode: string): Promise<string> => {
  const response = await app.fetch(
    request('/api/app/session/by-code', {
      method: 'POST',
      origin: ORIGIN,
      body: { accessCode },
    }),
  )
  await readSuccess(response)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]

  if (!cookie) throw new Error('Expected a learner session cookie')

  return cookie
}

const request = (
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PUT'
    body?: unknown
    origin?: string
    cookie?: string
  } = {},
): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(path.startsWith('/api/admin/')
        ? { 'cf-access-jwt-assertion': 'controlled-test-assertion', origin: ORIGIN }
        : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })

const readSuccess = async <T = unknown>(response: Response): Promise<T> => {
  const body = await response.json<{ ok: boolean; data?: T; error?: unknown }>()

  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(body.ok).toBe(true)

  if (body.data === undefined) throw new Error('Expected response data')

  return body.data
}

const readErrorCode = async (response: Response): Promise<string> => {
  const body = await response.json<{ ok: false; error: { code: string } }>()

  return body.error.code
}
