import type { Page, Route } from '@playwright/test'

// MOCKED ROUTE FIXTURE ONLY: this exercises production Vue routes and components,
// but every learner API response below is isolated from Worker, D1 and real cookies.
const fixtureHeader = { 'x-eng-learn-test-fixture': 'mocked-learner-route' }

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 7,
  status: 'active',
}

const pendingTask = {
  id: 'task-1',
  sessionId: 'session-7',
  courseId: 'course-1',
  wordId: 'word-1',
  orderIndex: 1,
  status: 'pending',
  role: 'primary',
  required: true,
  stage: 'S1',
  taskType: 'recall_word',
  prompt: { meaning: '苹果' },
}

const pendingLesson = {
  session: {
    id: 'session-7',
    courseId: 'course-1',
    lessonNo: 7,
    status: 'started',
    taskCount: 1,
    completedTaskCount: 0,
  },
  tasks: [pendingTask],
}

const answeredLesson = {
  session: { ...pendingLesson.session, completedTaskCount: 1 },
  tasks: [{ ...pendingTask, status: 'completed' }],
}

const fulfill = (route: Route, status: number, payload: unknown): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: fixtureHeader,
    body: JSON.stringify(payload),
  })

export const installMockedLearnerApiRouteFixture = async (page: Page): Promise<void> => {
  let lessonReadCount = 0

  await page.route('**/api/app/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`

    switch (key) {
      case 'GET /api/app/session':
        await fulfill(route, 401, {
          ok: false,
          error: {
            code: 'learner_session_required',
            message: 'Learner session is required',
          },
        })
        return
      case 'POST /api/app/session/by-code':
        await fulfill(route, 200, {
          ok: true,
          data: { learner: { id: 'learner-1', name: '小林' }, course },
        })
        return
      case 'GET /api/app/course':
        await fulfill(route, 200, {
          ok: true,
          data: {
            course,
            newWordCount: 1,
            reviewWordCount: 0,
            action: 'continue',
            startedSessionId: 'session-7',
            lessonPath: [
              { lessonNo: 6, status: 'completed' },
              { lessonNo: 7, status: 'current' },
              { lessonNo: 8, status: 'locked' },
            ],
          },
        })
        return
      case 'POST /api/app/courses/course-1/lessons/start':
        await fulfill(route, 200, { ok: true, data: pendingLesson })
        return
      case 'GET /api/app/lessons/session-7':
        lessonReadCount += 1
        await fulfill(route, 200, {
          ok: true,
          data: lessonReadCount === 1 ? pendingLesson : answeredLesson,
        })
        return
      case 'POST /api/app/lessons/session-7/tasks/task-1/answer':
        await fulfill(route, 200, {
          ok: true,
          data: {
            taskId: 'task-1',
            score: 3,
            correct: true,
            feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
          },
        })
        return
      case 'POST /api/app/lessons/session-7/complete':
        await fulfill(route, 200, {
          ok: true,
          data: {
            course: { ...course, currentLessonNo: 8 },
            session: { ...answeredLesson.session, status: 'completed' },
          },
        })
        return
      case 'GET /api/app/lessons/session-7/report':
        await fulfill(route, 200, {
          ok: true,
          data: {
            lessonNo: 7,
            completedTaskCount: 1,
            totalTaskCount: 1,
            correctRate: 1,
            needsPracticeWords: [],
            progressWords: [{ id: 'word-1', word: 'apple' }],
            nextLessonNo: 8,
            courseStatus: 'active',
          },
        })
        return
      default:
        await route.abort('failed')
    }
  })
}

const cappedWords = Array.from({ length: 5 }, (_, index) => ({
  id: `cap-word-${String(index + 1)}`,
  word: `cap-${String(index + 1)}`,
  meaning: `上限词义 ${String(index + 1)}`,
}))
const cappedTasks = Array.from({ length: 15 }, (_, index) => {
  const word = cappedWords[index % cappedWords.length]
  const occurrence = Math.floor(index / cappedWords.length)

  if (!word) throw new Error('Expected a capped lesson word')

  return {
    id: `cap-task-${String(index + 1)}`,
    sessionId: 'session-cap',
    courseId: course.id,
    wordId: word.id,
    orderIndex: index + 1,
    status: 'pending',
    role: occurrence === 0 ? 'primary' : 'reflux',
    required: occurrence > 0,
    ...(occurrence === 0
      ? {}
      : { refluxSourceTaskId: `cap-task-${String(index - cappedWords.length + 1)}` }),
    stage: 'S0',
    taskType: 'recognize_meaning',
    prompt: {
      word: word.word,
      meaning: word.meaning,
      exampleSentence: `I use ${word.word} here.`,
    },
  }
})

const cappedLessonAt = (completedTaskCount: number) => ({
  session: {
    id: 'session-cap',
    courseId: course.id,
    lessonNo: 7,
    status: 'started',
    taskCount: cappedTasks.length,
    completedTaskCount,
  },
  tasks: cappedTasks.map((task, index) => ({
    ...task,
    status: index < completedTaskCount ? 'completed' : 'pending',
  })),
})

export const installCappedWrongAnswerLearnerFixture = async (
  page: Page,
): Promise<{ wordSequence: string[]; practiceWords: string[] }> => {
  let completedTaskCount = 0
  let sessionEstablished = false

  await page.route('**/api/app/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    const answerMatch = url.pathname.match(
      /^\/api\/app\/lessons\/session-cap\/tasks\/(cap-task-\d+)\/answer$/u,
    )

    if (request.method() === 'POST' && answerMatch) {
      const task = cappedTasks[completedTaskCount]

      if (!task || answerMatch[1] !== task.id) {
        await fulfill(route, 409, {
          ok: false,
          error: { code: 'task_not_current', message: 'Only the current task can be answered' },
        })
        return
      }

      completedTaskCount += 1
      await fulfill(route, 200, {
        ok: true,
        data: {
          taskId: task.id,
          score: 0,
          correct: false,
          feedback: { taskType: 'recognize_meaning', response: 'learning' },
        },
      })
      return
    }

    switch (key) {
      case 'GET /api/app/session':
        await fulfill(
          route,
          sessionEstablished ? 200 : 401,
          sessionEstablished
            ? { ok: true, data: { learner: { id: 'learner-1', name: '小林' }, course } }
            : {
                ok: false,
                error: {
                  code: 'learner_session_required',
                  message: 'Learner session is required',
                },
              },
        )
        return
      case 'POST /api/app/session/by-code':
        sessionEstablished = true
        await fulfill(route, 200, {
          ok: true,
          data: { learner: { id: 'learner-1', name: '小林' }, course },
        })
        return
      case 'GET /api/app/course':
        await fulfill(route, 200, {
          ok: true,
          data: {
            course,
            newWordCount: 5,
            reviewWordCount: 0,
            action: 'continue',
            startedSessionId: 'session-cap',
            lessonPath: [
              { lessonNo: 6, status: 'completed' },
              { lessonNo: 7, status: 'current' },
              { lessonNo: 8, status: 'locked' },
            ],
          },
        })
        return
      case 'POST /api/app/courses/course-1/lessons/start':
      case 'GET /api/app/lessons/session-cap':
        await fulfill(route, 200, { ok: true, data: cappedLessonAt(completedTaskCount) })
        return
      case 'POST /api/app/lessons/session-cap/complete':
        if (completedTaskCount !== cappedTasks.length) {
          await fulfill(route, 409, {
            ok: false,
            error: { code: 'lesson_incomplete', message: 'Required tasks remain' },
          })
          return
        }
        await fulfill(route, 200, {
          ok: true,
          data: {
            course: { ...course, currentLessonNo: 8 },
            session: {
              ...cappedLessonAt(completedTaskCount).session,
              status: 'completed',
            },
          },
        })
        return
      case 'GET /api/app/lessons/session-cap/report':
        await fulfill(route, 200, {
          ok: true,
          data: {
            lessonNo: 7,
            completedTaskCount: cappedTasks.length,
            totalTaskCount: cappedTasks.length,
            correctRate: 0,
            needsPracticeWords: cappedWords.map(({ id, word }) => ({ id, word })),
            progressWords: [],
            nextLessonNo: 8,
            courseStatus: 'active',
          },
        })
        return
      default:
        await route.abort('failed')
    }
  })

  return {
    wordSequence: cappedTasks.map((task) => task.prompt.word),
    practiceWords: cappedWords.map((word) => word.word),
  }
}
