import { describe, expect, it } from 'vitest'
import {
  buildSchedule,
  isQueueFeasible,
  planPlannedReinforcement,
  planWrongAnswer,
  validateLessonQueueSnapshot,
  type LessonQueueFactories,
  type LessonQueueSchedulingProblem,
  type LessonQueueSnapshotInput,
  type LessonQueueTask,
} from '../../server/services/LessonQueuePolicy'

describe('lesson queue policy v2', () => {
  it('accepts an untouched five-word primary queue', () => {
    expect(() => { validateLessonQueueSnapshot(createSnapshot(5)); }).not.toThrow()
  })

  it('inserts the first planned reinforcement after two completed tasks without fillers', () => {
    const initial = createSnapshot(5)
    const tasks = initial.tasks.map((task, index) =>
      index < 3 ? { ...task, status: 'completed' as const } : task,
    )
    const snapshot: LessonQueueSnapshotInput = {
      ...initial,
      tasks,
      reviewLogs: tasks.slice(0, 3).map((task) => ({
        taskId: task.id,
        wordId: task.wordId,
        score: 2 as const,
      })),
    }

    const plan = planPlannedReinforcement(snapshot, {
      newWordIds: initial.tasks.map((task) => task.wordId),
      maximumTaskCount: 18,
      createReinforcement: (source) => ({
        ...source,
        id: `reinforcement-for-${source.id}`,
        stage: 'S1',
        orderIndex: 0,
        status: 'pending',
        role: 'bridge',
        required: true,
        reinforcementSourceTaskId: source.id,
      }),
    })

    expect(plan.createdSourceTaskId).toBe('primary-1')
    expect(plan.tasks.map((task) => task.id)).toEqual([
      'primary-1',
      'primary-2',
      'primary-3',
      'reinforcement-for-primary-1',
      'primary-4',
      'primary-5',
    ])
    expect(plan.tasks.filter((task) => task.role === 'bridge')).toHaveLength(1)
    expect(() => {
      validateLessonQueueSnapshot({ ...snapshot, tasks: plan.tasks })
    }).not.toThrow()
  })

  it('keeps a higher-priority wrong recurrence feasible when adding planned reinforcement', () => {
    const initial = createSnapshot(6)
    initial.tasks = initial.tasks.map((task, index) => ({
      ...task,
      status: index < 2 ? 'completed' as const : 'pending' as const,
    }))
    initial.reviewLogs = initial.tasks.slice(0, 2).map((task) => ({
      taskId: task.id,
      wordId: task.wordId,
      score: 2 as const,
    }))
    const wrongPlan = planWrongAnswer(initial, {
      ...createFactories('primary-3'),
      maximumTaskCount: 24,
    })
    const afterWrong: LessonQueueSnapshotInput = {
      suspendedWordIds: new Set(),
      tasks: wrongPlan.tasks,
      reviewLogs: [
        ...initial.reviewLogs,
        {
          taskId: 'primary-3',
          wordId: 'word-3',
          score: 0,
          queueDisposition: wrongPlan.disposition,
          ...(wrongPlan.capacityReason === undefined
            ? {}
            : { queueCapacityReason: wrongPlan.capacityReason }),
        },
      ],
      maximumTaskCount: 24,
      requireCapacityReasons: true,
    }
    const combined = planPlannedReinforcement(afterWrong, {
      newWordIds: initial.tasks.map((task) => task.wordId),
      maximumTaskCount: 18,
      createReinforcement: (source) => ({
        ...source,
        id: `reinforcement-for-${source.id}`,
        stage: 'S1',
        orderIndex: 0,
        status: 'pending',
        role: 'bridge',
        required: true,
        reinforcementSourceTaskId: source.id,
      }),
    })
    const planned = combined.tasks.find(
      (task) => task.reinforcementSourceTaskId === 'primary-1',
    )
    const reflux = combined.tasks.find(
      (task) => task.refluxSourceTaskId === 'primary-3',
    )

    expect(wrongPlan.disposition).toBe('scheduled')
    expect(planned).toBeTruthy()
    expect(reflux).toBeTruthy()
    expect((planned?.orderIndex ?? 0) - 1 - 1).toBeGreaterThanOrEqual(2)
    expect((planned?.orderIndex ?? 0) - 1 - 1).toBeLessThanOrEqual(4)
    expect((reflux?.orderIndex ?? 0) - 3 - 1).toBeGreaterThanOrEqual(3)
    expect((reflux?.orderIndex ?? 0) - 3 - 1).toBeLessThanOrEqual(6)
    expect(() => {
      validateLessonQueueSnapshot({
        ...afterWrong,
        tasks: combined.tasks,
      })
    }).not.toThrow()
  })

  it('omits optional reinforcement when a wrong-answer filler already occupies its word', () => {
    const initial = createSnapshot(5)
    initial.tasks = initial.tasks.map((task, index) => ({
      ...task,
      status: index < 2 ? 'completed' as const : 'pending' as const,
    }))
    initial.reviewLogs = initial.tasks.slice(0, 2).map((task) => ({
      taskId: task.id,
      wordId: task.wordId,
      score: 2 as const,
    }))
    const wrongPlan = planWrongAnswer(initial, {
      ...createFactories('primary-3'),
      maximumTaskCount: 24,
    })
    const snapshot: LessonQueueSnapshotInput = {
      tasks: wrongPlan.tasks,
      reviewLogs: [
        ...initial.reviewLogs,
        {
          taskId: 'primary-3',
          wordId: 'word-3',
          score: 0,
          queueDisposition: wrongPlan.disposition,
          ...(wrongPlan.capacityReason === undefined
            ? {}
            : { queueCapacityReason: wrongPlan.capacityReason }),
        },
      ],
      suspendedWordIds: new Set(),
      maximumTaskCount: 24,
      requireCapacityReasons: true,
    }
    const planned = planPlannedReinforcement(snapshot, {
      newWordIds: initial.tasks.map((task) => task.wordId),
      maximumTaskCount: 18,
      createReinforcement: (source) => ({
        ...source,
        id: `reinforcement-for-${source.id}`,
        stage: 'S1',
        orderIndex: 0,
        status: 'pending',
        role: 'bridge',
        required: true,
        reinforcementSourceTaskId: source.id,
      }),
    })

    expect(planned.createdSourceTaskId).toBeUndefined()
    expect(() => {
      validateLessonQueueSnapshot({
        ...snapshot,
        tasks: planned.tasks,
      })
    }).not.toThrow()
  })

  it('owns new-word S0 source eligibility inside the queue policy', () => {
    const initial = createSnapshot(5)
    const tasks = initial.tasks.map((task, index) => ({
      ...task,
      status: index < 3 ? 'completed' as const : 'pending' as const,
    }))
    const snapshot: LessonQueueSnapshotInput = {
      ...initial,
      tasks,
      reviewLogs: tasks.slice(0, 3).map((task) => ({
        taskId: task.id,
        wordId: task.wordId,
        score: 2 as const,
      })),
    }
    const createReinforcement = (source: LessonQueueTask): LessonQueueTask => ({
      ...source,
      id: `reinforcement-for-${source.id}`,
      stage: 'S1',
      orderIndex: 0,
      status: 'pending',
      role: 'bridge',
      required: true,
      reinforcementSourceTaskId: source.id,
    })

    expect(planPlannedReinforcement(snapshot, {
      newWordIds: [],
      maximumTaskCount: 18,
      createReinforcement,
    }).createdSourceTaskId).toBeUndefined()

    expect(planPlannedReinforcement(snapshot, {
      newWordIds: ['word-1'],
      maximumTaskCount: 18,
      createReinforcement,
    }).createdSourceTaskId).toBe('primary-1')

    const nonS0Tasks = tasks.map((task) =>
      task.id === 'primary-1' ? { ...task, stage: 'S1' as const } : task,
    )

    expect(planPlannedReinforcement({ ...snapshot, tasks: nonS0Tasks }, {
      newWordIds: ['word-1'],
      maximumTaskCount: 18,
      createReinforcement,
    }).createdSourceTaskId).toBeUndefined()
  })

  it.each([
    { gap: 2, valid: false },
    { gap: 3, valid: true },
    { gap: 4, valid: true },
    { gap: 5, valid: true },
    { gap: 6, valid: true },
    { gap: 7, valid: false },
  ])('accepts only three to six actually completed intervening tasks: $gap', ({ gap, valid }) => {
    const snapshot = completedRefluxSnapshot(gap)
    const validate = () => { validateLessonQueueSnapshot(snapshot); }

    if (valid) expect(validate).not.toThrow()
    else expect(validate).toThrow('three to six completed tasks')
  })

  it('does not count a skipped task as an intervening answer', () => {
    const snapshot = completedRefluxSnapshot(3)
    const middle = snapshot.tasks[2]

    if (!middle) throw new Error('Expected an intervening task')
    middle.status = 'skipped'

    expect(() => { validateLessonQueueSnapshot(snapshot); }).toThrow(
      'three to six completed tasks',
    )
  })

  it('counts skipped tasks toward the per-word cap of three', () => {
    const snapshot = completedRefluxSnapshot(3)
    const overCap = {
      ...snapshot,
      tasks: [
        ...snapshot.tasks,
        {
          id: 'skipped-same-word',
          wordId: 'word-source',
          orderIndex: 6,
          status: 'skipped' as const,
          role: 'bridge' as const,
          required: true,
        },
        {
          id: 'fourth-same-word',
          wordId: 'word-source',
          orderIndex: 7,
          status: 'pending' as const,
          role: 'bridge' as const,
          required: true,
        },
      ],
    }

    expect(() => { validateLessonQueueSnapshot(overCap); }).toThrow(
      'more than three tasks',
    )
  })

  it('defers a one-word lesson because three real intervening tasks are impossible', () => {
    const plan = planWrongAnswer(createSnapshot(1), createFactories('primary-1'))

    expect(plan).toMatchObject({ disposition: 'deferred_capacity' })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0]).toMatchObject({ id: 'primary-1', status: 'completed' })
  })

  it('records short-pool, interval, and hard-budget capacity reasons distinctly', () => {
    expect(
      planWrongAnswer(createSnapshot(1), {
        ...createFactories('primary-1'),
        maximumTaskCount: 24,
      }),
    ).toMatchObject({
      disposition: 'deferred_capacity',
      capacityReason: 'short_pool',
    })

    const intervalSnapshot = createSnapshot(4)
    intervalSnapshot.tasks = intervalSnapshot.tasks.map((task, index) => ({
      ...task,
      status: index < 3 ? 'completed' as const : 'pending' as const,
    }))
    intervalSnapshot.reviewLogs = intervalSnapshot.tasks.slice(0, 3).map((task) => ({
      taskId: task.id,
      wordId: task.wordId,
      score: 2 as const,
    }))
    intervalSnapshot.suspendedWordIds = new Set(['word-1', 'word-2', 'word-3'])

    expect(
      planWrongAnswer(intervalSnapshot, {
        ...createFactories('primary-4'),
        maximumTaskCount: 24,
      }),
    ).toMatchObject({
      disposition: 'deferred_capacity',
      capacityReason: 'interval_infeasible',
    })

    const budgetPlan = planWrongAnswer(createSnapshot(24), {
        ...createFactories('primary-1'),
        maximumTaskCount: 24,
      })

    expect(budgetPlan).toMatchObject({
      disposition: 'deferred_capacity',
      capacityReason: 'lesson_task_budget',
    })
    expect(budgetPlan.tasks).toHaveLength(24)
  })

  it('prioritizes the hard lesson budget when a full queue is also interval-infeasible', () => {
    const snapshot = createSnapshot(24)
    snapshot.tasks = snapshot.tasks.map((task, index) => ({
      ...task,
      status: index < 23 ? 'completed' as const : 'pending' as const,
    }))
    snapshot.reviewLogs = snapshot.tasks.slice(0, 23).map((task) => ({
      taskId: task.id,
      wordId: task.wordId,
      score: 2 as const,
    }))
    snapshot.suspendedWordIds = new Set(
      snapshot.tasks.slice(0, 23).map((task) => task.wordId),
    )

    expect(
      planWrongAnswer(snapshot, {
        ...createFactories('primary-24'),
        maximumTaskCount: 24,
      }),
    ).toMatchObject({
      disposition: 'deferred_capacity',
      capacityReason: 'lesson_task_budget',
    })
  })

  it('rejects a snapshot with more than three planned reinforcements', () => {
    const task = (
      id: string,
      wordId: string,
      role: 'primary' | 'bridge',
      reinforcementSourceTaskId?: string,
    ) => ({
      id,
      wordId,
      orderIndex: 0,
      status: 'completed' as const,
      role,
      required: role === 'bridge',
      ...(reinforcementSourceTaskId === undefined
        ? {}
        : { reinforcementSourceTaskId }),
    })
    const tasks = [
      task('a0', 'a', 'primary'),
      task('b0', 'b', 'primary'),
      task('c0', 'c', 'primary'),
      task('a1', 'a', 'bridge', 'a0'),
      task('d0', 'd', 'primary'),
      task('b1', 'b', 'bridge', 'b0'),
      task('e0', 'e', 'primary'),
      task('c1', 'c', 'bridge', 'c0'),
      task('f0', 'f', 'primary'),
      task('d1', 'd', 'bridge', 'd0'),
    ].map((item, index) => ({ ...item, orderIndex: index + 1 }))

    expect(() => {
      validateLessonQueueSnapshot({
        tasks,
        reviewLogs: tasks.map((item) => ({
          taskId: item.id,
          wordId: item.wordId,
          score: 2,
        })),
        suspendedWordIds: new Set(),
      })
    }).toThrow('more than three planned reinforcements')
  })

  it('requires a capacity reason only for rolling capacity defers', () => {
    const snapshot = createSnapshot(1)
    const task = snapshot.tasks[0]

    if (!task) throw new Error('Expected a task')
    task.status = 'completed'

    expect(() => {
      validateLessonQueueSnapshot({
        ...snapshot,
        requireCapacityReasons: true,
        reviewLogs: [{
          taskId: task.id,
          wordId: task.wordId,
          score: 0,
          queueDisposition: 'deferred_capacity',
        }],
      })
    }).toThrow('requires a reason')
    expect(() => {
      validateLessonQueueSnapshot({
        ...snapshot,
        requireCapacityReasons: true,
        reviewLogs: [{
          taskId: task.id,
          wordId: task.wordId,
          score: 0,
          queueDisposition: 'deferred_capacity',
          queueCapacityReason: 'short_pool',
        }],
      })
    }).not.toThrow()
  })

  it('closes the word at three scheduled rows without creating a fourth', () => {
    const snapshot: LessonQueueSnapshotInput = {
      suspendedWordIds: new Set(),
      tasks: [
        {
          id: 'primary-1', wordId: 'word-1', orderIndex: 1,
          status: 'completed', role: 'primary', required: false,
        },
        {
          id: 'bridge-1', wordId: 'word-1', orderIndex: 2,
          status: 'completed', role: 'bridge', required: true,
        },
        {
          id: 'bridge-2', wordId: 'word-1', orderIndex: 3,
          status: 'pending', role: 'bridge', required: true,
        },
      ],
      reviewLogs: [
        { taskId: 'primary-1', wordId: 'word-1', score: 2 },
        { taskId: 'bridge-1', wordId: 'word-1', score: 2 },
      ],
    }

    const plan = planWrongAnswer(snapshot, createFactories('bridge-2'))

    expect(plan).toMatchObject({ disposition: 'deferred_cap' })
    expect(plan.tasks).toHaveLength(3)
  })

  it('uses all four remaining primaries before the first five-word reflux', () => {
    const plan = planWrongAnswer(createSnapshot(5), createFactories('primary-1'))

    expect(plan.disposition).toBe('scheduled')
    expect(plan.tasks.map((task) => task.id)).toEqual([
      'primary-1',
      'primary-2',
      'primary-3',
      'primary-4',
      'primary-5',
      'reflux-for-primary-1',
    ])
    expect(plan.tasks.filter((task) => task.role === 'bridge')).toHaveLength(0)
  })

  it.each([1, 2, 3])('uses the explicit short-pool fallback for N=%i', (wordCount) => {
    expect(
      planWrongAnswer(createSnapshot(wordCount), createFactories('primary-1'))
        .disposition,
    ).toBe('deferred_capacity')
  })

  it('finishes five always-wrong words in exactly fifteen tasks without capacity defer', () => {
    let snapshot = createSnapshot(5)
    const dispositions: string[] = []

    for (;;) {
      const current = snapshot.tasks.find((task) => task.status === 'pending')

      if (!current) break

      const plan = planWrongAnswer(snapshot, createFactories(current.id))
      dispositions.push(plan.disposition)
      snapshot = {
        tasks: plan.tasks,
        suspendedWordIds: snapshot.suspendedWordIds,
        reviewLogs: [
          ...snapshot.reviewLogs,
          {
            taskId: current.id,
            wordId: current.wordId,
            score: 0,
            queueDisposition: plan.disposition,
          },
        ],
      }
    }

    expect(snapshot.tasks.map((task) => task.wordId)).toEqual([
      'word-1', 'word-2', 'word-3', 'word-4', 'word-5',
      'word-1', 'word-2', 'word-3', 'word-4', 'word-5',
      'word-1', 'word-2', 'word-3', 'word-4', 'word-5',
    ])
    expect(snapshot.tasks).toHaveLength(15)
    expect(dispositions.filter((value) => value === 'scheduled')).toHaveLength(10)
    expect(dispositions.filter((value) => value === 'deferred_cap')).toHaveLength(5)
    expect(dispositions).not.toContain('deferred_capacity')
    expect(() => { validateLessonQueueSnapshot(snapshot); }).not.toThrow()
  })

  it('treats a correctly completed reflux as closed when selecting bridge words', () => {
    const snapshot = closedRefluxWithCurrentFifthWord()
    const plan = planWrongAnswer(snapshot, createFactories('primary-5'))

    expect(plan.disposition).toBe('scheduled')
    expect(
      plan.tasks.some((task) => task.role === 'bridge' && task.wordId === 'word-1'),
    ).toBe(true)
  })

  it('rejects a completed wrong answer without a persisted disposition', () => {
    const snapshot = createSnapshot(1)
    const task = snapshot.tasks[0]

    if (!task) throw new Error('Expected a task')
    task.status = 'completed'

    expect(() =>
      { validateLessonQueueSnapshot({
        tasks: snapshot.tasks,
        suspendedWordIds: snapshot.suspendedWordIds,
        reviewLogs: [{ taskId: task.id, wordId: task.wordId, score: 0 }],
      }); },
    ).toThrow('requires a queue disposition')
  })

  it('rejects another same-word task after capacity defer closes the word', () => {
    const snapshot: LessonQueueSnapshotInput = {
      suspendedWordIds: new Set(),
      tasks: [
        {
          id: 'source', wordId: 'word-1', orderIndex: 1,
          status: 'completed', role: 'primary', required: false,
        },
        {
          id: 'forbidden-later-task', wordId: 'word-1', orderIndex: 2,
          status: 'pending', role: 'bridge', required: true,
        },
      ],
      reviewLogs: [
        {
          taskId: 'source', wordId: 'word-1', score: 0,
          queueDisposition: 'deferred_capacity',
        },
      ],
    }

    expect(() => { validateLessonQueueSnapshot(snapshot); }).toThrow('is closed')
  })

  it('keeps the independent oracle, builder, and brute-force reference equivalent', () => {
    const sourceRankSets = [[1], [1, 2], [1, 3], [2, 3], [1, 2, 3]]

    for (const sourceRanks of sourceRankSets) {
      const completedCount = Math.max(...sourceRanks)

      for (let existingFillers = 0; existingFillers <= 3; existingFillers += 1) {
        for (let bridgeFillers = 0; bridgeFillers <= 3; bridgeFillers += 1) {
          const problem = createSchedulingProblem(
            completedCount,
            sourceRanks,
            existingFillers,
            bridgeFillers,
          )
          const expected = bruteForceFeasible(
            completedCount,
            sourceRanks,
            existingFillers + bridgeFillers,
          )
          const feasible = isQueueFeasible(problem)
          const built = buildSchedule(problem)

          expect(feasible, caseLabel(sourceRanks, existingFillers, bridgeFillers))
            .toBe(expected)
          expect(Boolean(built), caseLabel(sourceRanks, existingFillers, bridgeFillers))
            .toBe(expected)
        }
      }
    }
  })

  it('never selects a suspended word as a bridge source', () => {
    const snapshot = {
      ...closedRefluxWithCurrentFifthWord(),
      suspendedWordIds: new Set(['word-1']),
    }
    const plan = planWrongAnswer(snapshot, createFactories('primary-5'))

    expect(plan.disposition).toBe('scheduled')
    expect(
      plan.tasks.some((task) => task.role === 'bridge' && task.wordId === 'word-1'),
    ).toBe(false)
  })

  it.each(['pending', 'skipped'] as const)(
    'rejects a review log attached to a %s task',
    (status) => {
      const snapshot = createSnapshot(1)
      const task = snapshot.tasks[0]

      if (!task) throw new Error('Expected a task')
      task.status = status

      expect(() =>
        { validateLessonQueueSnapshot({
          ...snapshot,
          reviewLogs: [{ taskId: task.id, wordId: task.wordId, score: 2 }],
        }); },
      ).toThrow('must reference a completed task')
    },
  )

  it('requires the first later same-word task to be the scheduled reflux child', () => {
    const valid = completedRefluxSnapshot(4)
    const source = valid.tasks[0]
    const early = valid.tasks[1]

    if (!source || !early) throw new Error('Expected source and intervening task')
    early.wordId = source.wordId
    early.role = 'bridge'
    const earlyLog = valid.reviewLogs.find((log) => log.taskId === early.id)

    if (!earlyLog) throw new Error('Expected an intervening review log')
    earlyLog.wordId = source.wordId

    expect(() => { validateLessonQueueSnapshot(valid); }).toThrow(
      'first later same-word task',
    )
  })

  it('rejects completed or skipped tasks after the first pending task', () => {
    const snapshot = createSnapshot(2)
    const second = snapshot.tasks[1]

    if (!second) throw new Error('Expected a second task')
    second.status = 'completed'

    expect(() =>
      { validateLessonQueueSnapshot({
        ...snapshot,
        reviewLogs: [{ taskId: second.id, wordId: second.wordId, score: 2 }],
      }); },
    ).toThrow('immutable prefix')
  })

  it('rejects bridge and reflux words outside the frozen primary word set', () => {
    const snapshot = createSnapshot(1)

    expect(() =>
      { validateLessonQueueSnapshot({
        ...snapshot,
        tasks: [
          ...snapshot.tasks,
          {
            id: 'foreign-bridge',
            wordId: 'future-word',
            orderIndex: 2,
            status: 'pending',
            role: 'bridge',
            required: true,
          },
        ],
      }); },
    ).toThrow('frozen lesson word set')
  })

  it('rejects two pending tasks for the same word', () => {
    const snapshot = createSnapshot(1)

    expect(() =>
      { validateLessonQueueSnapshot({
        ...snapshot,
        tasks: [
          ...snapshot.tasks,
          {
            id: 'second-pending',
            wordId: 'word-1',
            orderIndex: 2,
            status: 'pending',
            role: 'bridge',
            required: true,
          },
        ],
      }); },
    ).toThrow('two pending tasks')
  })

  it.each([10, 20])('keeps an always-wrong N=%i lesson within the 3N bound', (wordCount) => {
    const result = runAlwaysWrong(wordCount)
    const counts = countWords(result.snapshot.tasks)

    expect(result.snapshot.tasks.length).toBeLessThanOrEqual(wordCount * 3)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3)
    expect(result.steps).toBeLessThanOrEqual(wordCount * 3)
    expect(() => { validateLessonQueueSnapshot(result.snapshot); }).not.toThrow()
  })

  it('builds the same queue for the same snapshot and deterministic factories', () => {
    const snapshot = createSnapshot(5)

    expect(planWrongAnswer(snapshot, createFactories('primary-1'))).toEqual(
      planWrongAnswer(snapshot, createFactories('primary-1')),
    )
  })

  it('avoids the literal earliest-deadline starvation counterexample', () => {
    const naiveEarliest = [
      'word-1', 'word-2', 'word-3', 'word-4',
      'word-1', 'word-2', 'word-3', 'word-4',
      'word-1', 'word-2', 'word-3', 'word-4',
      'word-5',
    ]
    const naiveCounts = countWords(naiveEarliest.map((wordId, index) => ({
      id: `naive-${String(index)}`,
      wordId,
    })))
    const result = runAlwaysWrong(5)

    expect(naiveCounts).toEqual(new Map([
      ['word-1', 3], ['word-2', 3], ['word-3', 3], ['word-4', 3], ['word-5', 1],
    ]))
    expect(result.snapshot.tasks.map((task) => task.wordId)).not.toEqual(naiveEarliest)
    expect(countWords(result.snapshot.tasks)).toEqual(new Map([
      ['word-1', 3], ['word-2', 3], ['word-3', 3], ['word-4', 3], ['word-5', 3],
    ]))
  })
})

const createSnapshot = (wordCount: number): LessonQueueSnapshotInput => ({
  suspendedWordIds: new Set(),
  tasks: Array.from({ length: wordCount }, (_, index) => ({
    id: `primary-${String(index + 1)}`,
    wordId: `word-${String(index + 1)}`,
    stage: 'S0',
    orderIndex: index + 1,
    status: 'pending',
    role: 'primary',
    required: false,
  })),
  reviewLogs: [],
})

const completedRefluxSnapshot = (gap: number): LessonQueueSnapshotInput => {
  const source = {
    id: 'source',
    wordId: 'word-source',
    orderIndex: 1,
    status: 'completed' as const,
    role: 'primary' as const,
    required: false,
  }
  const intervening = Array.from({ length: gap }, (_, index) => ({
    id: `between-${String(index + 1)}`,
    wordId: `word-between-${String(index + 1)}`,
    orderIndex: index + 2,
    status: 'completed' as const,
    role: 'primary' as const,
    required: false,
  }))
  const reflux = {
    id: 'reflux',
    wordId: source.wordId,
    orderIndex: gap + 2,
    status: 'completed' as const,
    role: 'reflux' as const,
    required: true,
    refluxSourceTaskId: source.id,
  }

  return {
    suspendedWordIds: new Set(),
    tasks: [source, ...intervening, reflux],
    reviewLogs: [
      {
        taskId: source.id,
        wordId: source.wordId,
        score: 0,
        queueDisposition: 'scheduled',
      },
      ...intervening.map((task) => ({
        taskId: task.id,
        wordId: task.wordId,
        score: 2 as const,
      })),
      { taskId: reflux.id, wordId: reflux.wordId, score: 2 },
    ],
  }
}

const createFactories = (sourceTaskId: string): LessonQueueFactories<LessonQueueTask> => ({
  sourceTaskId,
  createReflux: (source) => ({
    ...source,
    id: `reflux-for-${source.id}`,
    orderIndex: 0,
    status: 'pending',
    role: 'reflux',
    required: true,
    refluxSourceTaskId: source.id,
  }),
  createBridge: (source, index) => ({
    ...source,
    id: `bridge-for-${source.id}-${String(index)}`,
    orderIndex: 0,
    status: 'pending',
    role: 'bridge',
    required: true,
  }),
})

const closedRefluxWithCurrentFifthWord = (): LessonQueueSnapshotInput => ({
  suspendedWordIds: new Set(),
  tasks: [
    {
      id: 'primary-1', wordId: 'word-1', orderIndex: 1,
      status: 'completed', role: 'primary', required: false,
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `primary-${String(index + 2)}`,
      wordId: `word-${String(index + 2)}`,
      orderIndex: index + 2,
      status: 'completed' as const,
      role: 'primary' as const,
      required: false,
    })),
    {
      id: 'reflux-1', wordId: 'word-1', orderIndex: 5,
      status: 'completed', role: 'reflux', required: true,
      refluxSourceTaskId: 'primary-1',
    },
    {
      id: 'primary-5', wordId: 'word-5', orderIndex: 6,
      status: 'pending', role: 'primary', required: false,
    },
  ],
  reviewLogs: [
    {
      taskId: 'primary-1', wordId: 'word-1', score: 0,
      queueDisposition: 'scheduled',
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      taskId: `primary-${String(index + 2)}`,
      wordId: `word-${String(index + 2)}`,
      score: 2 as const,
    })),
    { taskId: 'reflux-1', wordId: 'word-1', score: 2 },
  ],
})

const createSchedulingProblem = (
  completedCount: number,
  sourceRanks: number[],
  existingFillerCount: number,
  bridgeFillerCount: number,
): LessonQueueSchedulingProblem<LessonQueueTask> => {
  const completed = Array.from({ length: completedCount }, (_, index) => ({
    id: `source-${String(index + 1)}`,
    wordId: `word-${String(index + 1)}`,
    orderIndex: index + 1,
    status: 'completed' as const,
    role: 'primary' as const,
    required: false,
  }))
  const existingJobs = sourceRanks.slice(0, -1).map((rank, index) => ({
    id: `existing-reflux-${String(index + 1)}`,
    wordId: `word-${String(rank)}`,
    orderIndex: completedCount + index + 1,
    status: 'pending' as const,
    role: 'reflux' as const,
    required: true,
    refluxSourceTaskId: `source-${String(rank)}`,
  }))
  const existingFillers = Array.from({ length: existingFillerCount }, (_, index) => ({
    id: `existing-filler-${String(index + 1)}`,
    wordId: `filler-word-${String(index + 1)}`,
    orderIndex: completedCount + existingJobs.length + index + 1,
    status: 'pending' as const,
    role: 'primary' as const,
    required: false,
  }))
  const recurrenceSourceRank = sourceRanks.at(-1)

  if (recurrenceSourceRank === undefined) throw new Error('Expected a recurrence source')

  return {
    snapshot: {
      suspendedWordIds: new Set(),
      tasks: [...completed, ...existingJobs, ...existingFillers],
      reviewLogs: [],
    },
    sourceTaskId: `source-${String(recurrenceSourceRank)}`,
    recurrenceTask: {
      id: 'new-recurrence',
      wordId: `word-${String(recurrenceSourceRank)}`,
      orderIndex: 0,
      status: 'pending',
      role: 'reflux',
      required: true,
      refluxSourceTaskId: `source-${String(recurrenceSourceRank)}`,
    },
    bridgeCandidates: Array.from({ length: bridgeFillerCount }, (_, index) => ({
      id: `bridge-candidate-${String(index + 1)}`,
      wordId: `bridge-word-${String(index + 1)}`,
      orderIndex: 0,
      status: 'pending' as const,
      role: 'bridge' as const,
      required: true,
    })),
  }
}

const bruteForceFeasible = (
  completedCount: number,
  sourceRanks: number[],
  fillerCount: number,
): boolean => {
  const jobs = sourceRanks.map((sourceRank, index) => ({
    id: index,
    release: sourceRank + 4,
    deadline: sourceRank + 7,
  }))

  const visit = (
    slot: number,
    remaining: typeof jobs,
    fillers: number,
  ): boolean => {
    if (remaining.length === 0) return true
    if (slot > Math.max(...remaining.map((job) => job.deadline))) return false

    for (const job of remaining) {
      if (slot < job.release || slot > job.deadline) continue

      if (
        visit(
          slot + 1,
          remaining.filter((candidate) => candidate.id !== job.id),
          fillers,
        )
      ) {
        return true
      }
    }

    return fillers > 0 && visit(slot + 1, remaining, fillers - 1)
  }

  return visit(completedCount + 1, jobs, fillerCount)
}

const caseLabel = (
  sourceRanks: number[],
  existingFillers: number,
  bridgeFillers: number,
) => `sources=${sourceRanks.join(',')} existing=${String(existingFillers)} bridges=${String(bridgeFillers)}`

const runAlwaysWrong = (wordCount: number) => {
  let snapshot = createSnapshot(wordCount)
  const dispositions: string[] = []
  let steps = 0

  for (;;) {
    const current = snapshot.tasks.find((task) => task.status === 'pending')

    if (!current) break

    if (steps >= wordCount * 3) {
      throw new Error('Always-wrong lesson exceeded the 3N bound')
    }

    const plan = planWrongAnswer(snapshot, createFactories(current.id))
    dispositions.push(plan.disposition)
    snapshot = {
      tasks: plan.tasks,
      suspendedWordIds: snapshot.suspendedWordIds,
      reviewLogs: [
        ...snapshot.reviewLogs,
        {
          taskId: current.id,
          wordId: current.wordId,
          score: 0,
          queueDisposition: plan.disposition,
        },
      ],
    }
    steps += 1
  }

  return { snapshot, dispositions, steps }
}

const countWords = (
  tasks: ReadonlyArray<{ wordId: string }>,
): Map<string, number> => {
  const counts = new Map<string, number>()

  for (const task of tasks) {
    counts.set(task.wordId, (counts.get(task.wordId) ?? 0) + 1)
  }

  return counts
}
