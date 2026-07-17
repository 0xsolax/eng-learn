import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import {
  createCourseRuntime,
  parseLessonFlowWriteMode,
  parseLessonQueueWriteMode,
  type CourseRuntime,
} from '../../server/services/CourseRuntime'
import type { SourceVersionSnapshot } from '../../server/repositories/contentRepository'
import { exerciseItemContentSchema } from '../../shared/api/taskSchemas'
import type { ImportWordInput } from '../../shared/domain/content'
import type { StartedLesson } from '../../shared/domain/course'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const wordNumber = index + 1
    const label = String(wordNumber)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      examplePhrase: `word-${label}`,
      exampleSentence: `I use word-${label}.`,
      exampleSentenceExtended: `I can use word-${label} every day.`,
    }
  })

describe('course runtime workflow', () => {
  it.each([
    { configured: undefined, expected: 'disabled' },
    { configured: '', expected: 'disabled' },
    { configured: 'unexpected', expected: 'disabled' },
    { configured: 'legacy_v1', expected: 'legacy_v1' },
    { configured: 'v2', expected: 'v2' },
    { configured: 'disabled', expected: 'disabled' },
  ] as const)(
    'parses queue write mode "$configured" as $expected',
    ({ configured, expected }) => {
      expect(parseLessonQueueWriteMode(configured)).toBe(expected)
    },
  )

  it.each([
    { configured: undefined, expected: 'disabled' },
    { configured: '', expected: 'disabled' },
    { configured: 'unexpected', expected: 'disabled' },
    { configured: 'legacy_v1', expected: 'legacy_v1' },
    { configured: 'rolling_v2', expected: 'rolling_v2' },
    { configured: 'disabled', expected: 'disabled' },
  ] as const)(
    'parses flow write mode "$configured" as $expected',
    ({ configured, expected }) => {
      expect(parseLessonFlowWriteMode(configured)).toBe(expected)
    },
  )

  it('persists the selected v2 queue policy on a new lesson session', async () => {
    const fixture = await createQueueModeFixture()
    const lesson = await fixture.createRuntime('v2').startLesson(fixture.courseId)

    await expect(
      fixture.courseRepository.getLessonSession(lesson.session.id),
    ).resolves.toMatchObject({ queuePolicyVersion: 'v2_3_6_cap3' })
  })

  it('persists rolling flow only with queue v2 and fails closed otherwise', async () => {
    const rolling = await createQueueModeFixture()
    const lesson = await rolling
      .createRuntime('v2', 'rolling_v2')
      .startLesson(rolling.courseId)

    await expect(
      rolling.courseRepository.getLessonSession(lesson.session.id),
    ).resolves.toMatchObject({
      queuePolicyVersion: 'v2_3_6_cap3',
      flowPolicyVersion: 'v2_rolling_reinforcement_budget24',
    })

    const mismatch = await createQueueModeFixture()
    await expect(
      mismatch.createRuntime('legacy_v1', 'rolling_v2').startLesson(mismatch.courseId),
    ).rejects.toMatchObject({ code: 'course_unavailable' })
    await expect(
      mismatch.courseRepository.getStartedLesson(mismatch.courseId, 1),
    ).resolves.toBeUndefined()
  })

  it('blocks new flow sessions when disabled but resumes a persisted rolling session', async () => {
    const blocked = await createQueueModeFixture()
    await expect(
      blocked.createRuntime('v2', 'disabled').startLesson(blocked.courseId),
    ).rejects.toMatchObject({ code: 'course_unavailable' })

    const resumable = await createQueueModeFixture()
    const started = await resumable
      .createRuntime('v2', 'rolling_v2')
      .startLesson(resumable.courseId)
    const resumed = await resumable
      .createRuntime('v2', 'disabled')
      .startLesson(resumable.courseId)

    expect(resumed).toEqual(started)
  })

  it('rejects a new lesson in disabled mode without creating a session', async () => {
    const fixture = await createQueueModeFixture()

    await expect(
      fixture.createRuntime('disabled').startLesson(fixture.courseId),
    ).rejects.toMatchObject({ code: 'course_unavailable' })
    await expect(
      fixture.courseRepository.getStartedLesson(fixture.courseId, 1),
    ).resolves.toBeUndefined()
  })

  it('resumes an existing v2 lesson even after write mode is disabled', async () => {
    const fixture = await createQueueModeFixture()
    const started = await fixture.createRuntime('v2').startLesson(fixture.courseId)
    const resumed = await fixture.createRuntime('disabled').startLesson(fixture.courseId)

    expect(resumed).toEqual(started)
    await expect(
      fixture.courseRepository.getLessonSession(started.session.id),
    ).resolves.toMatchObject({ queuePolicyVersion: 'v2_3_6_cap3' })
  })

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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Course source',
      words: createWords(10),
    })

    await expect(
      courseRuntime.createCourse({
        learnerName: 'Alice',
        sourceVersionId: draft.versionId,
      }),
    ).rejects.toThrow('Courses can only bind published source versions')

    await buildApproveAndPublish(contentBuilder, draft.versionId)

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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Lesson source',
      words: createWords(10),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

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

  it('returns one lesson snapshot when start is double-submitted concurrently', async () => {
    const contentRepository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository: contentRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const courseRuntime = createCourseRuntime({
      contentRepository,
      courseRepository: createInMemoryCourseRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Concurrent lesson source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const [firstStart, secondStart] = await Promise.all([
      courseRuntime.startLesson(created.course.id),
      courseRuntime.startLesson(created.course.id),
    ])

    expect(secondStart).toEqual(firstStart)
    expect(secondStart.session.id).toBe(firstStart.session.id)
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Answer source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

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
      submission: { taskType: 'recognize_meaning', response: 'known' },
    })
    const secondSubmit = await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Wrong answer source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)
    const firstTask = getRequiredTask(lesson.tasks, 0)
    const submitted = await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
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
      userAnswer: JSON.stringify({ taskType: 'recognize_meaning', response: 'learning' }),
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Wrong word reflux source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)
    const wrongTask = getRequiredTask(lesson.tasks, 0)

    await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: wrongTask.id,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })

    for (const task of lesson.tasks.slice(1, 4)) {
      await courseRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await expect(courseRuntime.completeLesson(lesson.session.id)).rejects.toMatchObject({
      code: 'lesson_incomplete',
    })

    const resumedLesson = await courseRuntime.startLesson(created.course.id)
    const refluxTask = resumedLesson.tasks.find((task) => task.role === 'reflux')

    expect(resumedLesson.tasks.length).toBeGreaterThanOrEqual(7)
    expect(resumedLesson.tasks.length).toBeLessThanOrEqual(10)
    expect(refluxTask).toMatchObject({
      wordId: wrongTask.wordId,
      status: 'pending',
    })
    expect(refluxTask?.orderIndex).toBeGreaterThanOrEqual(7)
    expect(refluxTask?.orderIndex).toBeLessThanOrEqual(10)

    if (!refluxTask) {
      throw new Error('Expected a reflux task')
    }

    let currentTask = (await courseRuntime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.status === 'pending',
    )
    while (currentTask && currentTask.id !== refluxTask.id) {
      await courseRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: currentTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
      currentTask = (await courseRuntime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )
    }

    await courseRuntime.submitAnswer({
      sessionId: resumedLesson.session.id,
      taskId: refluxTask.id,
      submission: { taskType: 'recognize_meaning', response: 'known' },
    })

    const completed = await courseRuntime.completeLesson(lesson.session.id)

    expect(completed.course.currentLessonNo).toBe(2)
    expect(completed.session).toMatchObject({
      taskCount: resumedLesson.tasks.length,
      completedTaskCount: resumedLesson.tasks.length,
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Completion source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lesson = await courseRuntime.startLesson(created.course.id)

    for (const task of lesson.tasks.slice(0, 3)) {
      await courseRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    await expect(courseRuntime.completeLesson(lesson.session.id)).rejects.toMatchObject({
      code: 'lesson_incomplete',
    })

    await courseRuntime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: getRequiredTask(lesson.tasks, 3).id,
      submission: { taskType: 'recognize_meaning', response: 'known' },
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Lesson two source',
      words: createWords(10),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lessonOne = await courseRuntime.startLesson(created.course.id)

    for (const task of lessonOne.tasks) {
      await courseRuntime.submitAnswer({
        sessionId: lessonOne.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
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

  it('skips a lesson-number gap instead of persisting an empty lesson', async () => {
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Lesson gap source',
      words: createWords(5),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const lessonOne = await courseRuntime.startLesson(created.course.id)

    for (const task of lessonOne.tasks) {
      await courseRuntime.submitAnswer({
        sessionId: lessonOne.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }
    await courseRuntime.completeLesson(lessonOne.session.id)

    const lessonTwo = await courseRuntime.startLesson(created.course.id)

    for (const [index, task] of lessonTwo.tasks.entries()) {
      await courseRuntime.submitAnswer({
        sessionId: lessonTwo.session.id,
        taskId: task.id,
        submission: { taskType: 'multiple_choice', answer: `word-${String(index + 1)}` },
      })
    }
    const lessonTwoCompletion = await courseRuntime.completeLesson(lessonTwo.session.id)

    const nextLesson = await courseRuntime.startLesson(created.course.id)
    const advancedCourse = await courseRepository.getCourse(created.course.id)

    expect(lessonTwoCompletion.course.currentLessonNo).toBe(4)
    expect(nextLesson.session.lessonNo).toBe(4)
    expect(nextLesson.tasks).toHaveLength(5)
    expect(nextLesson.tasks.every((task) => task.stage === 'S2')).toBe(true)
    expect(advancedCourse?.currentLessonNo).toBe(4)
  })

  it('keeps a twenty-word course moving after every source group is activated', async () => {
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
      queueWriteMode: 'legacy_v1',
      flowWriteMode: 'legacy_v1',
    })
    const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Twenty-word lesson gap source',
      words: createWords(20),
    })

    await buildApproveAndPublish(contentBuilder, draft.versionId)
    const sourceVersion = await contentRepository.getSourceVersion(draft.versionId)

    if (!sourceVersion) {
      throw new Error('Expected the published source-version snapshot')
    }

    const created = await courseRuntime.createCourse({
      learnerName: 'Alice',
      sourceVersionId: draft.versionId,
    })
    const startedLessonNos: number[] = []

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const lesson = await courseRuntime.startLesson(created.course.id)
      startedLessonNos.push(lesson.session.lessonNo)
      expect(lesson.tasks.length).toBeGreaterThan(0)

      await submitSnapshotCorrectAnswers(courseRuntime, sourceVersion, lesson)
      await courseRuntime.completeLesson(lesson.session.id)

      if (lesson.session.lessonNo >= 12) break
    }

    expect(startedLessonNos).toContain(12)
    expect(startedLessonNos).not.toContain(11)
    await expect(
      courseRepository.getStartedLesson(created.course.id, 11),
    ).resolves.toBeUndefined()
  })
})

const createQueueModeFixture = async () => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const now = () => new Date('2026-07-14T00:00:00.000Z')
  const contentBuilder = createContentBuilder({ repository: contentRepository, now })
  const draft = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
    sourceName: 'Queue policy source',
    words: createWords(5),
  })

  await buildApproveAndPublish(contentBuilder, draft.versionId)

  const createRuntime = (
    queueWriteMode: 'legacy_v1' | 'v2' | 'disabled',
    flowWriteMode: 'legacy_v1' | 'rolling_v2' | 'disabled' = 'legacy_v1',
  ) =>
    createCourseRuntime({
      contentRepository,
      courseRepository,
      now,
      queueWriteMode,
      flowWriteMode,
    })
  const created = await createRuntime('v2').createCourse({
    learnerName: 'Alice',
    sourceVersionId: draft.versionId,
  })

  return {
    courseId: created.course.id,
    courseRepository,
    createRuntime,
  }
}

const getRequiredTask = <T>(tasks: T[], index: number): T => {
  const task = tasks[index]

  if (!task) {
    throw new Error(`Expected lesson task at index ${String(index)}`)
  }

  return task
}

const submitSnapshotCorrectAnswers = async (
  runtime: CourseRuntime,
  sourceVersion: SourceVersionSnapshot,
  lesson: StartedLesson,
): Promise<void> => {
  for (const task of lesson.tasks) {
    const record = sourceVersion.exerciseItems.find(
      (candidate) =>
        candidate.wordId === task.wordId &&
        candidate.stage === task.stage &&
        candidate.status === 'approved',
    )

    if (!record) {
      throw new Error(`Expected approved content for ${task.wordId}/${task.stage}`)
    }

    const content = exerciseItemContentSchema.parse({
      stage: record.stage,
      taskType: record.taskType,
      prompt: record.prompt,
      answer: record.answer,
    })

    switch (content.taskType) {
      case 'recognize_meaning':
        await runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: content.taskType, response: 'known' },
        })
        break
      case 'recall_word':
      case 'multiple_choice':
      case 'fill_blank':
        await runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: content.taskType, answer: content.answer.word },
        })
        break
      case 'sentence_build':
        await runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: content.taskType, pieceIds: content.answer.pieceIds },
        })
        break
      case 'sentence_output': {
        const draft = content.answer.referenceSentence
        await runtime.previewSentenceOutput({
          sessionId: lesson.session.id,
          taskId: task.id,
          preview: { taskType: content.taskType, draft },
        })
        await runtime.submitAnswer({
          sessionId: lesson.session.id,
          taskId: task.id,
          submission: { taskType: content.taskType, draft, selfScore: 3 },
        })
        break
      }
    }
  }
}

const buildApproveAndPublish = async (
  contentBuilder: ReturnType<typeof createContentBuilder>,
  sourceVersionId: string,
): Promise<void> => {
  await contentBuilder.buildExerciseItems(sourceVersionId)

  const items = await contentBuilder.listExerciseItems(sourceVersionId)

  await contentBuilder.approveExerciseItems(items.map((item) => item.id))
  await contentBuilder.publishVersion(sourceVersionId)
}
