import { describe, expect, it } from 'vitest'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import type { CreateCourseInput } from '../../server/repositories/courseRepository'

const createCourseInput = (): CreateCourseInput => ({
  learner: {
    id: 'learner-1',
    name: 'Alice',
    accessCode: 'ABCDEFGH23',
    createdAt: '2026-07-13T00:00:00.000Z',
  },
  course: {
    id: 'course-1',
    learnerId: 'learner-1',
    sourceVersionId: 'version-1',
    currentLessonNo: 1,
    status: 'active',
    createdAt: '2026-07-13T00:00:00.000Z',
  },
})

describe('course repository authentication boundary', () => {
  it('retrieves a newly created course by raw access code without exposing the credential', async () => {
    const repository = createInMemoryCourseRepository()

    await repository.createCourse(createCourseInput())

    const identity = await repository.getCourseIdentityByAccessCode('abcdefgh23')

    expect(identity).toEqual({
      learner: {
        id: 'learner-1',
        name: 'Alice',
      },
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
        status: 'active',
      },
    })
    expect(identity?.learner).not.toHaveProperty('accessCode')
  })

  it('returns course, session, and task only inside the asserted learner resource chain', async () => {
    const repository = createInMemoryCourseRepository()
    await repository.createCourse(createCourseInput())
    await repository.createLesson({
      session: {
        id: 'session-1',
        courseId: 'course-1',
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
        startedAt: '2026-07-13T00:00:00.000Z',
      },
      tasks: [
        {
          id: 'task-1',
          sessionId: 'session-1',
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          prompt: { word: 'hello', meaning: '你好', exampleSentence: '' },
          answer: { word: 'hello', expectedResponse: 'known' },
          orderIndex: 1,
          status: 'pending',
          role: 'primary',
          required: false,
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      ],
      wordStates: [],
    })

    await expect(
      repository.getCourseForLearner({ courseId: 'course-1', learnerId: 'learner-1' }),
    ).resolves.toMatchObject({ id: 'course-1' })
    await expect(
      repository.getCourseForLearner({ courseId: 'course-1', learnerId: 'learner-other' }),
    ).resolves.toBeUndefined()
    await expect(
      repository.getLessonSessionForCourse({ sessionId: 'session-1', courseId: 'course-1' }),
    ).resolves.toMatchObject({ id: 'session-1' })
    await expect(
      repository.getLessonSessionForCourse({ sessionId: 'session-1', courseId: 'course-other' }),
    ).resolves.toBeUndefined()
    await expect(
      repository.getLessonTaskForResource({
        taskId: 'task-1',
        sessionId: 'session-1',
        courseId: 'course-1',
      }),
    ).resolves.toMatchObject({ id: 'task-1' })
    await expect(
      repository.getLessonTaskForResource({
        taskId: 'task-1',
        sessionId: 'session-1',
        courseId: 'course-other',
      }),
    ).resolves.toBeUndefined()
  })
})
