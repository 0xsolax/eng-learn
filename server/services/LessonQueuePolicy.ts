import type {
  LessonTaskStatus,
  QueueDisposition,
  ReviewScore,
} from '../../shared/domain/course'
import type { LessonTaskRole } from '../../shared/api/taskSchemas'

export type LessonQueueTask = {
  id: string
  wordId: string
  orderIndex: number
  status: LessonTaskStatus
  role: LessonTaskRole
  required: boolean
  refluxSourceTaskId?: string
}

export type LessonQueueReviewLog = {
  taskId: string
  wordId: string
  score: ReviewScore
  queueDisposition?: QueueDisposition
}

export type LessonQueueSnapshotInput<TTask extends LessonQueueTask = LessonQueueTask> = {
  tasks: readonly TTask[]
  reviewLogs: readonly LessonQueueReviewLog[]
  suspendedWordIds: ReadonlySet<string>
}

export type LessonQueueFactories<TTask extends LessonQueueTask> = {
  sourceTaskId: string
  createReflux(source: TTask): TTask
  createBridge(source: TTask, index: number): TTask
}

export type WrongAnswerQueuePlan<TTask extends LessonQueueTask> = {
  disposition: QueueDisposition
  tasks: TTask[]
}

export type LessonQueueSchedulingProblem<TTask extends LessonQueueTask> = {
  snapshot: LessonQueueSnapshotInput<TTask>
  sourceTaskId: string
  recurrenceTask: TTask
  bridgeCandidates: readonly TTask[]
}

export const planWrongAnswer = <TTask extends LessonQueueTask>(
  snapshot: LessonQueueSnapshotInput<TTask>,
  factories: LessonQueueFactories<TTask>,
): WrongAnswerQueuePlan<TTask> => {
  validateLessonQueueSnapshot(snapshot)

  const ordered = [...snapshot.tasks].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  )
  const source = ordered.find((task) => task.id === factories.sourceTaskId)
  const current = ordered.find((task) => task.status === 'pending')

  if (!source || source.status !== 'pending' || current?.id !== source.id) {
    throw new Error('Wrong-answer source must be the first pending task')
  }

  const completedTasks = ordered.map((task) =>
    task.id === source.id
      ? ({ ...task, status: 'completed' })
      : task,
  )
  const scheduledCount = completedTasks.filter(
    (task) => task.wordId === source.wordId,
  ).length

  if (scheduledCount >= 3) {
    return { disposition: 'deferred_cap', tasks: completedTasks }
  }

  const lessonWordCount = new Set(
    completedTasks
      .filter((task) => task.role === 'primary')
      .map((task) => task.wordId),
  ).size

  if (lessonWordCount < 4) {
    return { disposition: 'deferred_capacity', tasks: completedTasks }
  }

  const recurrenceTask = withTaskMetadata(factories.createReflux(source), {
    wordId: source.wordId,
    status: 'pending',
    role: 'reflux',
    required: true,
    refluxSourceTaskId: source.id,
  })
  const taskCountByWord = countTasksByWord(completedTasks)
  const closedWordIds = deriveClosedWordIds(snapshot.reviewLogs)
  const openWordIds = deriveOpenWordIds(completedTasks, snapshot.reviewLogs)
  const pendingWordIds = new Set(
    completedTasks
      .filter((task) => task.status === 'pending')
      .map((task) => task.wordId),
  )
  const bridgeSources = completedTasks.filter(
    (task) =>
      task.role === 'primary' &&
      task.status === 'completed' &&
      task.wordId !== source.wordId &&
      !closedWordIds.has(task.wordId) &&
      !openWordIds.has(task.wordId) &&
      !snapshot.suspendedWordIds.has(task.wordId) &&
      !pendingWordIds.has(task.wordId) &&
      (taskCountByWord.get(task.wordId) ?? 0) < 3,
  )
  const bridgeCandidates = bridgeSources.map((bridgeSource, index) =>
    withTaskMetadata(factories.createBridge(bridgeSource, index + 1), {
      wordId: bridgeSource.wordId,
      status: 'pending',
      role: 'bridge',
      required: true,
    }),
  )
  const problem: LessonQueueSchedulingProblem<TTask> = {
    snapshot: {
      tasks: completedTasks,
      reviewLogs: snapshot.reviewLogs,
      suspendedWordIds: snapshot.suspendedWordIds,
    },
    sourceTaskId: source.id,
    recurrenceTask,
    bridgeCandidates,
  }

  if (!isQueueFeasible(problem)) {
    return { disposition: 'deferred_capacity', tasks: completedTasks }
  }

  const tasks = buildSchedule(problem)

  if (!tasks) {
    throw new Error('Queue invariant violation: feasible schedule was not built')
  }

  return { disposition: 'scheduled', tasks }
}

export const isQueueFeasible = <TTask extends LessonQueueTask>(
  problem: LessonQueueSchedulingProblem<TTask>,
): boolean => {
  const model = createSchedulingModel(problem)

  if (!model) return false

  for (let lastSlot = model.nextSlot; lastSlot <= model.maximumDeadline; lastSlot += 1) {
    const slotCount = lastSlot - model.nextSlot + 1
    const fillerCount = slotCount - model.jobs.length

    if (
      fillerCount < 0 ||
      fillerCount > model.existingFillers.length + model.bridgeCandidates.length
    ) {
      continue
    }

    const slots = Array.from(
      { length: slotCount },
      (_, index) => model.nextSlot + index,
    )

    if (hasCompleteIntervalMatching(model.jobs, slots)) return true
  }

  return false
}

export const buildSchedule = <TTask extends LessonQueueTask>(
  problem: LessonQueueSchedulingProblem<TTask>,
): TTask[] | undefined => {
  const model = createSchedulingModel(problem)

  if (!model) return undefined

  const candidates: Array<{
    lastSlot: number
    assignment: Map<number, TTask>
    bridgeCount: number
    usedExistingCount: number
  }> = []

  for (let lastSlot = model.nextSlot; lastSlot <= model.maximumDeadline; lastSlot += 1) {
    const slotCount = lastSlot - model.nextSlot + 1
    const fillerCount = slotCount - model.jobs.length

    if (
      fillerCount < 0 ||
      fillerCount > model.existingFillers.length + model.bridgeCandidates.length
    ) {
      continue
    }

    const assignment = assignJobsToLatestSlots(
      model.jobs,
      model.nextSlot,
      lastSlot,
    )

    if (!assignment) continue

    const usedExistingCount = Math.min(fillerCount, model.existingFillers.length)
    candidates.push({
      lastSlot,
      assignment,
      bridgeCount: fillerCount - usedExistingCount,
      usedExistingCount,
    })
  }

  candidates.sort(
    (left, right) =>
      left.bridgeCount - right.bridgeCount ||
      right.usedExistingCount - left.usedExistingCount ||
      left.lastSlot - right.lastSlot,
  )
  const selected = candidates[0]

  if (!selected) return undefined

  const existingFillers = [...model.existingFillers]
  const bridgeCandidates = [...model.bridgeCandidates]
  const scheduledTail: TTask[] = []

  for (let slot = model.nextSlot; slot <= selected.lastSlot; slot += 1) {
    const job = selected.assignment.get(slot)

    if (job) {
      scheduledTail.push(job)
      continue
    }

    const filler = existingFillers.shift() ?? bridgeCandidates.shift()

    if (!filler) return undefined
    scheduledTail.push(filler)
  }

  const scheduledIds = new Set(scheduledTail.map((task) => task.id))
  const remainingPending = model.allPending.filter(
    (task) => !scheduledIds.has(task.id),
  )
  const combined = [...model.fixedPrefix, ...scheduledTail, ...remainingPending]

  return combined.map((task, index) =>
    task.orderIndex === index + 1
      ? task
      : ({ ...task, orderIndex: index + 1 }),
  )
}

export const validateLessonQueueSnapshot = <TTask extends LessonQueueTask>(
  snapshot: LessonQueueSnapshotInput<TTask>,
): void => {
  const ordered = [...snapshot.tasks].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  )
  const ids = new Set<string>()
  const primaryWordIds = new Set(
    ordered.filter((task) => task.role === 'primary').map((task) => task.wordId),
  )
  const pendingWordIds = new Set<string>()
  let pendingPrefixStarted = false

  for (const [index, task] of ordered.entries()) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate lesson task ${task.id}`)
    }

    ids.add(task.id)

    if (task.orderIndex !== index + 1) {
      throw new Error('Lesson task order must be contiguous')
    }

    if (task.status === 'pending') {
      pendingPrefixStarted = true

      if (pendingWordIds.has(task.wordId)) {
        throw new Error(`Word ${task.wordId} has two pending tasks`)
      }

      pendingWordIds.add(task.wordId)
    } else if (pendingPrefixStarted) {
      throw new Error('Completed and skipped tasks must stay in the immutable prefix')
    }

    if (task.role !== 'primary' && !primaryWordIds.has(task.wordId)) {
      throw new Error(`Task ${task.id} is outside the frozen lesson word set`)
    }
  }

  if (ordered.length > primaryWordIds.size * 3) {
    throw new Error('Lesson task count exceeds three times the frozen lesson word set')
  }

  const tasksById = new Map(ordered.map((task) => [task.id, task]))
  const childTasksBySource = new Map<string, TTask[]>()
  const taskCountByWord = new Map<string, number>()

  for (const task of ordered) {
    const taskCount = (taskCountByWord.get(task.wordId) ?? 0) + 1
    taskCountByWord.set(task.wordId, taskCount)

    if (taskCount > 3) {
      throw new Error(`Word ${task.wordId} has more than three tasks`)
    }

    if (task.role !== 'reflux') {
      if (task.refluxSourceTaskId !== undefined) {
        throw new Error(`Non-reflux task ${task.id} has a reflux source`)
      }
      continue
    }

    if (!task.refluxSourceTaskId) {
      throw new Error(`Reflux task ${task.id} has no source`)
    }

    const source = tasksById.get(task.refluxSourceTaskId)

    if (!source || source.wordId !== task.wordId) {
      throw new Error(`Reflux task ${task.id} has an invalid source`)
    }

    const children = childTasksBySource.get(source.id) ?? []
    children.push(task)
    childTasksBySource.set(source.id, children)
  }

  const reviewLogsByTaskId = new Map<string, LessonQueueReviewLog>()

  for (const reviewLog of snapshot.reviewLogs) {
    const source = tasksById.get(reviewLog.taskId)

    if (!source || source.wordId !== reviewLog.wordId) {
      throw new Error(`Review log for ${reviewLog.taskId} has an invalid task`)
    }

    if (source.status !== 'completed') {
      throw new Error(`Review log ${reviewLog.taskId} must reference a completed task`)
    }

    if (reviewLogsByTaskId.has(reviewLog.taskId)) {
      throw new Error(`Task ${reviewLog.taskId} has duplicate review logs`)
    }

    reviewLogsByTaskId.set(reviewLog.taskId, reviewLog)

    if (reviewLog.score < 2 && reviewLog.queueDisposition === undefined) {
      throw new Error(`Wrong answer ${reviewLog.taskId} requires a queue disposition`)
    }

    if (reviewLog.score >= 2 && reviewLog.queueDisposition !== undefined) {
      throw new Error(`Passing answer ${reviewLog.taskId} cannot have a queue disposition`)
    }

    if (
      reviewLog.queueDisposition === 'deferred_cap' ||
      reviewLog.queueDisposition === 'deferred_capacity'
    ) {
      const laterSameWord = ordered.find(
        (task) =>
          task.orderIndex > source.orderIndex && task.wordId === source.wordId,
      )

      if (laterSameWord) {
        throw new Error(`Word ${source.wordId} is closed after ${source.id}`)
      }
    }

    if (reviewLog.queueDisposition !== 'scheduled') continue

    const children = childTasksBySource.get(source.id) ?? []

    if (children.length !== 1) {
      throw new Error(`Scheduled source ${source.id} must have one reflux child`)
    }

    const child = children[0]

    if (!child) {
      throw new Error(`Scheduled source ${source.id} must have one reflux child`)
    }

    const firstLaterSameWord = ordered.find(
      (task) => task.orderIndex > source.orderIndex && task.wordId === source.wordId,
    )

    if (firstLaterSameWord?.id !== child.id) {
      throw new Error(
        `Scheduled source ${source.id} first later same-word task must be its reflux child`,
      )
    }

    const sourceIndex = ordered.indexOf(source)
    const childIndex = ordered.indexOf(child)
    const interveningCount = ordered
      .slice(sourceIndex + 1, childIndex)
      .filter((task) =>
        child.status === 'completed'
          ? task.status === 'completed'
          : task.status !== 'skipped',
      ).length

    if (interveningCount < 3 || interveningCount > 6) {
      throw new Error(
        `Reflux child ${child.id} must follow three to six completed tasks`,
      )
    }
  }

  for (const task of ordered) {
    if (task.status === 'completed' && !reviewLogsByTaskId.has(task.id)) {
      throw new Error(`Completed task ${task.id} has no review log`)
    }

    if (task.role === 'reflux') {
      const sourceLog = task.refluxSourceTaskId
        ? reviewLogsByTaskId.get(task.refluxSourceTaskId)
        : undefined

      if (sourceLog?.queueDisposition !== 'scheduled') {
        throw new Error(`Reflux task ${task.id} has no scheduled source answer`)
      }
    }
  }
}

type SchedulingJob<TTask extends LessonQueueTask> = {
  task: TTask
  release: number
  deadline: number
}

type SchedulingModel<TTask extends LessonQueueTask> = {
  fixedPrefix: TTask[]
  allPending: TTask[]
  jobs: Array<SchedulingJob<TTask>>
  existingFillers: TTask[]
  bridgeCandidates: TTask[]
  nextSlot: number
  maximumDeadline: number
}

const createSchedulingModel = <TTask extends LessonQueueTask>(
  problem: LessonQueueSchedulingProblem<TTask>,
): SchedulingModel<TTask> | undefined => {
  const ordered = [...problem.snapshot.tasks].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  )
  const firstPendingIndex = ordered.findIndex((task) => task.status === 'pending')
  const fixedPrefix = firstPendingIndex < 0 ? ordered : ordered.slice(0, firstPendingIndex)
  const persistedPending = firstPendingIndex < 0 ? [] : ordered.slice(firstPendingIndex)

  if (persistedPending.some((task) => task.status !== 'pending')) return undefined

  const existingIds = new Set(ordered.map((task) => task.id))

  if (existingIds.has(problem.recurrenceTask.id)) return undefined

  const candidateIds = new Set<string>()

  for (const candidate of problem.bridgeCandidates) {
    if (existingIds.has(candidate.id) || candidateIds.has(candidate.id)) return undefined
    candidateIds.add(candidate.id)
  }

  const allPending = [...persistedPending, problem.recurrenceTask]
  const sourceRankById = new Map<string, number>()
  const tasksById = new Map(ordered.map((task) => [task.id, task]))
  let completedRank = 0

  for (const task of fixedPrefix) {
    if (task.status !== 'completed') continue
    completedRank += 1
    sourceRankById.set(task.id, completedRank)
  }

  const recurrenceTasks = allPending.filter((task) => task.role === 'reflux')
  const seenSourceIds = new Set<string>()
  const jobs: Array<SchedulingJob<TTask>> = []

  for (const task of recurrenceTasks) {
    const sourceTaskId = task.refluxSourceTaskId
    const source = sourceTaskId ? tasksById.get(sourceTaskId) : undefined
    const sourceRank = sourceTaskId ? sourceRankById.get(sourceTaskId) : undefined

    if (
      !sourceTaskId ||
      !source ||
      source.status !== 'completed' ||
      source.wordId !== task.wordId ||
      sourceRank === undefined ||
      seenSourceIds.has(sourceTaskId)
    ) {
      return undefined
    }

    seenSourceIds.add(sourceTaskId)
    jobs.push({ task, release: sourceRank + 4, deadline: sourceRank + 7 })
  }

  if (jobs.length === 0) return undefined

  const jobIds = new Set(jobs.map((job) => job.task.id))
  const openWordIds = new Set(jobs.map((job) => job.task.wordId))
  const existingFillers = persistedPending.filter(
    (task) => !jobIds.has(task.id) && !openWordIds.has(task.wordId),
  )
  const bridgeCandidates = problem.bridgeCandidates.filter(
    (task) => !openWordIds.has(task.wordId),
  )

  return {
    fixedPrefix,
    allPending,
    jobs,
    existingFillers,
    bridgeCandidates,
    nextSlot: completedRank + 1,
    maximumDeadline: Math.max(...jobs.map((job) => job.deadline)),
  }
}

const hasCompleteIntervalMatching = <TTask extends LessonQueueTask>(
  jobs: Array<SchedulingJob<TTask>>,
  slots: number[],
): boolean => {
  const matchedJobBySlot = new Map<number, number>()
  const orderedJobs = jobs
    .map((job, index) => ({ job, index }))
    .sort(
      (left, right) =>
        left.job.deadline - right.job.deadline ||
        left.job.release - right.job.release ||
        left.job.task.id.localeCompare(right.job.task.id),
    )

  const match = (jobIndex: number, visitedSlots: Set<number>): boolean => {
    const job = jobs[jobIndex]

    if (!job) return false

    for (const slot of slots) {
      if (
        slot < job.release ||
        slot > job.deadline ||
        visitedSlots.has(slot)
      ) {
        continue
      }

      visitedSlots.add(slot)
      const occupyingJob = matchedJobBySlot.get(slot)

      if (occupyingJob === undefined || match(occupyingJob, visitedSlots)) {
        matchedJobBySlot.set(slot, jobIndex)
        return true
      }
    }

    return false
  }

  return orderedJobs.every(({ index }) => match(index, new Set()))
}

const assignJobsToLatestSlots = <TTask extends LessonQueueTask>(
  jobs: Array<SchedulingJob<TTask>>,
  firstSlot: number,
  lastSlot: number,
): Map<number, TTask> | undefined => {
  const availableSlots = new Set(
    Array.from({ length: lastSlot - firstSlot + 1 }, (_, index) => firstSlot + index),
  )
  const assignment = new Map<number, TTask>()
  const orderedJobs = [...jobs].sort(
    (left, right) =>
      right.release - left.release ||
      right.deadline - left.deadline ||
      left.task.id.localeCompare(right.task.id),
  )

  for (const job of orderedJobs) {
    let selectedSlot: number | undefined

    for (let slot = Math.min(lastSlot, job.deadline); slot >= job.release; slot -= 1) {
      if (availableSlots.has(slot)) {
        selectedSlot = slot
        break
      }
    }

    if (selectedSlot === undefined) return undefined
    availableSlots.delete(selectedSlot)
    assignment.set(selectedSlot, job.task)
  }

  return assignment
}

const countTasksByWord = (
  tasks: readonly LessonQueueTask[],
): Map<string, number> => {
  const counts = new Map<string, number>()

  for (const task of tasks) {
    counts.set(task.wordId, (counts.get(task.wordId) ?? 0) + 1)
  }

  return counts
}

const deriveClosedWordIds = (
  reviewLogs: readonly LessonQueueReviewLog[],
): Set<string> =>
  new Set(
    reviewLogs
      .filter(
        (log) =>
          log.queueDisposition === 'deferred_cap' ||
          log.queueDisposition === 'deferred_capacity',
      )
      .map((log) => log.wordId),
  )

const deriveOpenWordIds = (
  tasks: readonly LessonQueueTask[],
  reviewLogs: readonly LessonQueueReviewLog[],
): Set<string> => {
  const pendingSources = new Set(
    tasks
      .filter((task) => task.role === 'reflux' && task.status === 'pending')
      .map((task) => task.refluxSourceTaskId)
      .filter((sourceTaskId): sourceTaskId is string => sourceTaskId !== undefined),
  )

  return new Set(
    reviewLogs
      .filter(
        (log) =>
          log.queueDisposition === 'scheduled' && pendingSources.has(log.taskId),
      )
      .map((log) => log.wordId),
  )
}

const withTaskMetadata = <TTask extends LessonQueueTask>(
  task: TTask,
  metadata: Pick<
    LessonQueueTask,
    'wordId' | 'status' | 'role' | 'required'
  > & { refluxSourceTaskId?: string },
): TTask => ({ ...task, ...metadata })
