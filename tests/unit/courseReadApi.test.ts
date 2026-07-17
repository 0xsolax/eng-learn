import { describe, expect, it } from 'vitest'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const ORIGIN = 'https://eng-learn.test'

describe('course read API', () => {
  it('lists admin courses without exposing current or historical learning codes', async () => {
    const fixture = await createFixture()
    const second = await createCourse(fixture.app, fixture.sourceVersionId, 'Bob')
    const courses = await readSuccess<{
      courses: Array<{ learner: { id: string; name: string }; course: { id: string } }>
    }>(await fixture.app.fetch(request('/api/admin/courses')))

    expect(courses.courses.map((item) => item.learner.name).sort()).toEqual(['Alice', 'Bob'])
    expect(courses.courses.map((item) => item.course.id).sort()).toEqual(
      [fixture.courseId, second.course.id].sort(),
    )
    expect(JSON.stringify(courses)).not.toMatch(/accessCode|access_code|sha256:/u)
  })

  it('restores course home and a completed report only through the learner principal', async () => {
    const fixture = await createFixture()
    const second = await createCourse(fixture.app, fixture.sourceVersionId, 'Bob')
    const cookie = await exchangeCode(fixture.app, fixture.accessCode)
    const secondCookie = await exchangeCode(fixture.app, second.learner.accessCode)
    const initialHome = await readSuccess<{
      course: { id: string; currentLessonNo: number }
      newWordCount: number
      reviewWordCount: number
      action: string
      startedSessionId?: string
      lessonPath: unknown[]
    }>(await fixture.app.fetch(request('/api/app/course', { cookie })))

    expect(initialHome).toMatchObject({
      course: { id: fixture.courseId, currentLessonNo: 1 },
      newWordCount: 5,
      reviewWordCount: 0,
      action: 'start',
      lessonPath: [
        { lessonNo: 1, status: 'current' },
        { lessonNo: 2, status: 'locked' },
      ],
    })
    expect(initialHome).not.toHaveProperty('startedSessionId')

    const lesson = await readSuccess<{
      session: { id: string }
      tasks: Array<{ id: string }>
    }>(
      await fixture.app.fetch(
        request(`/api/app/courses/${fixture.courseId}/lessons/start`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: {},
        }),
      ),
    )
    const continuingHome = await readSuccess<typeof initialHome>(
      await fixture.app.fetch(request('/api/app/course', { cookie })),
    )

    expect(continuingHome).toMatchObject({
      action: 'continue',
      startedSessionId: lesson.session.id,
    })

    const unfinished = await fixture.app.fetch(
      request(`/api/app/lessons/${lesson.session.id}/report`, { cookie }),
    )
    expect(unfinished.status).toBe(409)
    expect(await readErrorCode(unfinished)).toBe('report_unavailable')

    for (const task of lesson.tasks.slice(0, 4)) {
      await readSuccess(
        await fixture.app.fetch(
          request(`/api/app/lessons/${lesson.session.id}/tasks/${task.id}/answer`, {
            method: 'POST',
            origin: ORIGIN,
            cookie,
            body: { taskType: 'recognize_meaning', response: 'known' },
          }),
        ),
      )
    }
    await readSuccess(
      await fixture.app.fetch(
        request(`/api/app/lessons/${lesson.session.id}/complete`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: {},
        }),
      ),
    )

    const reportResponse = await fixture.app.fetch(
      request(`/api/app/lessons/${lesson.session.id}/report`, { cookie }),
    )
    const report = await readSuccess<{
      lessonNo: number
      completedTaskCount: number
      totalTaskCount: number
      correctRate: number
      needsPracticeWords: unknown[]
      progressWords: unknown[]
      nextLessonNo: number
      courseStatus: string
    }>(reportResponse)
    const refreshed = await readSuccess<typeof report>(
      await fixture.app.fetch(
        request(`/api/app/lessons/${lesson.session.id}/report`, { cookie }),
      ),
    )

    expect(report).toMatchObject({
      lessonNo: 1,
      completedTaskCount: 4,
      totalTaskCount: 5,
      correctRate: 1,
      needsPracticeWords: [],
      nextLessonNo: 2,
      courseStatus: 'active',
    })
    expect(report.progressWords).toHaveLength(4)
    expect(refreshed).toEqual(report)
    expect(JSON.stringify(report)).not.toMatch(
      /easeFactor|masteryScore|nextDueLessonNo|wrongStreak/u,
    )

    const crossCourse = await fixture.app.fetch(
      request(`/api/app/lessons/${lesson.session.id}/report`, { cookie: secondCookie }),
    )
    expect(crossCourse.status).toBe(403)
    expect(await readErrorCode(crossCourse)).toBe('forbidden_resource')
  })
})

const createFixture = async () => {
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
          sourceName: 'Course read source',
          words: Array.from({ length: 10 }, (_, index) => ({
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
        body: {},
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
        body: {},
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
    method?: 'GET' | 'POST'
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
