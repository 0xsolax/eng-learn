import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import type { ImportWordInput } from '../../shared/domain/content'

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const wordNumber = index + 1
    const label = String(wordNumber)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      exampleSentence: `I can use word ${label}.`,
    }
  })

describe('course runtime workflow', () => {
  it('creates courses only from published source versions', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Course source',
      words: createWords(10),
    })

    await expect(
      courseRuntime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: draft.versionId,
      }),
    ).rejects.toThrow('Courses can only bind published source versions')

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })

    expect(created.course).toMatchObject({
      learnerId: created.learner.id,
      sourceVersionId: draft.versionId,
      currentLessonNo: 1,
      status: 'active',
    })
    expect(created.learner.accessCode).toHaveLength(10)
  })

  it('starts lesson one with the first five S0 tasks and reuses the active session', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Lesson source',
      words: createWords(10),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const firstStart = await courseRuntime.startLesson(created.course.id)
    const secondStart = await courseRuntime.startLesson(created.course.id)

    expect(firstStart.session).toMatchObject({
      courseId: created.course.id,
      lessonNo: 1,
      status: 'started',
      taskCount: 5,
    })
    expect(firstStart.tasks).toHaveLength(5)
    expect(firstStart.tasks.every((task) => task.stage === 'S0')).toBe(true)
    expect(firstStart.tasks.map((task) => task.orderIndex)).toEqual([1, 2, 3, 4, 5])
    expect(secondStart).toEqual(firstStart)
  })

  it('submits an answer once and advances an S0 word by lesson number', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRepository = createInMemoryCourseRepository()
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Answer source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)
    const firstTask = lesson.tasks[0]

    if (!firstTask) {
      throw new Error('Expected lesson to include a first task')
    }

    const firstSubmit = await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      userAnswer: 'word-1',
    })
    const secondSubmit = await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      userAnswer: 'wrong-answer',
    })

    expect(firstSubmit.wordState).toMatchObject({
      courseId: created.course.id,
      wordId: firstTask.wordId,
      stage: 'S1',
      totalAttemptCount: 1,
      totalCorrectCount: 1,
      currentStreak: 1,
      nextDueLessonNo: 2,
    })
    expect(firstSubmit.reviewLog).toMatchObject({
      sessionId: lesson.session.id,
      courseId: created.course.id,
      wordId: firstTask.wordId,
      score: 2,
      lessonNo: 1,
    })
    expect(secondSubmit).toEqual(firstSubmit)
  })

  it('does not advance a word when the submitted answer does not match the task snapshot', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Wrong answer source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)
    const firstTask = getRequiredTask(lesson.tasks, 0)
    const submitted = await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      userAnswer: 'wrong-answer',
    })

    expect(submitted.wordState).toMatchObject({
      stage: 'S0',
      totalAttemptCount: 1,
      totalCorrectCount: 0,
      totalWrongCount: 1,
      nextDueLessonNo: 2,
    })
    expect(submitted.reviewLog).toMatchObject({
      score: 0,
      userAnswer: 'wrong-answer',
    })
  })

  it('requires wrong word reflux tasks before completing a lesson', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Wrong word reflux source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)
    const wrongTask = getRequiredTask(lesson.tasks, 0)

    await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: wrongTask.id,
      userAnswer: 'wrong-answer',
    })

    for (const task of lesson.tasks.slice(1, 4)) {
      await courseRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        userAnswer: `word-${String(task.orderIndex)}`,
      })
    }

    await expect(courseRuntime.completeLesson(lesson.session.id)).rejects.toThrow(
      'Lesson completion requires at least eighty percent completed tasks',
    )

    const resumedLesson = await courseRuntime.startLesson(created.course.id)
    const refluxTask = getRequiredTask(resumedLesson.tasks, 5)

    expect(resumedLesson.tasks).toHaveLength(6)
    expect(refluxTask).toMatchObject({
      wordId: wrongTask.wordId,
      status: 'pending',
      orderIndex: 6,
    })

    await courseRuntime.submitAnswer({
      sessionId: resumedLesson.session.id,
      taskId: refluxTask.id,
      userAnswer: 'word-1',
    })

    const completed = await courseRuntime.completeLesson(lesson.session.id)

    expect(completed.course.currentLessonNo).toBe(2)
    expect(completed.session).toMatchObject({
      taskCount: 6,
      completedTaskCount: 5,
      status: 'completed',
    })
  })

  it('advances the course only once after at least eighty percent of lesson tasks are completed', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Completion source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 3)) {
      await courseRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        userAnswer: `word-${String(task.orderIndex)}`,
      })
    }

    await expect(courseRuntime.completeLesson(lesson.session.id)).rejects.toThrow(
      'Lesson completion requires at least eighty percent completed tasks',
    )

    await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: getRequiredTask(lesson.tasks, 3).id,
      userAnswer: 'word-4',
    })

    const firstComplete = await courseRuntime.completeLesson(lesson.session.id)
    const secondComplete = await courseRuntime.completeLesson(lesson.session.id)

    expect(firstComplete.course.currentLessonNo).toBe(2)
    expect(firstComplete.session).toMatchObject({
      id: lesson.session.id,
      status: 'completed',
      completedTaskCount: 4,
    })
    expect(secondComplete).toEqual(firstComplete)
  })

  it('starts lesson two with due S1 review tasks and the next new S0 group', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Lesson two source',
      words: createWords(10),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lessonOne = await courseRuntime.startLesson(created.course.id)

    for (const task of lessonOne.tasks) {
      await courseRuntime.submitAnswer({
        sessionId: lessonOne.session.id,
        taskId: task.id,
        userAnswer: `word-${String(task.orderIndex)}`,
      })
    }

    await courseRuntime.completeLesson(lessonOne.session.id)

    const lessonTwo = await courseRuntime.startLesson(created.course.id)

    expect(lessonTwo.session).toMatchObject({
      courseId: created.course.id,
      lessonNo: 2,
      status: 'started',
      taskCount: 10,
    })
    expect(lessonTwo.tasks.map((task) => task.stage)).toEqual([
      'S1',
      'S1',
      'S1',
      'S1',
      'S1',
      'S0',
      'S0',
      'S0',
      'S0',
      'S0',
    ])
  })
})

const getRequiredTask = <T>(tasks: T[], index: number): T => {
  const task = tasks[index]

  if (!task) {
    throw new Error(`Expected lesson task at index ${String(index)}`)
  }

  return task
}
