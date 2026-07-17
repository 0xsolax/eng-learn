import { describe, expect, it, vi } from 'vitest'
import { createWorkerApp } from '../../server/app'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import type {
  CourseRepository,
  UserWordStateRecord,
} from '../../server/repositories/courseRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseQueryService } from '../../server/services/CourseQueryService'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import type { CourseStatus } from '../../shared/domain/course'

const NOW = new Date('2026-07-13T00:00:00.000Z')

describe('course availability', () => {
  it('does not schedule suspended due words when no new group remains', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 4)) {
      if (task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain recognition tasks')
      }

      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await fixture.runtime.completeLesson(lesson.session.id)
    fixture.suspendAllWords()

    await expect(fixture.runtime.startLesson(created.course.id)).rejects.toMatchObject({
      code: 'course_unavailable',
    })
  })

  it('excludes suspended due words from the course-home review count', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 4)) {
      if (task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain recognition tasks')
      }

      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await fixture.runtime.completeLesson(lesson.session.id)
    fixture.suspendAllWords()

    await expect(
      fixture.queries.getCourseHome({
        learnerId: created.learner.id,
        courseId: created.course.id,
      }),
    ).resolves.toMatchObject({ newWordCount: 0, reviewWordCount: 0 })
  })

  it('fast-forwards past suspended due words to the next active due lesson', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const firstLesson = await fixture.runtime.startLesson(created.course.id)

    for (const task of firstLesson.tasks.slice(0, 4)) {
      if (task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain recognition tasks')
      }

      await fixture.runtime.submitAnswer({
        sessionId: firstLesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await fixture.runtime.completeLesson(firstLesson.session.id)
    fixture.useFastForwardSchedule()
    const nextLesson = await fixture.runtime.startLesson(created.course.id)

    expect(nextLesson.session.lessonNo).toBe(4)
    expect(nextLesson.tasks).toHaveLength(1)
  })

  it('uses only active word states when resolving the next lesson after completion', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 4)) {
      if (task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain recognition tasks')
      }

      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    fixture.useNextActionSchedule()
    await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
      course: { currentLessonNo: 4 },
    })
  })

  it.each(['paused', 'completed'] as const)(
    'does not fast-forward the lesson number when the course becomes %s at the repository boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const firstLesson = await fixture.runtime.startLesson(created.course.id)

      for (const task of firstLesson.tasks.slice(0, 4)) {
        if (task.taskType !== 'recognize_meaning') {
          throw new Error('Expected lesson one to contain recognition tasks')
        }

        await fixture.runtime.submitAnswer({
          sessionId: firstLesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        })
      }

      await fixture.runtime.completeLesson(firstLesson.session.id)
      fixture.useFastForwardSchedule()
      fixture.raceNextWrite('advanceCourseLessonNo', status)

      await expect(fixture.runtime.startLesson(created.course.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 2,
        status,
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'rejects lesson start when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.setCourseStatus(status)

      await expect(fixture.runtime.startLesson(created.course.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'rejects course-home reads when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.setCourseStatus(status)

      await expect(
        fixture.queries.getCourseHome({
          learnerId: created.learner.id,
          courseId: created.course.id,
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'rejects started-lesson reads when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)
      fixture.setCourseStatus(status)

      await expect(fixture.runtime.getLesson(lesson.session.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not establish a learner session when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.setCourseStatus(status)

      await expect(
        fixture.sessions.exchangeAccessCode(created.learner.accessCode),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      expect(fixture.createSession).not.toHaveBeenCalled()
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not establish a learner session when the course becomes %s at the session insert boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.raceNextWrite('createSession', status)

      await expect(
        fixture.sessions.exchangeAccessCode(created.learner.accessCode),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      await expect(fixture.sessions.resolve('a'.repeat(64))).resolves.toEqual({
        status: 'invalid',
      })
      expect(fixture.createSession).toHaveBeenCalledOnce()
    },
  )

  it.each(['paused', 'completed'] as const)(
    'rejects the legacy access-code runtime entry when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.setCourseStatus(status)

      await expect(
        fixture.runtime.enterCourseByAccessCode(created.learner.accessCode),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
    },
  )

  it('maps an inactive-course exchange to a stable 409 response without a cookie', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    fixture.setCourseStatus('paused')

    const response = await fixture.app.fetch(
      new Request('https://eng-learn.test/api/app/session/by-code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://eng-learn.test',
        },
        body: JSON.stringify({ accessCode: created.learner.accessCode }),
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'course_unavailable' },
    })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(fixture.createSession).not.toHaveBeenCalled()
  })

  it.each(['paused', 'completed'] as const)(
    'does not restore a learner cookie when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const exchanged = await fixture.app.fetch(
        new Request('https://eng-learn.test/api/app/session/by-code', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://eng-learn.test',
          },
          body: JSON.stringify({ accessCode: created.learner.accessCode }),
        }),
      )
      const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]

      if (!cookie) throw new Error('Expected learner session cookie')
      fixture.setCourseStatus(status)

      const restored = await fixture.app.fetch(
        new Request('https://eng-learn.test/api/app/session', {
          headers: { cookie },
        }),
      )
      expect(restored.status).toBe(409)
      await expect(restored.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'course_unavailable' },
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not create a lesson when the course becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      fixture.raceNextWrite('createLesson', status)

      await expect(fixture.runtime.startLesson(created.course.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })
      await expect(
        fixture.repository.getStartedLesson(created.course.id, 1),
      ).resolves.toBeUndefined()
      await expect(fixture.repository.getWordStates(created.course.id)).resolves.toEqual([])
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 1,
        status,
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not save a preview when the course becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.seedSentenceOutputLesson(created.course.id)
      const task = lesson.tasks[0]

      if (!task) throw new Error('Expected a sentence-output task')
      fixture.raceNextWrite('saveSentenceOutputPreview', status)

      await expect(
        fixture.runtime.previewSentenceOutput({
          sessionId: lesson.session.id,
          taskId: task.id,
          preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })
      await expect(
        fixture.repository.getLessonTask(lesson.session.id, task.id),
      ).resolves.not.toHaveProperty('draftAnswer')
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 1,
        status,
      })
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not save a preview when the lesson becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.seedSentenceOutputLesson(created.course.id)
      const task = lesson.tasks[0]

      if (!task) throw new Error('Expected a sentence-output task')
      const before = await fixture.repository.getLessonTask(lesson.session.id, task.id)
      fixture.raceNextSessionClose('saveSentenceOutputPreview', status)

      await expect(
        fixture.runtime.previewSentenceOutput({
          sessionId: lesson.session.id,
          taskId: task.id,
          preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      await expect(
        fixture.repository.getLessonTask(lesson.session.id, task.id),
      ).resolves.toEqual(before)
      await expect(fixture.repository.getLessonSession(lesson.session.id)).resolves.toMatchObject({
        status,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not record an answer when the course becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)
      const task = lesson.tasks[0]

      if (!task || task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain a recognition task')
      }

      fixture.raceNextWrite('recordAnswer', status)
      await expect(
        fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })

      await expect(
        fixture.repository.getSubmittedAnswer(lesson.session.id, task.id),
      ).resolves.toBeUndefined()
      await expect(
        fixture.repository.getLessonTask(lesson.session.id, task.id),
      ).resolves.toMatchObject({ status: 'pending' })
      await expect(
        fixture.repository.getWordState(created.course.id, task.wordId),
      ).resolves.toMatchObject({ stage: 'S0', totalAttemptCount: 0 })
      await expect(
        fixture.repository.getLessonSession(lesson.session.id),
      ).resolves.toMatchObject({ completedTaskCount: 0, correctCount: 0, wrongCount: 0 })
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 1,
        status,
      })
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not record an answer when the lesson becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)
      const task = lesson.tasks[0]

      if (!task || task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain a recognition task')
      }

      fixture.raceNextSessionClose('recordAnswer', status)
      await expect(
        fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })

      await expect(
        fixture.repository.getSubmittedAnswer(lesson.session.id, task.id),
      ).resolves.toBeUndefined()
      await expect(
        fixture.repository.getLessonTask(lesson.session.id, task.id),
      ).resolves.toMatchObject({ status: 'pending' })
      await expect(
        fixture.repository.getWordState(created.course.id, task.wordId),
      ).resolves.toMatchObject({ stage: 'S0', totalAttemptCount: 0 })
      await expect(
        fixture.repository.getLessonSession(lesson.session.id),
      ).resolves.toMatchObject({
        status,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not complete a lesson when the course becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)

      for (const task of lesson.tasks.slice(0, 4)) {
        if (task.taskType !== 'recognize_meaning') {
          throw new Error('Expected lesson one to contain recognition tasks')
        }

        await fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        })
      }

      const before = await fixture.repository.getLessonReportSnapshot({
        sessionId: lesson.session.id,
        courseId: created.course.id,
      })
      fixture.raceNextWrite('completeLesson', status)

      await expect(fixture.runtime.completeLesson(lesson.session.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })
      await expect(
        fixture.repository.getLessonReportSnapshot({
          sessionId: lesson.session.id,
          courseId: created.course.id,
        }),
      ).resolves.toEqual(before)
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 1,
        status,
      })
    },
  )

  it.each(['completed', 'abandoned'] as const)(
    'does not complete a lesson when it becomes %s at the repository write boundary',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)

      for (const task of lesson.tasks.slice(0, 4)) {
        if (task.taskType !== 'recognize_meaning') {
          throw new Error('Expected lesson one to contain recognition tasks')
        }

        await fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        })
      }

      const before = await fixture.repository.getLessonReportSnapshot({
        sessionId: lesson.session.id,
        courseId: created.course.id,
      })
      fixture.raceNextSessionClose('completeLesson', status)

      await expect(fixture.runtime.completeLesson(lesson.session.id)).rejects.toMatchObject({
        code: 'lesson_not_active',
      })
      await expect(
        fixture.repository.getLessonReportSnapshot({
          sessionId: lesson.session.id,
          courseId: created.course.id,
        }),
      ).resolves.toEqual(
        before && {
          ...before,
          session: { ...before.session, status },
        },
      )
      await expect(fixture.repository.getCourse(created.course.id)).resolves.toMatchObject({
        currentLessonNo: 1,
        status: 'active',
      })
    },
  )

  it('returns lesson_not_active when completing an abandoned lesson', async () => {
    const fixture = await createAvailabilityFixture()
    const created = await fixture.runtime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: fixture.versionId,
    })
    const lesson = await fixture.runtime.startLesson(created.course.id)
    fixture.setLessonSessionStatus('abandoned')

    await expect(fixture.runtime.completeLesson(lesson.session.id)).rejects.toMatchObject({
      code: 'lesson_not_active',
    })
  })

  it.each(['paused', 'completed'] as const)(
    'does not submit an answer when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)
      const task = lesson.tasks[0]

      if (!task || task.taskType !== 'recognize_meaning') {
        throw new Error('Expected lesson one to contain a recognition task')
      }

      fixture.setCourseStatus(status)
      await expect(
        fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })

      fixture.setCourseStatus('active')
      const restored = await fixture.runtime.getLesson(lesson.session.id)
      expect(restored.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
        id: task.id,
        status: 'pending',
      })
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not persist a sentence preview when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const seeded = await fixture.seedSentenceOutputLesson(created.course.id)
      fixture.setCourseStatus(status)

      await expect(
        fixture.runtime.previewSentenceOutput({
          sessionId: seeded.session.id,
          taskId: seeded.tasks[0]?.id ?? 'missing-task',
          preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
        }),
      ).rejects.toMatchObject({ code: 'course_unavailable' })

      fixture.setCourseStatus('active')
      const restored = await fixture.runtime.getLesson(seeded.session.id)
      expect(restored.tasks[0]).not.toHaveProperty('preview')
    },
  )

  it.each(['paused', 'completed'] as const)(
    'does not complete a lesson when the course is %s',
    async (status) => {
      const fixture = await createAvailabilityFixture()
      const created = await fixture.runtime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: fixture.versionId,
      })
      const lesson = await fixture.runtime.startLesson(created.course.id)

      for (const task of lesson.tasks.slice(0, 4)) {
        if (task.taskType !== 'recognize_meaning') {
          throw new Error('Expected lesson one to contain recognition tasks')
        }

        await fixture.runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: 'recognize_meaning', response: 'known' },
        })
      }

      fixture.setCourseStatus(status)
      await expect(fixture.runtime.completeLesson(lesson.session.id)).rejects.toMatchObject({
        code: 'course_unavailable',
      })

      fixture.setCourseStatus('active')
      await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
        course: { currentLessonNo: 2 },
        session: { status: 'completed' },
      })
    },
  )
})

const createAvailabilityFixture = async () => {
  const contentRepository = createInMemoryContentRepository()
  const baseCourseRepository = createInMemoryCourseRepository()
  let projectWordStates = (states: UserWordStateRecord[]): UserWordStateRecord[] => states
  let storedCourse: Parameters<CourseRepository['createCourse']>[0]['course'] | undefined
  let storedSession: Awaited<ReturnType<CourseRepository['getLessonSession']>>
  let pendingRace:
    | {
        method:
          | 'advanceCourseLessonNo'
          | 'createSession'
          | 'createLesson'
          | 'saveSentenceOutputPreview'
          | 'recordAnswer'
          | 'completeLesson'
        status: Exclude<CourseStatus, 'active'>
      }
    | undefined
  const triggerRace = (method: NonNullable<typeof pendingRace>['method']): void => {
    if (!pendingRace || pendingRace.method !== method) return

    if (!storedCourse) {
      throw new Error('Course has not been created')
    }

    storedCourse.status = pendingRace.status
    pendingRace = undefined
  }
  let pendingSessionRace:
    | {
        method: 'saveSentenceOutputPreview' | 'recordAnswer' | 'completeLesson'
        status: 'completed' | 'abandoned'
      }
    | undefined
  const triggerSessionRace = (
    method: NonNullable<typeof pendingSessionRace>['method'],
  ): void => {
    if (!pendingSessionRace || pendingSessionRace.method !== method) return

    if (!storedSession) throw new Error('Lesson session has not been created')

    storedSession.status = pendingSessionRace.status
    pendingSessionRace = undefined
  }
  const courseRepository: CourseRepository = {
    ...baseCourseRepository,
    async createCourse(input) {
      storedCourse = input.course
      return baseCourseRepository.createCourse(input)
    },
    async advanceCourseLessonNo(input) {
      triggerRace('advanceCourseLessonNo')
      const advanced = await baseCourseRepository.advanceCourseLessonNo(input)
      storedCourse = advanced
      return advanced
    },
    async createLesson(input) {
      triggerRace('createLesson')
      const lesson = await baseCourseRepository.createLesson(input)
      storedSession = await baseCourseRepository.getLessonSession(lesson.session.id)
      return lesson
    },
    async saveSentenceOutputPreview(input) {
      triggerRace('saveSentenceOutputPreview')
      triggerSessionRace('saveSentenceOutputPreview')
      return baseCourseRepository.saveSentenceOutputPreview(input)
    },
    async recordAnswer(input) {
      triggerRace('recordAnswer')
      triggerSessionRace('recordAnswer')
      const recorded = await baseCourseRepository.recordAnswer(input)
      storedSession = await baseCourseRepository.getLessonSession(input.task.sessionId)
      return recorded
    },
    async completeLesson(input) {
      triggerRace('completeLesson')
      triggerSessionRace('completeLesson')
      const completed = await baseCourseRepository.completeLesson(input)
      storedSession = await baseCourseRepository.getLessonSession(input.sessionId)
      storedCourse = await baseCourseRepository.getCourse(
        completed?.course.id ?? storedCourse?.id ?? '',
      )
      return completed
    },
    async getWordStates(courseId) {
      const states = await baseCourseRepository.getWordStates(courseId)

      return projectWordStates(states)
    },
  }
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const imported = await builder.importWords({
    sourceName: 'Course availability source',
    words: Array.from({ length: 5 }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)}.`,
      exampleSentenceExtended: `I can use word-${String(index + 1)} every day.`,
    })),
  })
  await builder.buildExerciseItems(imported.versionId)
  const items = await builder.listExerciseItems(imported.versionId)
  await builder.approveExerciseItems(items.map((item) => item.id))
  await builder.publishVersion(imported.versionId)
  const baseSessionRepository = createInMemorySessionRepository({
    credentialPort: baseCourseRepository,
  })
  const sessionRepository = {
    ...baseSessionRepository,
    async create(session: Parameters<typeof baseSessionRepository.create>[0]) {
      triggerRace('createSession')
      return baseSessionRepository.create(session)
    },
  }
  const createSession = vi.spyOn(sessionRepository, 'create')
  const runtime = createCourseRuntime({
    contentRepository,
    courseRepository,
    now: () => NOW,
    selectRefluxGap: () => 5,
    queueWriteMode: 'legacy_v1',
  })
  const queries = createCourseQueryService({ contentRepository, courseRepository })
  const sessions = createLearnerSessionService({
    courseRepository,
    sessionRepository,
    now: () => NOW,
    generateToken: () => 'a'.repeat(64),
  })

  return {
    versionId: imported.versionId,
    runtime,
    queries,
    sessions,
    repository: baseCourseRepository,
    app: createWorkerApp({
      contentBuilder: builder,
      courseRuntime: runtime,
      courseQueryService: queries,
      courseRepository,
      learnerSessionService: sessions,
      adminAuthentication: { allowedOrigin: 'https://eng-learn.test' },
    }),
    createSession,
    suspendAllWords() {
      projectWordStates = (states) =>
        states.map((state) => ({ ...state, status: 'suspended' }))
    },
    useFastForwardSchedule() {
      projectWordStates = (states) =>
        states.map((state, index) =>
          index === 0
            ? { ...state, status: 'reviewing', nextDueLessonNo: 4 }
            : { ...state, status: 'suspended', nextDueLessonNo: 2 },
        )
    },
    useNextActionSchedule() {
      projectWordStates = (states) =>
        states.map((state, index) =>
          index === 0
            ? { ...state, status: 'suspended', nextDueLessonNo: 2 }
            : { ...state, status: 'reviewing', nextDueLessonNo: 4 },
        )
    },
    setCourseStatus(status: CourseStatus) {
      if (!storedCourse) {
        throw new Error('Course has not been created')
      }

      storedCourse.status = status
    },
    raceNextWrite(
      method: NonNullable<typeof pendingRace>['method'],
      status: Exclude<CourseStatus, 'active'>,
    ) {
      pendingRace = { method, status }
    },
    raceNextSessionClose(
      method: NonNullable<typeof pendingSessionRace>['method'],
      status: NonNullable<typeof pendingSessionRace>['status'],
    ) {
      pendingSessionRace = { method, status }
    },
    setLessonSessionStatus(status: 'completed' | 'abandoned') {
      if (!storedSession) throw new Error('Lesson session has not been created')
      storedSession.status = status
    },
    async seedSentenceOutputLesson(courseId: string) {
      const session = {
          id: 'session-s5',
          courseId,
          lessonNo: 1,
          status: 'started',
          taskCount: 1,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: NOW.toISOString(),
        } as const
      storedSession = session

      return baseCourseRepository.createLesson({
        session,
        tasks: [
          {
            id: 'task-s5',
            sessionId: 'session-s5',
            courseId,
            wordId: 'word-s5',
            stage: 'S5',
            taskType: 'sentence_output',
            prompt: { meaning: '我吃了一个苹果。', instruction: '写一个英文句子' },
            answer: { referenceSentence: 'I ate an apple.' },
            orderIndex: 1,
            status: 'pending',
            role: 'primary',
            required: false,
            createdAt: NOW.toISOString(),
          },
        ],
        wordStates: [
          {
            id: 'state-s5',
            courseId,
            wordId: 'word-s5',
            groupId: 'group-s5',
            stage: 'S5',
            totalAttemptCount: 5,
            totalCorrectCount: 5,
            totalWrongCount: 0,
            currentStreak: 5,
            wrongStreak: 0,
            lapseCount: 0,
            easeFactor: 1,
            masteryScore: 75,
            firstLessonNo: 1,
            nextDueLessonNo: 1,
            status: 'reviewing',
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ],
      })
    },
  }
}
