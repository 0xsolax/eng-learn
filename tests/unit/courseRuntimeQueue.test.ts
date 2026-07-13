import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createContentBuilder, type ContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { DomainError } from '../../server/errors/DomainError'

const NOW = new Date('2026-07-13T00:00:00.000Z')

describe('course runtime authoritative task queue', () => {
  it('allows answering only the first pending task', async () => {
    const fixture = await createFixture(5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const secondTask = requireTask(lesson.tasks, 1)

    await expect(
      fixture.runtime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: secondTask.id,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      }),
    ).rejects.toMatchObject({ code: 'task_not_current' })
  })

  it('inserts five required bridge tasks before reflux when the last primary answer is wrong', async () => {
    const fixture = await createFixture(5, 5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 4)) {
      await submitRecognize(fixture.runtime, lesson.session.id, task.id, 'known')
    }

    const lastPrimary = requireTask(lesson.tasks, 4)
    await submitRecognize(fixture.runtime, lesson.session.id, lastPrimary.id, 'learning')

    const resumed = await fixture.runtime.getLesson(lesson.session.id)
    const bridges = resumed.tasks.filter((task) => task.role === 'bridge')
    const reflux = resumed.tasks.find((task) => task.role === 'reflux')

    expect(bridges).toHaveLength(5)
    expect(bridges.every((task) => task.required)).toBe(true)
    expect(reflux).toMatchObject({
      orderIndex: 11,
      required: true,
      refluxSourceTaskId: lastPrimary.id,
    })
    expect((reflux?.orderIndex ?? 0) - lastPrimary.orderIndex - 1).toBe(5)

    const completionError: unknown = await fixture.runtime
      .completeLesson(lesson.session.id)
      .catch((error: unknown) => error)

    expect(completionError).toBeInstanceOf(DomainError)
    if (!(completionError instanceof DomainError)) {
      throw new Error('Expected a lesson completion domain error')
    }
    expect(completionError).toMatchObject({ code: 'lesson_incomplete' })
    expect(completionError.details).toEqual({
      completedPrimary: 5,
      totalPrimary: 5,
      pendingRequiredTaskIds: [
        ...bridges.map((task) => task.id),
        ...(reflux ? [reflux.id] : []),
      ],
    })
  })

  it('persists an eight-task reflux gap and does not advance mastery for bridge or reflux answers', async () => {
    const fixture = await createFixture(5, 8)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const firstPrimary = requireTask(lesson.tasks, 0)
    const wrong = await submitRecognize(
      fixture.runtime,
      lesson.session.id,
      firstPrimary.id,
      'learning',
    )

    const queued = await fixture.runtime.getLesson(lesson.session.id)
    const reflux = queued.tasks.find((task) => task.role === 'reflux')

    expect(reflux).toBeTruthy()
    expect((reflux?.orderIndex ?? 0) - firstPrimary.orderIndex - 1).toBe(8)

    let current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.status === 'pending',
    )
    while (current && current.id !== reflux?.id) {
      await submitRecognize(fixture.runtime, lesson.session.id, current.id, 'known')
      current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )
    }

    if (!reflux) {
      throw new Error('Expected a reflux task')
    }

    const refluxResult = await submitRecognize(
      fixture.runtime,
      lesson.session.id,
      reflux.id,
      'known',
    )

    expect(refluxResult.wordState).toMatchObject({
      id: wrong.wordState.id,
      stage: wrong.wordState.stage,
      totalAttemptCount: wrong.wordState.totalAttemptCount,
      totalWrongCount: wrong.wordState.totalWrongCount,
    })
  })

  it('persists every reflux within five to eight tasks after consecutive wrong answers', async () => {
    const gaps = [8, 5]
    const fixture = await createFixture(5, () => gaps.shift() ?? 5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const firstPrimary = requireTask(lesson.tasks, 0)
    const secondPrimary = requireTask(lesson.tasks, 1)

    await submitRecognize(fixture.runtime, lesson.session.id, firstPrimary.id, 'learning')
    await submitRecognize(fixture.runtime, lesson.session.id, secondPrimary.id, 'learning')

    const restored = await fixture.runtime.getLesson(lesson.session.id)

    for (const reflux of restored.tasks.filter((task) => task.role === 'reflux')) {
      const sourceIndex = restored.tasks.findIndex(
        (task) => task.id === reflux.refluxSourceTaskId,
      )
      const refluxIndex = restored.tasks.findIndex((task) => task.id === reflux.id)
      const interveningCount = refluxIndex - sourceIndex - 1

      expect(interveningCount).toBeGreaterThanOrEqual(5)
      expect(interveningCount).toBeLessThanOrEqual(8)
    }
  })

  it('persists an S5 draft before revealing the reference and requires that draft for self-score', async () => {
    const fixture = await createSentenceOutputFixture()
    const initial = await fixture.runtime.getLesson(fixture.sessionId)
    const task = requireTask(initial.tasks, 0)
    const initialState = await fixture.courseRepository.getWordState(
      fixture.courseId,
      fixture.wordId,
    )

    expect(task).not.toHaveProperty('preview')
    expect(JSON.stringify(task)).not.toContain('I ate an apple.')
    await expect(
      fixture.runtime.submitAnswer({
        sessionId: fixture.sessionId,
        taskId: task.id,
        submission: {
          taskType: 'sentence_output',
          draft: 'I eat an apple.',
          selfScore: 3,
        },
      }),
    ).rejects.toMatchObject({ code: 's5_preview_required' })

    const preview = await fixture.runtime.previewSentenceOutput({
      sessionId: fixture.sessionId,
      taskId: task.id,
      preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
    })
    const restored = await fixture.runtime.getLesson(fixture.sessionId)

    expect(preview).toMatchObject({
      taskId: task.id,
      draft: 'I eat an apple.',
      referenceSentence: 'I ate an apple.',
    })
    expect(restored.tasks[0]).toMatchObject({
      preview: {
        draft: preview.draft,
        referenceSentence: preview.referenceSentence,
        revealedAt: preview.revealedAt,
      },
    })
    await expect(
      fixture.courseRepository.getWordState(fixture.courseId, fixture.wordId),
    ).resolves.toEqual(initialState)
    await expect(
      fixture.courseRepository.getSubmittedAnswer(fixture.sessionId, task.id),
    ).resolves.toBeUndefined()
    await expect(
      fixture.runtime.submitAnswer({
        sessionId: fixture.sessionId,
        taskId: task.id,
        submission: {
          taskType: 'sentence_output',
          draft: 'I changed the draft.',
          selfScore: 3,
        },
      }),
    ).rejects.toMatchObject({ code: 's5_preview_required' })
    await expect(
      fixture.runtime.submitAnswer({
        sessionId: fixture.sessionId,
        taskId: task.id,
        submission: { taskType: 'recall_word', answer: 'apple' },
      }),
    ).rejects.toMatchObject({ code: 'task_type_mismatch' })

    const submitted = await fixture.runtime.submitAnswer({
      sessionId: fixture.sessionId,
      taskId: task.id,
      submission: {
        taskType: 'sentence_output',
        draft: 'I eat an apple.',
        selfScore: 3,
      },
    })

    expect(submitted.feedback).toEqual({
      taskType: 'sentence_output',
      referenceSentence: 'I ate an apple.',
      selfScore: 3,
    })
    expect(submitted.wordState.totalAttemptCount).toBe(
      (initialState?.totalAttemptCount ?? 0) + 1,
    )
  })

  it('requires reflux after an S5 self-score of one', async () => {
    const fixture = await createSentenceOutputFixture()
    const initial = await fixture.runtime.getLesson(fixture.sessionId)
    const task = requireTask(initial.tasks, 0)

    await fixture.runtime.previewSentenceOutput({
      sessionId: fixture.sessionId,
      taskId: task.id,
      preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
    })
    const submitted = await fixture.runtime.submitAnswer({
      sessionId: fixture.sessionId,
      taskId: task.id,
      submission: {
        taskType: 'sentence_output',
        draft: 'I eat an apple.',
        selfScore: 1,
      },
    })
    const restored = await fixture.runtime.getLesson(fixture.sessionId)

    expect(submitted.reviewLog.score).toBe(1)
    expect(restored.tasks.filter((candidate) => candidate.role === 'bridge')).toHaveLength(5)
    expect(restored.tasks.filter((candidate) => candidate.role === 'reflux')).toHaveLength(1)
    await expect(fixture.runtime.completeLesson(fixture.sessionId)).rejects.toMatchObject({
      code: 'lesson_incomplete',
    })
  })

  it.each(['completed', 'abandoned'] as const)(
    'rejects preview and answer writes for a %s lesson without changing state',
    async (sessionStatus) => {
      const fixture = await createSentenceOutputFixture(sessionStatus)
      const initialState = await fixture.courseRepository.getWordState(
        fixture.courseId,
        fixture.wordId,
      )

      await expect(
        fixture.runtime.previewSentenceOutput({
          sessionId: fixture.sessionId,
          taskId: 'task-s5',
          preview: { taskType: 'sentence_output', draft: 'I eat an apple.' },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })
      await expect(
        fixture.runtime.submitAnswer({
          sessionId: fixture.sessionId,
          taskId: 'task-s5',
          submission: {
            taskType: 'sentence_output',
            draft: 'I eat an apple.',
            selfScore: 3,
          },
        }),
      ).rejects.toMatchObject({ code: 'lesson_not_active' })

      await expect(
        fixture.courseRepository.getWordState(fixture.courseId, fixture.wordId),
      ).resolves.toEqual(initialState)
      await expect(
        fixture.courseRepository.getSubmittedAnswer(fixture.sessionId, 'task-s5'),
      ).resolves.toBeUndefined()
      const unchangedTask = await fixture.courseRepository.getLessonTaskForResource({
        sessionId: fixture.sessionId,
        courseId: fixture.courseId,
        taskId: 'task-s5',
      })

      expect(unchangedTask).toMatchObject({ status: 'pending' })
      expect(unchangedTask).not.toHaveProperty('draftAnswer')
      expect(unchangedTask).not.toHaveProperty('referenceRevealedAt')
    },
  )

  it('creates a new required reflux obligation when a reflux answer is wrong', async () => {
    const fixture = await createFixture(5, 5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const primary = requireTask(lesson.tasks, 0)
    const primaryResult = await submitRecognize(
      fixture.runtime,
      lesson.session.id,
      primary.id,
      'learning',
    )

    let current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.status === 'pending',
    )
    while (current && current.role !== 'reflux') {
      await submitRecognize(fixture.runtime, lesson.session.id, current.id, 'known')
      current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )
    }

    const firstReflux = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.role === 'reflux' && task.status === 'pending',
    )

    if (!firstReflux) {
      throw new Error('Expected the first reflux task')
    }

    const refluxResult = await submitRecognize(
      fixture.runtime,
      lesson.session.id,
      firstReflux.id,
      'learning',
    )
    const updated = await fixture.runtime.getLesson(lesson.session.id)
    const refluxTasks = updated.tasks.filter((task) => task.role === 'reflux')
    const nextReflux = refluxTasks.find((task) => task.status === 'pending')

    expect(refluxTasks).toHaveLength(2)
    expect(nextReflux).toMatchObject({
      required: true,
      refluxSourceTaskId: firstReflux.id,
    })
    expect(refluxResult.wordState).toMatchObject({
      totalAttemptCount: primaryResult.wordState.totalAttemptCount,
      totalWrongCount: primaryResult.wordState.totalWrongCount,
    })
  })

  it('records concurrent retries once and creates only one reflux obligation', async () => {
    const fixture = await createFixture(5, 5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const firstTask = requireTask(lesson.tasks, 0)
    const input = {
      sessionId: lesson.session.id,
      taskId: firstTask.id,
      submission: { taskType: 'recognize_meaning' as const, response: 'learning' as const },
    }
    const [first, second] = await Promise.all([
      fixture.runtime.submitAnswer(input),
      fixture.runtime.submitAnswer(input),
    ])
    const restored = await fixture.runtime.getLesson(lesson.session.id)

    expect(second).toEqual(first)
    expect(first.wordState.totalAttemptCount).toBe(1)
    expect(restored.tasks.filter((task) => task.role === 'reflux')).toHaveLength(1)
  })

  it('atomically skips the remaining primary after 80 percent completion and advances once', async () => {
    const fixture = await createFixture(5)
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 4)) {
      await submitRecognize(fixture.runtime, lesson.session.id, task.id, 'known')
    }

    const firstCompletion = await fixture.runtime.completeLesson(lesson.session.id)
    const secondCompletion = await fixture.runtime.completeLesson(lesson.session.id)
    const restored = await fixture.runtime.getLesson(lesson.session.id)

    expect(firstCompletion.course.currentLessonNo).toBe(2)
    expect(secondCompletion).toEqual(firstCompletion)
    expect(restored.tasks[4]).toMatchObject({ role: 'primary', status: 'skipped' })
  })
})

const createFixture = async (
  wordCount: number,
  refluxGap: number | (() => number) = 5,
) => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const draft = await builder.importWords({
    sourceName: 'Queue source',
    words: Array.from({ length: wordCount }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      exampleSentence: `I can use word-${String(index + 1)} here.`,
    })),
  })

  await builder.buildExerciseItems(draft.versionId)
  await approveAll(builder, draft.versionId)
  await builder.publishVersion(draft.versionId)

  const runtime = createCourseRuntime({
    contentRepository,
    courseRepository,
    now: () => NOW,
    selectRefluxGap: typeof refluxGap === 'function' ? refluxGap : () => refluxGap,
  })
  const created = await runtime.createCourse({
    learnerName: 'Alice',
    sourceVersionId: draft.versionId,
  })

  return { runtime, courseId: created.course.id }
}

const createSentenceOutputFixture = async (
  sessionStatus: 'started' | 'completed' | 'abandoned' = 'started',
) => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const courseId = 'course-s5'
  const sessionId = 'session-s5'
  const wordId = 'word-s5'

  await courseRepository.createCourse({
    learner: {
      id: 'learner-s5',
      name: 'Alice',
      accessCode: 'ABCDEFGH23',
      createdAt: NOW.toISOString(),
    },
    course: {
      id: courseId,
      learnerId: 'learner-s5',
      sourceVersionId: 'version-s5',
      currentLessonNo: 1,
      status: 'active',
      createdAt: NOW.toISOString(),
    },
  })
  await courseRepository.createLesson({
    session: {
      id: sessionId,
      courseId,
      lessonNo: 1,
        status: sessionStatus,
      taskCount: 1,
      completedTaskCount: 0,
      correctCount: 0,
      wrongCount: 0,
        startedAt: NOW.toISOString(),
        ...(sessionStatus === 'completed' ? { completedAt: NOW.toISOString() } : {}),
    },
    tasks: [
      {
        id: 'task-s5',
        sessionId,
        courseId,
        wordId,
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
        wordId,
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

  return {
    runtime: createCourseRuntime({
      contentRepository,
      courseRepository,
      now: () => NOW,
      selectRefluxGap: () => 5,
    }),
    courseRepository,
    courseId,
    sessionId,
    wordId,
  }
}

const approveAll = async (builder: ContentBuilder, versionId: string) => {
  const items = await builder.listExerciseItems(versionId)
  await builder.approveExerciseItems(items.map((item) => item.id))
}

const submitRecognize = (
  runtime: ReturnType<typeof createCourseRuntime>,
  sessionId: string,
  taskId: string,
  response: 'known' | 'learning',
) =>
  runtime.submitAnswer({
    sessionId,
    taskId,
    submission: { taskType: 'recognize_meaning', response },
  })

const requireTask = <T>(tasks: T[], index: number): T => {
  const task = tasks[index]

  if (!task) {
    throw new Error(`Expected task at index ${String(index)}`)
  }

  return task
}
