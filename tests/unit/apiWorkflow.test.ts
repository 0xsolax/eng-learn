import { describe, expect, it } from 'vitest'
import { createTestWorkerApp } from '../../server/app'
import type { BuildCoverage, ImportedSourceVersion, PublishedSourceVersion } from '../../shared/domain/content'
import type { CompletedLesson, CreatedCourse, StartedLesson, SubmittedAnswer } from '../../shared/domain/course'
import type { ImportWordInput } from '../../shared/domain/content'

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
      exampleSentence: `I can use word ${label}.`,
    }
  })

const postJson = (path: string, body: unknown, adminToken?: string): Request =>
  new Request(`https://eng-learn.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    },
    body: JSON.stringify(body),
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
          sourceName: 'HTTP source',
          words: createWords(10),
        }, ADMIN_TOKEN),
      ),
    )

    expect(imported).toMatchObject({
      status: 'draft',
      wordCount: 10,
      groupCount: 2,
    })

    const coverage = await readSuccess<BuildCoverage>(
      await app.fetch(
        postJson(`/api/admin/source-versions/${imported.versionId}/build`, {}, ADMIN_TOKEN),
      ),
    )

    expect(coverage).toMatchObject({
      sourceVersionId: imported.versionId,
      readyToPublish: true,
      missingItems: [],
    })

    const published = await readSuccess<PublishedSourceVersion>(
      await app.fetch(
        postJson(`/api/admin/source-versions/${imported.versionId}/publish`, {}, ADMIN_TOKEN),
      ),
    )

    expect(published).toEqual({
      sourceVersionId: imported.versionId,
      status: 'published',
    })

    const createdCourse = await readSuccess<CreatedCourse>(
      await app.fetch(
        postJson('/api/admin/courses', {
          learnerName: 'Alice',
          sourceVersionId: imported.versionId,
        }, ADMIN_TOKEN),
      ),
    )
    const enteredCourse = await readSuccess<CreatedCourse>(
      await app.fetch(
        postJson('/api/app/session/by-code', {
          accessCode: createdCourse.learner.accessCode,
        }),
      ),
    )
    const lesson = await readSuccess<StartedLesson>(
      await app.fetch(
        postJson(`/api/app/courses/${enteredCourse.course.id}/lessons/start`, {}),
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
    const submitted = await readSuccess<SubmittedAnswer>(
      await app.fetch(
        postJson(`/api/app/lessons/${lesson.session.id}/tasks/${firstTask.id}/answer`, {
          userAnswer: 'word-1',
        }),
      ),
    )

    expect(submitted.wordState).toMatchObject({
      wordId: firstTask.wordId,
      stage: 'S1',
      nextDueLessonNo: 2,
    })

    for (const task of lesson.tasks.slice(1, 4)) {
      await readSuccess<SubmittedAnswer>(
        await app.fetch(
          postJson(`/api/app/lessons/${lesson.session.id}/tasks/${task.id}/answer`, {
            userAnswer: `word-${String(task.orderIndex)}`,
          }),
        ),
      )
    }

    const completed = await readSuccess<CompletedLesson>(
      await app.fetch(postJson(`/api/app/lessons/${lesson.session.id}/complete`, {})),
    )

    expect(completed.course.currentLessonNo).toBe(2)
    expect(completed.session).toMatchObject({
      status: 'completed',
      completedTaskCount: 4,
    })
  })

  it('rejects invalid admin payloads before calling services', async () => {
    const app = createTestWorkerApp({ adminToken: ADMIN_TOKEN })
    const response = await app.fetch(
      postJson('/api/admin/source-versions/import', {
        sourceName: '',
        words: [],
      }, ADMIN_TOKEN),
    )
    const failure = await readFailure(response)

    expect(response.status).toBe(400)
    expect(failure.error.code).toBe('bad_request')
  })

  it('rejects admin mutations without the admin token', async () => {
    const app = createTestWorkerApp({ adminToken: ADMIN_TOKEN })
    const response = await app.fetch(
      postJson('/api/admin/source-versions/import', {
        sourceName: 'Blocked source',
        words: createWords(1),
      }),
    )
    const failure = await readFailure(response)

    expect(response.status).toBe(401)
    expect(failure.error.code).toBe('unauthorized')
  })
})

const getRequiredTask = <T>(tasks: T[], index: number): T => {
  const task = tasks[index]

  if (!task) {
    throw new Error(`Expected task at index ${String(index)}`)
  }

  return task
}
