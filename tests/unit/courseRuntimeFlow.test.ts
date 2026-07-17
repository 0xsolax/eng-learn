import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import type { LessonTaskRecord, UserWordStateRecord } from '../../server/repositories/courseRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const NOW = new Date('2026-07-18T00:00:00.000Z')

describe('course runtime rolling lesson flow', () => {
  it('adds the first approved S1 reinforcement after two completed tasks', async () => {
    const fixture = await createRollingFixture()
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    expect(lesson.tasks).toHaveLength(5)

    for (const task of lesson.tasks.slice(0, 2)) {
      await fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: task.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      })
    }

    const thirdTask = lesson.tasks[2]

    if (!thirdTask) throw new Error('Expected the third primary task')

    const [firstSubmit, concurrentRetry] = await Promise.all([
      fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: thirdTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      }),
      fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: thirdTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      }),
    ])

    expect(concurrentRetry.reviewLog.id).toBe(firstSubmit.reviewLog.id)

    const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const firstPrimary = lesson.tasks[0]
    const reinforcement = snapshot?.tasks.find(
      (task) => task.reinforcementSourceTaskId === firstPrimary?.id,
    )

    expect(snapshot?.session.flowPolicyVersion).toBe(
      'v2_rolling_reinforcement_budget24',
    )
    expect(snapshot?.tasks).toHaveLength(6)
    expect(reinforcement).toMatchObject({
      wordId: firstPrimary?.wordId,
      stage: 'S1',
      taskType: 'multiple_choice',
      role: 'bridge',
      required: true,
      orderIndex: 4,
      status: 'pending',
    })
    expect(reinforcement?.prompt).not.toEqual(firstPrimary?.prompt)
  })

  it('rejects a new group before writing a lesson when approved S1 content is missing', async () => {
    const fixture = await createRollingFixture()
    const source = await fixture.contentRepository.getSourceVersion(fixture.versionId)

    if (!source) throw new Error('Expected the published source snapshot')

    const missingS1ContentRepository = {
      ...fixture.contentRepository,
      getSourceVersion: (versionId: string) =>
        Promise.resolve(
          versionId === fixture.versionId
            ? {
                ...source,
                exerciseItems: source.exerciseItems.filter((item) => item.stage !== 'S1'),
              }
            : undefined,
        ),
    }
    const runtime = createCourseRuntime({
      contentRepository: missingS1ContentRepository,
      courseRepository: fixture.courseRepository,
      now: () => NOW,
      queueWriteMode: 'v2',
      flowWriteMode: 'rolling_v2',
    })

    await expect(runtime.startLesson(fixture.courseId)).rejects.toMatchObject({
      code: 'course_unavailable',
    })
    await expect(fixture.courseRepository.getStartedLesson(fixture.courseId, 1)).resolves.toBeUndefined()
    await expect(fixture.courseRepository.getWordStates(fixture.courseId)).resolves.toEqual([])
  })

  it('does not advance StageEngine when a planned S1 reinforcement passes', async () => {
    const fixture = await createRollingFixture()
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 3)) {
      await submitStoredPassingAnswer(fixture, lesson.session.id, task.id)
    }

    const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const reinforcement = snapshot?.tasks.find(
      (task) => task.reinforcementSourceTaskId !== undefined,
    )

    if (!reinforcement) throw new Error('Expected a planned reinforcement')

    const before = await fixture.courseRepository.getWordState(
      fixture.courseId,
      reinforcement.wordId,
    )
    await submitStoredPassingAnswer(fixture, lesson.session.id, reinforcement.id)
    const after = await fixture.courseRepository.getWordState(
      fixture.courseId,
      reinforcement.wordId,
    )

    expect(after).toEqual(before)
    expect(after).toMatchObject({
      stage: 'S1',
      totalAttemptCount: 1,
      totalCorrectCount: 1,
      totalWrongCount: 0,
      currentStreak: 1,
      wrongStreak: 0,
      nextDueLessonNo: 2,
    })
  })

  it('queues a planned S1 mistake without changing mastery counters', async () => {
    const fixture = await createRollingFixture()
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 3)) {
      await submitStoredPassingAnswer(fixture, lesson.session.id, task.id)
    }

    const beforeSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const reinforcement = beforeSnapshot?.tasks.find(
      (task) => task.reinforcementSourceTaskId !== undefined,
    )

    if (!reinforcement || reinforcement.taskType !== 'multiple_choice') {
      throw new Error('Expected a planned multiple-choice reinforcement')
    }

    const before = await fixture.courseRepository.getWordState(
      fixture.courseId,
      reinforcement.wordId,
    )
    await fixture.runtime.submitAnswer({
      sessionId: lesson.session.id,
      taskId: reinforcement.id,
      submission: { taskType: 'multiple_choice', answer: '__wrong__' },
    })
    const after = await fixture.courseRepository.getWordState(
      fixture.courseId,
      reinforcement.wordId,
    )
    const afterSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const reviewLog = afterSnapshot?.reviewLogs.find(
      (log) => log.taskId === reinforcement.id,
    )
    const recurrence = afterSnapshot?.tasks.find(
      (task) => task.refluxSourceTaskId === reinforcement.id,
    )

    expect(after).toMatchObject({
      stage: before?.stage,
      totalAttemptCount: before?.totalAttemptCount,
      totalCorrectCount: before?.totalCorrectCount,
      totalWrongCount: before?.totalWrongCount,
      currentStreak: before?.currentStreak,
      wrongStreak: before?.wrongStreak,
      nextDueLessonNo: 2,
    })
    expect(reviewLog).toMatchObject({
      score: 0,
      queueDisposition: 'scheduled',
    })
    expect(recurrence).toMatchObject({
      wordId: reinforcement.wordId,
      role: 'reflux',
      required: true,
      status: 'pending',
    })
  })

  it('skips planned reinforcement when a wrong-answer filler already repeated the word', async () => {
    const fixture = await createRollingFixture()
    const source = await fixture.contentRepository.getSourceVersion(fixture.versionId)

    if (!source) throw new Error('Expected the rolling source snapshot')

    const wordById = new Map(source.words.map((word) => [word.id, word.word]))
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) break

      const shouldBeWrong =
        current.role === 'primary' &&
        ['word-1', 'word-4'].includes(wordById.get(current.wordId) ?? '')

      if (shouldBeWrong) {
        await submitStoredWrongAnswer(fixture, lesson.session.id, current.id)
      } else {
        await submitStoredPassingAnswer(fixture, lesson.session.id, current.id)
      }
    }

    const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const wordTwoPrimary = snapshot?.tasks.find(
      (task) => task.role === 'primary' && wordById.get(task.wordId) === 'word-2',
    )

    if (!wordTwoPrimary) throw new Error('Expected the word-two primary task')

    const laterWordTwoTasks = snapshot?.tasks.filter(
      (task) =>
        task.wordId === wordTwoPrimary.wordId &&
        task.orderIndex > wordTwoPrimary.orderIndex,
    ) ?? []

    expect(laterWordTwoTasks).not.toHaveLength(0)
    expect(
      laterWordTwoTasks.some(
        (task) => task.reinforcementSourceTaskId === wordTwoPrimary.id,
      ),
    ).toBe(false)
    await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
      session: { status: 'completed' },
    })
  })

  it('completes L1 with three 2/3/4-gap reinforcements and starts L2 with ten primaries', async () => {
    const fixture = await createRollingFixture(10)
    const firstLesson = await fixture.runtime.startLesson(fixture.courseId)

    await answerAllPassing(fixture, firstLesson.session.id)

    const firstSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: firstLesson.session.id,
      courseId: fixture.courseId,
    })
    const planned = firstSnapshot?.tasks.filter(
      (task) => task.reinforcementSourceTaskId !== undefined,
    ) ?? []
    const source = await fixture.contentRepository.getSourceVersion(fixture.versionId)

    if (!source) throw new Error('Expected the rolling source snapshot')

    const wordById = new Map(source.words.map((word) => [word.id, word.word]))

    expect(firstSnapshot?.tasks).toHaveLength(8)
    expect(planned).toHaveLength(3)
    expect(
      firstSnapshot?.tasks.map(
        (task) => `${wordById.get(task.wordId) ?? task.wordId}:${task.stage}`,
      ),
    ).toEqual([
      'word-1:S0',
      'word-2:S0',
      'word-3:S0',
      'word-1:S1',
      'word-4:S0',
      'word-2:S1',
      'word-5:S0',
      'word-3:S1',
    ])
    expect(planned.map((task) => {
      const source = firstSnapshot?.tasks.find(
        (candidate) => candidate.id === task.reinforcementSourceTaskId,
      )

      return task.orderIndex - (source?.orderIndex ?? 0) - 1
    })).toEqual([2, 3, 4])

    const firstStates = await fixture.courseRepository.getWordStates(fixture.courseId)
    expect(firstStates).toHaveLength(5)
    expect(firstStates.every((state) => state.stage === 'S1')).toBe(true)
    expect(firstStates.every((state) => state.totalAttemptCount === 1)).toBe(true)

    await fixture.runtime.completeLesson(firstLesson.session.id)
    const secondLesson = await fixture.runtime.startLesson(fixture.courseId)
    const secondStates = await fixture.courseRepository.getWordStates(fixture.courseId)
    const secondStatesByWordId = new Map(secondStates.map((state) => [state.wordId, state]))

    expect(secondLesson.session.lessonNo).toBe(2)
    expect(secondLesson.tasks).toHaveLength(10)
    expect(secondLesson.tasks.map((task) =>
      secondStatesByWordId.get(task.wordId)?.firstLessonNo === 2 ? 'new' : 'due',
    )).toEqual(['due', 'new', 'due', 'new', 'due', 'new', 'due', 'new', 'due', 'new'])

    await answerAllPassing(fixture, secondLesson.session.id)
    const secondSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: secondLesson.session.id,
      courseId: fixture.courseId,
    })

    expect(secondSnapshot?.tasks).toHaveLength(13)
    expect(
      secondSnapshot?.tasks.filter(
        (task) => task.reinforcementSourceTaskId !== undefined,
      ),
    ).toHaveLength(3)
  })

  it('persists a hard-budget defer at 24 tasks and still completes finitely', async () => {
    const fixture = await createRollingFixture(20)
    await seedReviewPressure(fixture, 10)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    expect(lesson.session.lessonNo).toBe(2)
    expect(lesson.tasks).toHaveLength(15)

    let budgetLog: NonNullable<Awaited<ReturnType<
      typeof fixture.courseRepository.getLessonQueueSnapshot
    >>>['reviewLogs'][number] | undefined

    for (let attempt = 0; attempt < 40 && !budgetLog; attempt += 1) {
      const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) throw new Error('Expected a pending pressure task')

      await submitStoredWrongAnswer(fixture, lesson.session.id, current.id)
      const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
        sessionId: lesson.session.id,
        courseId: fixture.courseId,
      })

      budgetLog = snapshot?.reviewLogs.find(
        (log) => log.queueCapacityReason === 'lesson_task_budget',
      )
    }

    if (!budgetLog) throw new Error('Expected a persisted hard-budget defer')

    const cappedSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const cappedTask = cappedSnapshot?.tasks.find((task) => task.id === budgetLog.taskId)
    const cappedState = cappedTask
      ? await fixture.courseRepository.getWordState(fixture.courseId, cappedTask.wordId)
      : undefined

    expect(cappedSnapshot?.tasks).toHaveLength(24)
    expect(cappedSnapshot?.reviewLogs.filter((log) => log.taskId === budgetLog.taskId))
      .toHaveLength(1)
    expect(budgetLog).toMatchObject({
      queueDisposition: 'deferred_capacity',
      queueCapacityReason: 'lesson_task_budget',
    })
    expect(cappedState?.nextDueLessonNo).toBe(3)

    await answerAllPassing(fixture, lesson.session.id)
    await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
      session: { status: 'completed', taskCount: 24 },
    })
  })
})

const createRollingFixture = async (wordCount = 5) => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const source = await builder.importNewSourceIdempotently({
    operationToken: generateAdminOperationToken(),
    sourceName: 'Rolling flow source',
    words: Array.from({ length: wordCount }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)} here.`,
      exampleSentenceExtended: `I can use word-${String(index + 1)} here every day.`,
    })),
  })

  await builder.buildExerciseItems(source.versionId)
  const items = await builder.listExerciseItems(source.versionId)
  await builder.approveExerciseItems(items.map((item) => item.id))
  await builder.publishVersion(source.versionId)

  const runtime = createCourseRuntime({
    contentRepository,
    courseRepository,
    now: () => NOW,
    queueWriteMode: 'v2',
    flowWriteMode: 'rolling_v2',
  })
  const created = await runtime.createCourse({
    learnerName: 'Alice',
    sourceVersionId: source.versionId,
  })

  return {
    runtime,
    contentRepository,
    courseRepository,
    courseId: created.course.id,
    versionId: source.versionId,
  }
}

const answerAllPassing = async (
  fixture: Awaited<ReturnType<typeof createRollingFixture>>,
  sessionId: string,
): Promise<void> => {
  for (;;) {
    const lesson = await fixture.runtime.getLesson(sessionId)
    const current = lesson.tasks.find((task) => task.status === 'pending')

    if (!current) return

    await submitStoredPassingAnswer(fixture, sessionId, current.id)
  }
}

const submitStoredPassingAnswer = async (
  fixture: Awaited<ReturnType<typeof createRollingFixture>>,
  sessionId: string,
  taskId: string,
): Promise<void> => {
  const task = await fixture.courseRepository.getLessonTask(sessionId, taskId)

  if (!task) throw new Error(`Task ${taskId} is missing`)

  await submitPassingAnswer(fixture, task)
}

const submitPassingAnswer = async (
  fixture: Awaited<ReturnType<typeof createRollingFixture>>,
  task: LessonTaskRecord,
): Promise<void> => {
  if (task.taskType === 'recognize_meaning') {
    await fixture.runtime.submitAnswer({
      sessionId: task.sessionId,
      taskId: task.id,
      submission: { taskType: 'recognize_meaning', response: 'known' },
    })
    return
  }

  if (task.taskType === 'multiple_choice') {
    await fixture.runtime.submitAnswer({
      sessionId: task.sessionId,
      taskId: task.id,
      submission: { taskType: 'multiple_choice', answer: task.answer.word },
    })
    return
  }

  if (task.taskType === 'recall_word') {
    await fixture.runtime.submitAnswer({
      sessionId: task.sessionId,
      taskId: task.id,
      submission: { taskType: 'recall_word', answer: task.answer.word },
    })
    return
  }

  throw new Error(`Unexpected rolling-flow task type ${task.taskType}`)
}

const submitStoredWrongAnswer = async (
  fixture: Awaited<ReturnType<typeof createRollingFixture>>,
  sessionId: string,
  taskId: string,
): Promise<void> => {
  const task = await fixture.courseRepository.getLessonTask(sessionId, taskId)

  if (!task) throw new Error(`Task ${taskId} is missing`)

  if (task.taskType === 'recognize_meaning') {
    await fixture.runtime.submitAnswer({
      sessionId,
      taskId,
      submission: { taskType: 'recognize_meaning', response: 'learning' },
    })
    return
  }

  if (task.taskType === 'multiple_choice') {
    await fixture.runtime.submitAnswer({
      sessionId,
      taskId,
      submission: { taskType: 'multiple_choice', answer: '__wrong__' },
    })
    return
  }

  if (task.taskType === 'recall_word') {
    await fixture.runtime.submitAnswer({
      sessionId,
      taskId,
      submission: { taskType: 'recall_word', answer: '__wrong__' },
    })
    return
  }

  throw new Error(`Unexpected pressure-task type ${task.taskType}`)
}

const seedReviewPressure = async (
  fixture: Awaited<ReturnType<typeof createRollingFixture>>,
  dueWordCount: number,
): Promise<void> => {
  const source = await fixture.contentRepository.getSourceVersion(fixture.versionId)

  if (!source) throw new Error('Expected the rolling source snapshot')

  const states = source.words.slice(0, dueWordCount).map<UserWordStateRecord>(
    (word, index) => {
      const group = source.groups.find(
        (candidate) =>
          word.orderIndex >= candidate.startOrderIndex &&
          word.orderIndex <= candidate.endOrderIndex,
      )

      if (!group) throw new Error(`Expected a group for ${word.id}`)

      return {
        id: `pressure-state-${String(index + 1)}`,
        courseId: fixture.courseId,
        wordId: word.id,
        groupId: group.id,
        stage: 'S1',
        totalAttemptCount: 1,
        totalCorrectCount: 1,
        totalWrongCount: 0,
        currentStreak: 1,
        wrongStreak: 0,
        lapseCount: 0,
        easeFactor: 1,
        masteryScore: 12,
        firstLessonNo: 1,
        lastSeenLessonNo: 1,
        nextDueLessonNo: 2,
        status: 'learning',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }
    },
  )

  await fixture.courseRepository.createLesson({
    session: {
      id: 'pressure-history',
      courseId: fixture.courseId,
      lessonNo: 1,
      status: 'completed',
      taskCount: 0,
      completedTaskCount: 0,
      correctCount: 0,
      wrongCount: 0,
      queuePolicyVersion: 'v2_3_6_cap3',
      flowPolicyVersion: 'v2_rolling_reinforcement_budget24',
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    },
    tasks: [],
    wordStates: states,
  })
  const advanced = await fixture.courseRepository.advanceCourseLessonNo({
    courseId: fixture.courseId,
    expectedLessonNo: 1,
    nextLessonNo: 2,
  })

  if (advanced?.currentLessonNo !== 2) {
    throw new Error('Expected the pressure course to advance to lesson two')
  }
}
