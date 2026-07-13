import { describe, expect, it } from 'vitest'
import {
  getLessonCompletionDecision,
  getNextPendingTask,
  scheduleReflux,
  type QueueTask,
} from '../../server/services/lessonTaskQueue'

const primaryTasks = (count: number): QueueTask[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `primary-${String(index + 1)}`,
    orderIndex: index + 1,
    status: 'pending',
    role: 'primary',
    required: false,
  }))

describe('lesson task queue', () => {
  it('returns the first pending task by persisted order', () => {
    const tasks = primaryTasks(3)
    const first = tasks[0]

    if (!first) throw new Error('Expected first task')
    first.status = 'completed'

    expect(
      getNextPendingTask([requireTask(tasks, 2), first, requireTask(tasks, 1)])?.id,
    ).toBe('primary-2')
  })

  it.each([5, 6, 7, 8])('inserts reflux after exactly %i intervening tasks', (gap) => {
    const tasks = primaryTasks(10)
    const source = tasks[0]

    if (!source) throw new Error('Expected source task')
    const scheduled = scheduleReflux({
      tasks,
      sourceTaskId: source.id,
      gap,
      createBridge: (index) => requiredTask(`bridge-${String(index)}`, 'bridge'),
      createReflux: () => requiredTask('reflux', 'reflux'),
    })
    const reflux = scheduled.find((task) => task.id === 'reflux')

    expect((reflux?.orderIndex ?? 0) - source.orderIndex - 1).toBe(gap)
    expect(scheduled.filter((task) => task.role === 'bridge')).toHaveLength(0)
    expect(scheduled.map((task) => task.orderIndex)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    )
  })

  it('fills a short tail with required bridge tasks before reflux', () => {
    const tasks = primaryTasks(5)
    const source = tasks[4]

    if (!source) throw new Error('Expected last primary task')
    const scheduled = scheduleReflux({
      tasks,
      sourceTaskId: source.id,
      gap: 5,
      createBridge: (index) => requiredTask(`bridge-${String(index)}`, 'bridge'),
      createReflux: () => requiredTask('reflux', 'reflux'),
    })

    expect(scheduled.filter((task) => task.role === 'bridge')).toHaveLength(5)
    expect(scheduled.at(-1)).toMatchObject({
      id: 'reflux',
      orderIndex: 11,
      role: 'reflux',
      required: true,
      refluxSourceTaskId: source.id,
    })
  })

  it('keeps every pending reflux within five to eight tasks after another wrong answer', () => {
    const tasks = primaryTasks(5)
    const firstSource = requireTask(tasks, 0)
    const secondSource = requireTask(tasks, 1)
    const firstQueue = scheduleReflux({
      tasks,
      sourceTaskId: firstSource.id,
      gap: 8,
      createBridge: (index) => requiredTask(`bridge-first-${String(index)}`, 'bridge'),
      createReflux: () => requiredTask('reflux-first', 'reflux'),
    })
    const secondQueue = scheduleReflux({
      tasks: firstQueue,
      sourceTaskId: secondSource.id,
      gap: 5,
      createBridge: (index) => requiredTask(`bridge-second-${String(index)}`, 'bridge'),
      createReflux: () => requiredTask('reflux-second', 'reflux'),
    })

    for (const reflux of secondQueue.filter((task) => task.role === 'reflux')) {
      const sourceIndex = secondQueue.findIndex(
        (task) => task.id === reflux.refluxSourceTaskId,
      )
      const refluxIndex = secondQueue.findIndex((task) => task.id === reflux.id)
      const interveningCount = refluxIndex - sourceIndex - 1

      expect(interveningCount).toBeGreaterThanOrEqual(5)
      expect(interveningCount).toBeLessThanOrEqual(8)
    }
  })

  it.each([
    { gaps: [8, 5, 8, 5, 8] },
    { gaps: [5, 8, 5, 8, 5] },
    { gaps: [5, 6, 7, 8, 5] },
    { gaps: [8, 7, 6, 5, 8] },
  ])('keeps every obligation feasible through five consecutive wrong answers: $gaps', ({ gaps }) => {
    let tasks = primaryTasks(12)

    for (const [wrongIndex, gap] of gaps.entries()) {
      const source = getNextPendingTask(tasks)

      if (!source) throw new Error('Expected another pending source task')
      source.status = 'completed'
      tasks = scheduleReflux({
        tasks,
        sourceTaskId: source.id,
        gap,
        createBridge: (index) =>
          requiredTask(`bridge-${String(wrongIndex)}-${String(index)}`, 'bridge'),
        createReflux: () => requiredTask(`reflux-${String(wrongIndex)}`, 'reflux'),
      })

      expect(tasks.map((task) => task.orderIndex)).toEqual(
        Array.from({ length: tasks.length }, (_, index) => index + 1),
      )
      expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length)

      for (const reflux of tasks.filter(
        (task) => task.role === 'reflux' && task.status === 'pending',
      )) {
        const sourceIndex = tasks.findIndex(
          (task) => task.id === reflux.refluxSourceTaskId,
        )
        const refluxIndex = tasks.findIndex((task) => task.id === reflux.id)
        const interveningCount = refluxIndex - sourceIndex - 1

        expect(interveningCount).toBeGreaterThanOrEqual(5)
        expect(interveningCount).toBeLessThanOrEqual(8)
      }
    }
  })

  it('requires 80 percent of primary tasks and every required task before completion', () => {
    const tasks = primaryTasks(5)

    for (const task of tasks) task.status = 'completed'
    tasks.push({
      ...requiredTask('reflux', 'reflux'),
      orderIndex: 6,
      refluxSourceTaskId: 'primary-5',
    })

    expect(getLessonCompletionDecision(tasks)).toEqual({
      allowed: false,
      completedPrimary: 5,
      totalPrimary: 5,
      pendingRequiredTaskIds: ['reflux'],
      skippablePrimaryTaskIds: [],
    })

    requireTask(tasks, 5).status = 'completed'
    expect(getLessonCompletionDecision(tasks)).toMatchObject({ allowed: true })
  })

  it('identifies remaining primary tasks that can be atomically skipped', () => {
    const tasks = primaryTasks(5)

    for (const task of tasks.slice(0, 4)) task.status = 'completed'

    expect(getLessonCompletionDecision(tasks)).toEqual({
      allowed: true,
      completedPrimary: 4,
      totalPrimary: 5,
      pendingRequiredTaskIds: [],
      skippablePrimaryTaskIds: ['primary-5'],
    })
  })

  it('rejects a gap outside the frozen five-to-eight range', () => {
    expect(() =>
      scheduleReflux({
        tasks: primaryTasks(2),
        sourceTaskId: 'primary-1',
        gap: 4,
        createBridge: (index) => requiredTask(`bridge-${String(index)}`, 'bridge'),
        createReflux: () => requiredTask('reflux', 'reflux'),
      }),
    ).toThrow('Reflux gap must be between 5 and 8')
  })
})

const requiredTask = (id: string, role: 'bridge' | 'reflux'): QueueTask => ({
  id,
  orderIndex: 0,
  status: 'pending',
  role,
  required: true,
})

const requireTask = (tasks: QueueTask[], index: number): QueueTask => {
  const task = tasks[index]

  if (!task) throw new Error(`Expected task at index ${String(index)}`)

  return task
}
