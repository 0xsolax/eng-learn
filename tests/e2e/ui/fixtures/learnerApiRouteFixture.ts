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
