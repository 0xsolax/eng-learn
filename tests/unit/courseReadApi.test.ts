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
    const cookie = await exchangeAccount(fixture.app, fixture.loginAccount)
    const secondCookie = await exchangeAccount(fixture.app, second.learner.loginAccount)
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

    await answerUntilLessonIsCompletable(fixture.app, lesson.session.id, cookie)
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
      completedTaskCount: 6,
      totalTaskCount: 7,
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

  it('lets a learner select and repeat a completed lesson without changing formal progress', async () => {
    const fixture = await createFixture()
    const cookie = await exchangeAccount(fixture.app, fixture.loginAccount)
    const sessionId = await completeCurrentLesson(fixture.app, fixture.courseId, cookie)
    const beforeHome = await readSuccess<{ course: { currentLessonNo: number } }>(
      await fixture.app.fetch(request('/api/app/course', { cookie })),
    )

    const completed = await readSuccess<{
      currentLearningRunNo: number
      lessons: Array<{
        sourceSessionId: string
        learningRunNo: number
        lessonNo: number
      }>
    }>(
      await fixture.app.fetch(
        request(`/api/app/courses/${fixture.courseId}/completed-lessons?limit=20`, {
          cookie,
        }),
      ),
    )
    expect(completed).toMatchObject({
      currentLearningRunNo: 1,
      lessons: [
        { sourceSessionId: sessionId, learningRunNo: 1, lessonNo: 1 },
      ],
    })

    const replay = await readSuccess<{
      session: { id: string; sourceSessionId: string; lessonNo: number }
      tasks: Array<{ id: string; sessionId: string }>
    }>(
      await fixture.app.fetch(
        request(`/api/app/lessons/${sessionId}/replays`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: {},
        }),
      ),
    )
    expect(replay.session).toMatchObject({ sourceSessionId: sessionId, lessonNo: 1 })
    expect(replay.tasks.every((task) => task.sessionId === replay.session.id)).toBe(true)

    await answerReplayUntilComplete(fixture.app, replay.session.id, cookie)
    const replayCompleted = await readSuccess<{
      session: { status: string; completedTaskCount: number; taskCount: number }
    }>(
      await fixture.app.fetch(
        request(`/api/app/lesson-replays/${replay.session.id}/complete`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: {},
        }),
      ),
    )
    expect(replayCompleted.session).toMatchObject({
      status: 'completed',
      completedTaskCount: replayCompleted.session.taskCount,
    })

    const afterHome = await readSuccess<typeof beforeHome>(
      await fixture.app.fetch(request('/api/app/course', { cookie })),
    )
    expect(afterHome).toEqual(beforeHome)
  })

  it('lets an administrator restart the same course as a new formal learning run', async () => {
    const fixture = await createFixture()
    const cookie = await exchangeAccount(fixture.app, fixture.loginAccount)
    await completeCurrentLesson(fixture.app, fixture.courseId, cookie)
    const oldLesson = await readSuccess<{
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
    const operationToken = generateAdminOperationToken()
    const body = {
      operationToken,
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 2,
    }
    const reset = await readSuccess<{
      course: { id: string; currentLessonNo: number }
      learningRunNo: number
      abandonedSessionCount: number
      historyPreserved: true
    }>(
      await fixture.app.fetch(
        request(`/api/admin/courses/${fixture.courseId}/learning-progress/reset`, {
          method: 'POST',
          body,
        }),
      ),
    )
    const retried = await readSuccess<typeof reset>(
      await fixture.app.fetch(
        request(`/api/admin/courses/${fixture.courseId}/learning-progress/reset`, {
          method: 'POST',
          body,
        }),
      ),
    )

    expect(retried).toEqual(reset)
    expect(reset).toMatchObject({
      course: { id: fixture.courseId, currentLessonNo: 1 },
      learningRunNo: 2,
      abandonedSessionCount: 1,
      historyPreserved: true,
    })
    const courses = await readSuccess<{
      courses: Array<{
        course: { id: string; currentLessonNo: number }
        learningRunNo: number
      }>
    }>(await fixture.app.fetch(request('/api/admin/courses')))
    expect(courses.courses.find((item) => item.course.id === fixture.courseId)).toMatchObject({
      course: { currentLessonNo: 1 },
      learningRunNo: 2,
    })

    const home = await readSuccess<{
      course: { currentLessonNo: number }
      action: string
    }>(await fixture.app.fetch(request('/api/app/course', { cookie })))
    expect(home).toMatchObject({ course: { currentLessonNo: 1 }, action: 'start' })

    const oldAnswer = await fixture.app.fetch(
      request(
        `/api/app/lessons/${oldLesson.session.id}/tasks/${oldLesson.tasks[0]?.id ?? 'missing'}/answer`,
        {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: { taskType: 'recognize_meaning', response: 'known' },
        },
      ),
    )
    expect(oldAnswer.status).toBe(409)
    expect(await readErrorCode(oldAnswer)).toBe('lesson_not_active')

    const restarted = await readSuccess<{ session: { lessonNo: number } }>(
      await fixture.app.fetch(
        request(`/api/app/courses/${fixture.courseId}/lessons/start`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body: {},
        }),
      ),
    )
    expect(restarted.session.lessonNo).toBe(1)
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
    loginAccount: created.learner.loginAccount,
  }
}

const createCourse = async (app: WorkerApp, sourceVersionId: string, learnerName: string) =>
  readSuccess<{
    learner: { id: string; name: string; loginAccount: string }
    course: { id: string }
  }>(
    await app.fetch(
      request('/api/admin/courses', {
        method: 'POST',
        body: {
          operationToken: generateAdminOperationToken(),
          learnerName,
          loginAccount: `${learnerName.toLowerCase()}01`,
          pin: '123456',
          sourceVersionId,
        },
      }),
    ),
  )

const exchangeAccount = async (app: WorkerApp, loginAccount: string): Promise<string> => {
  const response = await app.fetch(
    request('/api/app/session/by-account', {
      method: 'POST',
      origin: ORIGIN,
      body: { loginAccount, pin: '123456' },
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

const answerUntilLessonIsCompletable = async (
  app: WorkerApp,
  sessionId: string,
  cookie: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lesson = await readSuccess<{
      tasks: Array<{
        id: string
        role: 'primary' | 'bridge' | 'reflux'
        required: boolean
        status: 'pending' | 'completed' | 'skipped'
        taskType: 'recognize_meaning' | 'multiple_choice'
        prompt: { meaning: string }
      }>
    }>(await app.fetch(request(`/api/app/lessons/${sessionId}`, { cookie })))
    const primaryTasks = lesson.tasks.filter((task) => task.role === 'primary')
    const completedPrimaryCount = primaryTasks.filter(
      (task) => task.status === 'completed',
    ).length
    const pendingRequiredTasks = lesson.tasks.filter(
      (task) => task.required && task.status === 'pending',
    )

    if (
      completedPrimaryCount * 5 >= primaryTasks.length * 4 &&
      pendingRequiredTasks.length === 0
    ) {
      return
    }

    const nextTask = lesson.tasks.find((task) => task.status === 'pending')

    if (!nextTask) throw new Error('Expected a pending lesson task')

    const body = nextTask.taskType === 'recognize_meaning'
      ? { taskType: 'recognize_meaning', response: 'known' }
      : {
          taskType: 'multiple_choice',
          answer: nextTask.prompt.meaning.replace(/^meaning-/u, 'word-'),
        }

    await readSuccess(
      await app.fetch(
        request(`/api/app/lessons/${sessionId}/tasks/${nextTask.id}/answer`, {
          method: 'POST',
          origin: ORIGIN,
          cookie,
          body,
        }),
      ),
    )
  }

  throw new Error('Lesson did not become completable within 20 answers')
}

const completeCurrentLesson = async (
  app: WorkerApp,
  courseId: string,
  cookie: string,
): Promise<string> => {
  const lesson = await readSuccess<{ session: { id: string } }>(
    await app.fetch(
      request(`/api/app/courses/${courseId}/lessons/start`, {
        method: 'POST',
        origin: ORIGIN,
        cookie,
        body: {},
      }),
    ),
  )
  await answerUntilLessonIsCompletable(app, lesson.session.id, cookie)
  await readSuccess(
    await app.fetch(
      request(`/api/app/lessons/${lesson.session.id}/complete`, {
        method: 'POST',
        origin: ORIGIN,
        cookie,
        body: {},
      }),
    ),
  )
  return lesson.session.id
}

const answerReplayUntilComplete = async (
  app: WorkerApp,
  replaySessionId: string,
  cookie: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const replay = await readSuccess<{
      session: { completedTaskCount: number; taskCount: number }
      tasks: Array<{
        id: string
        status: 'pending' | 'completed' | 'skipped'
        taskType: 'recognize_meaning' | 'multiple_choice'
        prompt: { meaning?: string }
      }>
    }>(
      await app.fetch(
        request(`/api/app/lesson-replays/${replaySessionId}`, { cookie }),
      ),
    )
    if (replay.session.completedTaskCount === replay.session.taskCount) return
    const task = replay.tasks.find((candidate) => candidate.status === 'pending')
    if (!task) throw new Error('Expected a pending replay task')
    const body = task.taskType === 'recognize_meaning'
      ? { taskType: 'recognize_meaning', response: 'known' }
      : {
          taskType: 'multiple_choice',
          answer: task.prompt.meaning?.replace(/^meaning-/u, 'word-') ?? 'word-1',
        }
    await readSuccess(
      await app.fetch(
        request(
          `/api/app/lesson-replays/${replaySessionId}/tasks/${task.id}/answer`,
          { method: 'POST', origin: ORIGIN, cookie, body },
        ),
      ),
    )
  }
  throw new Error('Replay did not complete within 30 answers')
}
