import { describe, expect, it } from 'vitest'
import { createTestWorkerApp } from '../../server/app'
import type {
  BuildCoverage,
  ExerciseItemView,
  ImportedSourceVersion,
  PublishedSourceVersion,
} from '../../shared/domain/content'
import type { CompletedLesson, CreatedCourse, StartedLesson } from '../../shared/domain/course'
import type { TaskAnswerFeedback } from '../../shared/api/taskSchemas'
import type { ImportWordInput } from '../../shared/domain/content'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const ADMIN_TOKEN = 'test-admin-token'

type ApiSuccess<T> = {
  ok: true
  data: T
}

type ApiFailure = {
  ok: false
  error: {
    code: string
    message: string
  }
}

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const label = String(index + 1)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      examplePhrase: `word-${label}`,
      exampleSentence: `I use word-${label}.`,
      exampleSentenceExtended: `I can use word-${label} every day.`,
    }
  })

const postJson = (
  path: string,
  body: unknown,
  input: { adminToken?: string; cookie?: string; origin?: string } = {},
): Request =>
  new Request(`https://eng-learn.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.adminToken ? { 'x-admin-token': input.adminToken } : {}),
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    body: JSON.stringify(body),
  })

const get = (path: string, adminToken?: string): Request =>
  new Request(`https://eng-learn.test${path}`, {
    headers: adminToken ? { 'x-admin-token': adminToken } : {},
  })

const readSuccess = async <T>(response: Response): Promise<T> => {
  expect(response.status).toBe(200)

  const body = await response.json<ApiSuccess<T>>()
  expect(body.ok).toBe(true)

  return body.data
}

const readFailure = async (response: Response): Promise<ApiFailure> => {
  const body = await response.json<ApiFailure>()
  expect(body.ok).toBe(false)

  return body
}

describe('worker api workflow', () => {
  it('runs the admin build and learner lesson loop through HTTP routes', async () => {
    const app = createTestWorkerApp({ adminToken: ADMIN_TOKEN })

    const imported = await readSuccess<ImportedSourceVersion>(
      await app.fetch(
        postJson('/api/admin/source-versions/import', {
          mode: 'new_source',
          operationToken: generateAdminOperationToken(),
          sourceName: 'HTTP source',
          words: createWords(10),
        }, { adminToken: ADMIN_TOKEN }),
      ),
    )

    expect(imported).toMatchObject({
      status: 'draft',
      wordCount: 10,
      groupCount: 2,
    })

    const coverage = await readSuccess<BuildCoverage>(
      await app.fetch(
        postJson(`/api/admin/source-versions/${imported.versionId}/build`, {}, {
          adminToken: ADMIN_TOKEN,
        }),
      ),
    )

    expect(coverage).toMatchObject({
      sourceVersionId: imported.versionId,
      readyToPublish: false,
    })
    expect(coverage.missingItems.every((item) => item.reason === 'exercise_item_draft')).toBe(true)

    const exercises = await readSuccess<ExerciseItemView[]>(
      await app.fetch(
        get(`/api/admin/source-versions/${imported.versionId}/exercises`, ADMIN_TOKEN),
      ),
    )
    await readSuccess(
      await app.fetch(
        postJson('/api/admin/exercise-items/batch-approve', {
          itemIds: exercises.map((item) => item.id),
        }, { adminToken: ADMIN_TOKEN }),
      ),
    )

    const published = await readSuccess<PublishedSourceVersion>(
      await app.fetch(
        postJson(`/api/admin/source-versions/${imported.versionId}/publish`, {}, {
          adminToken: ADMIN_TOKEN,
        }),
      ),
    )

    expect(published).toEqual({
      sourceVersionId: imported.versionId,
      status: 'published',
    })

    const createdCourse = await readSuccess<CreatedCourse>(
      await app.fetch(
        postJson('/api/admin/courses', {
          operationToken: generateAdminOperationToken(),
          learnerName: 'Alice',
          loginAccount: 'alice01',
          pin: '123456',
          sourceVersionId: imported.versionId,
        }, { adminToken: ADMIN_TOKEN }),
      ),
    )
    const exchangeResponse = await app.fetch(
        postJson('/api/app/session/by-account', {
          loginAccount: createdCourse.learner.loginAccount,
          pin: '123456',
        }, { origin: 'https://eng-learn.test' }),
    )
    const enteredCourse = await readSuccess<Omit<CreatedCourse, 'learner'> & {
      learner: { id: string; name: string }
    }>(exchangeResponse)
    const cookie = exchangeResponse.headers.get('set-cookie')?.split(';')[0]

    if (!cookie) throw new Error('Expected learner session cookie')
    const lesson = await readSuccess<StartedLesson>(
      await app.fetch(
        postJson(`/api/app/courses/${enteredCourse.course.id}/lessons/start`, {}, {
          origin: 'https://eng-learn.test',
          cookie,
        }),
      ),
    )

    expect(lesson.session).toMatchObject({
      courseId: enteredCourse.course.id,
      lessonNo: 1,
      taskCount: 5,
      status: 'started',
    })
    expect(lesson.tasks.map((task) => task.stage)).toEqual(['S0', 'S0', 'S0', 'S0', 'S0'])

    const firstTask = getRequiredTask(lesson.tasks, 0)
    expect(Object.prototype.hasOwnProperty.call(firstTask, 'answer')).toBe(false)
    const submitted = await readSuccess<{
      taskId: string
      score: 0 | 1 | 2 | 3
      correct: boolean
      feedback: TaskAnswerFeedback
    }>(
      await app.fetch(
        postJson(`/api/app/lessons/${lesson.session.id}/tasks/${firstTask.id}/answer`, {
          taskType: 'recognize_meaning',
          response: 'known',
        }, { origin: 'https://eng-learn.test', cookie }),
      ),
    )

    expect(submitted).toMatchObject({
      taskId: firstTask.id,
      score: 2,
      correct: true,
      feedback: { taskType: 'recognize_meaning', response: 'known' },
    })

    const completableLesson = await answerUntilLessonIsCompletable({
      app,
      cookie,
      sessionId: lesson.session.id,
    })

    expect(completableLesson.tasks).toHaveLength(7)
    expect(completableLesson.tasks.filter((task) => task.status === 'completed')).toHaveLength(6)

    const completed = await readSuccess<CompletedLesson>(
      await app.fetch(
        postJson(`/api/app/lessons/${lesson.session.id}/complete`, {}, {
          origin: 'https://eng-learn.test',
          cookie,
        }),
      ),
    )

    expect(completed.course.currentLessonNo).toBe(2)
    expect(completed.session).toMatchObject({
      status: 'completed',
      taskCount: 7,
      completedTaskCount: 6,
    })
  })

  it('rejects invalid admin payloads before calling services', async () => {
    const app = createTestWorkerApp({ adminToken: ADMIN_TOKEN })
    const response = await app.fetch(
      postJson('/api/admin/source-versions/import', {
        mode: 'new_source',
        operationToken: generateAdminOperationToken(),
        sourceName: '',
        words: [],
      }, { adminToken: ADMIN_TOKEN }),
    )
    const failure = await readFailure(response)

    expect(response.status).toBe(400)
    expect(failure.error.code).toBe('validation_error')
  })

  it('rejects admin mutations without the admin token', async () => {
    const app = createTestWorkerApp({ adminToken: ADMIN_TOKEN })
    const response = await app.fetch(
      postJson('/api/admin/source-versions/import', {
        mode: 'new_source',
        operationToken: generateAdminOperationToken(),
        sourceName: 'Blocked source',
        words: createWords(1),
      }),
    )
    const failure = await readFailure(response)

    expect(response.status).toBe(401)
    expect(failure.error.code).toBe('admin_session_required')
  })
})

const getRequiredTask = <T>(tasks: T[], index: number): T => {
  const task = tasks[index]

  if (!task) {
    throw new Error(`Expected task at index ${String(index)}`)
  }

  return task
}

const answerUntilLessonIsCompletable = async (input: {
  app: ReturnType<typeof createTestWorkerApp>
  cookie: string
  sessionId: string
}): Promise<StartedLesson> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lesson = await readSuccess<StartedLesson>(
      await input.app.fetch(
        new Request(`https://eng-learn.test/api/app/lessons/${input.sessionId}`, {
          headers: { cookie: input.cookie },
        }),
      ),
    )
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
      return lesson
    }

    const nextTask = lesson.tasks.find((task) => task.status === 'pending')

    if (!nextTask) throw new Error('Expected a pending lesson task')

    await readSuccess(
      await input.app.fetch(
        postJson(
          `/api/app/lessons/${input.sessionId}/tasks/${nextTask.id}/answer`,
          getCorrectSubmission(nextTask),
          { origin: 'https://eng-learn.test', cookie: input.cookie },
        ),
      ),
    )
  }

  throw new Error('Lesson did not become completable within 20 answers')
}

const getCorrectSubmission = (
  task: StartedLesson['tasks'][number],
): { taskType: 'recognize_meaning'; response: 'known' } | {
  taskType: 'multiple_choice'
  answer: string
} => {
  if (task.taskType === 'recognize_meaning') {
    return { taskType: 'recognize_meaning', response: 'known' }
  }

  if (task.taskType !== 'multiple_choice') {
    throw new Error(`Unexpected lesson-one task type: ${task.taskType}`)
  }

  return {
    taskType: 'multiple_choice',
    answer: task.prompt.meaning.replace(/^meaning-/u, 'word-'),
  }
}
