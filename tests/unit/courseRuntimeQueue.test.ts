import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createContentBuilder, type ContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { DomainError } from '../../server/errors/DomainError'
import { exerciseItemContentSchema } from '../../shared/api/taskSchemas'

const NOW = new Date('2026-07-13T00:00:00.000Z')

describe('course runtime authoritative task queue', () => {
  it('bounds five always-wrong v2 words to fifteen tasks without capacity defer', async () => {
    const fixture = await createFixture(5, 5, 'v2')
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    let answeredCount = 0

    for (;;) {
      const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
        (task) => task.status === 'pending',
      )

      if (!current) break
      if (answeredCount >= 15) throw new Error('V2 queue exceeded the fifteen-task bound')

      await submitRecognize(fixture.runtime, lesson.session.id, current.id, 'learning')
      answeredCount += 1
    }

    const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })

    expect(answeredCount).toBe(15)
    expect(snapshot?.tasks).toHaveLength(15)
    expect(countBy(snapshot?.tasks ?? [], (task) => task.wordId)).toEqual([3, 3, 3, 3, 3])
    expect(
      snapshot?.reviewLogs.filter((log) => log.queueDisposition === 'scheduled'),
    ).toHaveLength(10)
    expect(
      snapshot?.reviewLogs.filter((log) => log.queueDisposition === 'deferred_cap'),
    ).toHaveLength(5)
    expect(
      snapshot?.reviewLogs.filter((log) => log.queueDisposition === 'deferred_capacity'),
    ).toHaveLength(0)

    for (const log of snapshot?.reviewLogs.filter(
      (candidate) => candidate.queueDisposition === 'scheduled',
    ) ?? []) {
      const sourceIndex = snapshot?.tasks.findIndex((task) => task.id === log.taskId) ?? -1
      const source = snapshot?.tasks[sourceIndex]
      const childIndex = snapshot?.tasks.findIndex(
        (task) => task.refluxSourceTaskId === log.taskId,
      ) ?? -1
      const firstSameWordIndex = snapshot?.tasks.findIndex(
        (task, index) => index > sourceIndex && task.wordId === source?.wordId,
      ) ?? -1

      expect(firstSameWordIndex).toBe(childIndex)
      expect(childIndex - sourceIndex - 1).toBeGreaterThanOrEqual(3)
      expect(childIndex - sourceIndex - 1).toBeLessThanOrEqual(6)
    }

    const states = await fixture.courseRepository.getWordStates(fixture.courseId)
    expect(states).toHaveLength(5)
    expect(states.every((state) => state.totalAttemptCount === 1)).toBe(true)
    expect(states.every((state) => state.totalWrongCount === 1)).toBe(true)
    expect(states.every((state) => state.nextDueLessonNo === 2)).toBe(true)

    await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
      session: { status: 'completed', taskCount: 15, completedTaskCount: 15 },
      course: { currentLessonNo: 2 },
    })
  })

  it.each([1, 2, 3])(
    'keeps two consecutive short-pool lessons finite for N=%i',
    async (wordCount) => {
      const fixture = await createFixture(3, 5, 'v2')
      await seedShortPoolLesson(fixture, wordCount)

      for (const expectedLessonNo of [1, 2]) {
        const lesson = await fixture.runtime.startLesson(fixture.courseId)

        expect(lesson.session.lessonNo).toBe(expectedLessonNo)

        for (let index = 0; index < wordCount; index += 1) {
          const current = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
            (task) => task.status === 'pending',
          )

          if (!current) throw new Error('Expected another short-pool primary task')
          await submitRecognize(fixture.runtime, lesson.session.id, current.id, 'learning')
        }

        const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
          sessionId: lesson.session.id,
          courseId: fixture.courseId,
        })

        expect(snapshot?.tasks).toHaveLength(wordCount)
        expect(snapshot?.tasks.every((task) => task.role === 'primary')).toBe(true)
        expect(
          snapshot?.reviewLogs.every(
            (log) => log.queueDisposition === 'deferred_capacity',
          ),
        ).toBe(true)
        await expect(fixture.runtime.completeLesson(lesson.session.id)).resolves.toMatchObject({
          session: { status: 'completed' },
          course: { currentLessonNo: expectedLessonNo + 1 },
        })
      }
    },
  )

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

  it('schedules a v2 bridge wrong answer without advancing mastery counters', async () => {
    const fixture = await createFixture(5, 5, 'v2')
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 4)) {
      await submitRecognize(fixture.runtime, lesson.session.id, task.id, 'known')
    }

    await submitRecognize(
      fixture.runtime,
      lesson.session.id,
      requireTask(lesson.tasks, 4).id,
      'learning',
    )
    const bridge = (await fixture.runtime.getLesson(lesson.session.id)).tasks.find(
      (task) => task.role === 'bridge' && task.status === 'pending',
    )

    if (!bridge) throw new Error('Expected a v2 bridge task')
    const before = await fixture.courseRepository.getWordState(
      fixture.courseId,
      bridge.wordId,
    )

    await submitRecognize(fixture.runtime, lesson.session.id, bridge.id, 'learning')

    const after = await fixture.courseRepository.getWordState(
      fixture.courseId,
      bridge.wordId,
    )
    const snapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const bridgeLog = snapshot?.reviewLogs.find((log) => log.taskId === bridge.id)

    expect(bridgeLog?.queueDisposition).toBe('scheduled')
    expect(
      snapshot?.tasks.filter((task) => task.refluxSourceTaskId === bridge.id),
    ).toHaveLength(1)
    expect(after).toMatchObject({
      stage: before?.stage,
      totalAttemptCount: before?.totalAttemptCount,
      totalCorrectCount: before?.totalCorrectCount,
      totalWrongCount: before?.totalWrongCount,
      nextDueLessonNo: 2,
    })
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

  it.each([0, 2, 4])(
    'keeps the first same-word retry five to eight tasks after primary position %i',
    async (sourceIndex) => {
      const fixture = await createFixture(5, 5)
      const lesson = await fixture.runtime.startLesson(fixture.courseId)

      for (const task of lesson.tasks.slice(0, sourceIndex)) {
        await submitRecognize(fixture.runtime, lesson.session.id, task.id, 'known')
      }

      const source = requireTask(lesson.tasks, sourceIndex)
      await submitRecognize(fixture.runtime, lesson.session.id, source.id, 'learning')

      const restored = await fixture.runtime.getLesson(lesson.session.id)
      expectFirstSameWordGap(restored.tasks, source.id)
      expect(
        restored.tasks
          .filter((task) => task.role === 'bridge')
          .every((task) => task.wordId !== source.wordId),
      ).toBe(true)
    },
  )

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
    const afterPrimary = await fixture.runtime.getLesson(lesson.session.id)

    expectFirstSameWordGap(afterPrimary.tasks, primary.id)

    let current = afterPrimary.tasks.find(
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
    expectFirstSameWordGap(updated.tasks, firstReflux.id)
    expect(refluxResult.wordState).toMatchObject({
      totalAttemptCount: primaryResult.wordState.totalAttemptCount,
      totalWrongCount: primaryResult.wordState.totalWrongCount,
    })
  })

  it('records concurrent retries once and creates only one reflux obligation', async () => {
    const fixture = await createFixture(5, 5, 'v2')
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
    await expect(
      fixture.courseRepository.getLessonQueueSnapshot({
        sessionId: lesson.session.id,
        courseId: fixture.courseId,
      }),
    ).resolves.toMatchObject({
      reviewLogs: [{ taskId: firstTask.id, queueDisposition: 'scheduled' }],
    })
  })

  it('rejects a corrupt v2 queue snapshot without any business write', async () => {
    const fixture = await createFixture(5, 5, 'v2')
    const lesson = await fixture.runtime.startLesson(fixture.courseId)
    const firstTask = requireTask(lesson.tasks, 0)
    const beforeSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const beforeWordStates = await fixture.courseRepository.getWordStates(fixture.courseId)

    if (!beforeSnapshot) throw new Error('Expected a v2 queue snapshot')

    const corruptRepository = {
      ...fixture.courseRepository,
      getLessonQueueSnapshot: async (input: { sessionId: string; courseId: string }) => {
        const snapshot = await fixture.courseRepository.getLessonQueueSnapshot(input)

        if (!snapshot) return undefined

        return {
          ...snapshot,
          tasks: [
            ...snapshot.tasks,
            {
              ...firstTask,
              id: 'corrupt-duplicate-pending-task',
              orderIndex: snapshot.tasks.length + 1,
              role: 'bridge' as const,
              required: true,
            },
          ],
        }
      },
    }
    const corruptRuntime = createCourseRuntime({
      contentRepository: fixture.contentRepository,
      courseRepository: corruptRepository,
      now: () => NOW,
      queueWriteMode: 'v2',
    })

    await expect(
      corruptRuntime.submitAnswer({
        sessionId: lesson.session.id,
        taskId: firstTask.id,
        submission: { taskType: 'recognize_meaning', response: 'learning' },
      }),
    ).rejects.toMatchObject({ code: 'queue_invariant_violation' })
    await expect(
      fixture.courseRepository.getLessonQueueSnapshot({
        sessionId: lesson.session.id,
        courseId: fixture.courseId,
      }),
    ).resolves.toEqual(beforeSnapshot)
    await expect(fixture.courseRepository.getWordStates(fixture.courseId)).resolves.toEqual(
      beforeWordStates,
    )
    await expect(
      fixture.courseRepository.getSubmittedAnswer(lesson.session.id, firstTask.id),
    ).resolves.toBeUndefined()
  })

  it('rejects v2 completion from a corrupt queue snapshot without advancing the course', async () => {
    const fixture = await createFixture(5, 5, 'v2')
    const lesson = await fixture.runtime.startLesson(fixture.courseId)

    for (const task of lesson.tasks.slice(0, 4)) {
      await submitRecognize(fixture.runtime, lesson.session.id, task.id, 'known')
    }

    const beforeSnapshot = await fixture.courseRepository.getLessonQueueSnapshot({
      sessionId: lesson.session.id,
      courseId: fixture.courseId,
    })
    const beforeCourse = await fixture.courseRepository.getCourse(fixture.courseId)

    if (!beforeSnapshot) throw new Error('Expected a v2 queue snapshot')
    const firstLog = beforeSnapshot.reviewLogs[0]

    if (!firstLog) throw new Error('Expected a completed task audit log')

    const corruptRepository = {
      ...fixture.courseRepository,
      getLessonQueueSnapshot: () =>
        Promise.resolve({
          ...beforeSnapshot,
          reviewLogs: beforeSnapshot.reviewLogs.filter((log) => log.id !== firstLog.id),
        }),
    }
    const corruptRuntime = createCourseRuntime({
      contentRepository: fixture.contentRepository,
      courseRepository: corruptRepository,
      now: () => NOW,
      queueWriteMode: 'v2',
    })

    await expect(corruptRuntime.completeLesson(lesson.session.id)).rejects.toMatchObject({
      code: 'queue_invariant_violation',
    })
    await expect(
      fixture.courseRepository.getLessonQueueSnapshot({
        sessionId: lesson.session.id,
        courseId: fixture.courseId,
      }),
    ).resolves.toEqual(beforeSnapshot)
    await expect(fixture.courseRepository.getCourse(fixture.courseId)).resolves.toEqual(
      beforeCourse,
    )
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
  queueWriteMode: 'legacy_v1' | 'v2' = 'legacy_v1',
) => {
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()
  const builder = createContentBuilder({ repository: contentRepository, now: () => NOW })
  const draft = await builder.importWords({
    sourceName: 'Queue source',
    words: Array.from({ length: wordCount }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)} here.`,
      exampleSentenceExtended: `I can use word-${String(index + 1)} here every day.`,
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
    queueWriteMode,
  })
  const created = await runtime.createCourse({
    learnerName: 'Alice',
    sourceVersionId: draft.versionId,
  })

  return {
    runtime,
    contentRepository,
    courseRepository,
    courseId: created.course.id,
    versionId: draft.versionId,
  }
}

const seedShortPoolLesson = async (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  wordCount: number,
): Promise<void> => {
  const source = await fixture.contentRepository.getSourceVersion(fixture.versionId)
  const group = source?.groups[0]
  const words = source?.words.slice(0, wordCount) ?? []

  if (!source || !group || words.length !== wordCount) {
    throw new Error('Expected a published short-pool source snapshot')
  }

  const sessionId = `session-short-${String(wordCount)}`
  const tasks = words.map((word, index) => {
    const item = source.exerciseItems.find(
      (candidate) =>
        candidate.wordId === word.id &&
        candidate.stage === 'S0' &&
        candidate.status === 'approved',
    )

    if (!item) throw new Error(`Expected approved S0 content for ${word.id}`)
    const content = exerciseItemContentSchema.parse({
      stage: item.stage,
      taskType: item.taskType,
      prompt: item.prompt,
      answer: item.answer,
    })

    return {
      id: `task-short-${String(index + 1)}`,
      sessionId,
      courseId: fixture.courseId,
      wordId: word.id,
      orderIndex: index + 1,
      status: 'pending' as const,
      role: 'primary' as const,
      required: false,
      createdAt: NOW.toISOString(),
      ...content,
    }
  })

  await fixture.courseRepository.createLesson({
    session: {
      id: sessionId,
      courseId: fixture.courseId,
      lessonNo: 1,
      status: 'started',
      taskCount: tasks.length,
      completedTaskCount: 0,
      correctCount: 0,
      wrongCount: 0,
      queuePolicyVersion: 'v2_3_6_cap3',
      startedAt: NOW.toISOString(),
    },
    tasks,
    wordStates: words.map((word, index) => ({
      id: `state-short-${String(index + 1)}`,
      courseId: fixture.courseId,
      wordId: word.id,
      groupId: group.id,
      stage: 'S0',
      totalAttemptCount: 0,
      totalCorrectCount: 0,
      totalWrongCount: 0,
      currentStreak: 0,
      wrongStreak: 0,
      lapseCount: 0,
      easeFactor: 1,
      masteryScore: 0,
      firstLessonNo: 1,
      nextDueLessonNo: 1,
      status: 'new',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
  })
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
      queuePolicyVersion: 'v1_5_8_unbounded',
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
      queueWriteMode: 'legacy_v1',
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

const countBy = <T>(items: T[], key: (item: T) => string): number[] =>
  Array.from(
    items.reduce<Map<string, number>>((counts, item) => {
      const value = key(item)
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map()).values(),
  ).sort((left, right) => left - right)

const expectFirstSameWordGap = (
  tasks: Array<{ id: string; wordId: string; orderIndex: number }>,
  sourceTaskId: string,
): void => {
  const ordered = [...tasks].sort((left, right) => left.orderIndex - right.orderIndex)
  const sourceIndex = ordered.findIndex((task) => task.id === sourceTaskId)
  const source = ordered[sourceIndex]

  if (!source) {
    throw new Error(`Expected source task ${sourceTaskId}`)
  }

  const retryIndex = ordered.findIndex(
    (task, index) => index > sourceIndex && task.wordId === source.wordId,
  )

  expect(retryIndex).toBeGreaterThan(sourceIndex)
  expect(retryIndex - sourceIndex - 1).toBeGreaterThanOrEqual(5)
  expect(retryIndex - sourceIndex - 1).toBeLessThanOrEqual(8)
}
