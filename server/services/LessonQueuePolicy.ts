import type {
  LessonTaskStatus,
  QueueCapacityReason,
  QueueDisposition,
  ReviewScore,
} from '../../shared/domain/course'
import type { LessonTaskRole } from '../../shared/api/taskSchemas'
import type { WordStage } from '../../shared/domain/content'

export const LESSON_QUEUE_LIMITS = Object.freeze({
  maxTasksPerWordPerLesson: 3,
  maxPlannedReinforcements: 3,
  plannedGapMinimum: 2,
  plannedGapMaximum: 4,
  wrongGapMinimum: 3,
  wrongGapMaximum: 6,
})

export type LessonQueueTask = {
  id: string
  wordId: string
  stage?: WordStage
  orderIndex: number
  status: LessonTaskStatus
  role: LessonTaskRole
  required: boolean
  refluxSourceTaskId?: string
  reinforcementSourceTaskId?: string
}

export type LessonQueueReviewLog = {
  taskId: string
  wordId: string
  score: ReviewScore
  queueDisposition?: QueueDisposition
  queueCapacityReason?: QueueCapacityReason
}

export type LessonQueueSnapshotInput<TTask extends LessonQueueTask = LessonQueueTask> = {
  tasks: readonly TTask[]
  reviewLogs: readonly LessonQueueReviewLog[]
  suspendedWordIds: ReadonlySet<string>
  maximumTaskCount?: number
  requireCapacityReasons?: boolean
}

export type LessonQueueFactories<TTask extends LessonQueueTask> = {
  sourceTaskId: string
  createReflux(source: TTask): TTask
  createBridge(source: TTask, index: number): TTask
  maximumTaskCount?: number
}

export type WrongAnswerQueuePlan<TTask extends LessonQueueTask> = {
  disposition: QueueDisposition
  capacityReason?: QueueCapacityReason
  tasks: TTask[]
}

export type PlannedReinforcementFactories<TTask extends LessonQueueTask> = {
  newWordIds: readonly string[]
  maximumTaskCount: number
  createReinforcement(source: TTask): TTask
}

export type PlannedReinforcementQueuePlan<TTask extends LessonQueueTask> = {
  tasks: TTask[]
  createdSourceTaskId?: string
}

export type LessonQueueSchedulingProblem<TTask extends LessonQueueTask> = {
  snapshot: LessonQueueSnapshotInput<TTask>
  sourceTaskId: string
  recurrenceTask: TTask
  bridgeCandidates: readonly TTask[]
  maximumTaskCount?: number
  preferEarliestCompletion?: boolean
}

export const planWrongAnswer = <TTask extends LessonQueueTask>(
  snapshot: LessonQueueSnapshotInput<TTask>,
  factories: LessonQueueFactories<TTask>,
): WrongAnswerQueuePlan<TTask> => {
  validateLessonQueueSnapshot(snapshot)

  const ordered = [...snapshot.tasks].sort(compareTaskOrder)
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

  if (scheduledCount >= LESSON_QUEUE_LIMITS.maxTasksPerWordPerLesson) {
    return { disposition: 'deferred_cap', tasks: completedTasks }
  }

  if (
    factories.maximumTaskCount !== undefined &&
    completedTasks.length >= factories.maximumTaskCount
  ) {
    return {
      disposition: 'deferred_capacity',
      capacityReason: 'lesson_task_budget',
      tasks: completedTasks,
    }
  }

  const lessonWordCount = new Set(
    completedTasks
      .filter((task) => task.role === 'primary')
      .map((task) => task.wordId),
  ).size

  if (lessonWordCount < LESSON_QUEUE_LIMITS.wrongGapMinimum + 1) {
    return {
      disposition: 'deferred_capacity',
      ...(factories.maximumTaskCount === undefined
        ? {}
        : { capacityReason: 'short_pool' as const }),
      tasks: completedTasks,
    }
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
      (taskCountByWord.get(task.wordId) ?? 0) <
        LESSON_QUEUE_LIMITS.maxTasksPerWordPerLesson,
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
    return {
      disposition: 'deferred_capacity',
      ...(factories.maximumTaskCount === undefined
        ? {}
        : { capacityReason: 'interval_infeasible' as const }),
      tasks: completedTasks,
    }
  }

  const boundedProblem = {
    ...problem,
    ...(factories.maximumTaskCount === undefined
      ? {}
      : { maximumTaskCount: factories.maximumTaskCount }),
  }

  if (!isQueueFeasible(boundedProblem)) {
    return {
      disposition: 'deferred_capacity',
      capacityReason: 'lesson_task_budget',
      tasks: completedTasks,
    }
  }

  const tasks = buildSchedule(boundedProblem)

  if (!tasks) {
    throw new Error('Queue invariant violation: feasible schedule was not built')
  }

  return { disposition: 'scheduled', tasks }
}

export const planPlannedReinforcement = <TTask extends LessonQueueTask>(
  snapshot: LessonQueueSnapshotInput<TTask>,
  factories: PlannedReinforcementFactories<TTask>,
): PlannedReinforcementQueuePlan<TTask> => {
  validateLessonQueueSnapshot(snapshot)

  if (snapshot.tasks.length >= factories.maximumTaskCount) {
    return { tasks: [...snapshot.tasks].sort(compareTaskOrder) }
  }

  const ordered = [...snapshot.tasks].sort(compareTaskOrder)
  const tasksById = new Map(ordered.map((task) => [task.id, task]))
  const logsByTaskId = new Map(snapshot.reviewLogs.map((log) => [log.taskId, log]))
  const newWordIds = new Set(factories.newWordIds)
  const sourcesWithChildren = new Set(
    ordered
      .map((task) => task.reinforcementSourceTaskId)
      .filter((sourceId): sourceId is string => sourceId !== undefined),
  )
  const passingSources = ordered
    .filter((task) => {
      const log = logsByTaskId.get(task.id)

      return (
        task.role === 'primary' &&
        task.stage === 'S0' &&
        task.status === 'completed' &&
        newWordIds.has(task.wordId) &&
        log !== undefined &&
        log.score >= 2
      )
    })
    .slice(0, LESSON_QUEUE_LIMITS.maxPlannedReinforcements)
  const taskCountByWord = countTasksByWord(ordered)
  const pendingWordIds = new Set(
    ordered
      .filter((task) => task.status === 'pending')
      .map((task) => task.wordId),
  )

  for (const [sourceIndex, source] of passingSources.entries()) {
    if (
      sourcesWithChildren.has(source.id) ||
      snapshot.suspendedWordIds.has(source.wordId) ||
      pendingWordIds.has(source.wordId) ||
      ordered.some(
        (task) =>
          task.orderIndex > source.orderIndex &&
          task.wordId === source.wordId,
      ) ||
      (taskCountByWord.get(source.wordId) ?? 0) >=
        LESSON_QUEUE_LIMITS.maxTasksPerWordPerLesson
    ) {
      continue
    }

    const targetGap = sourceIndex + LESSON_QUEUE_LIMITS.plannedGapMinimum
    const completedGap = ordered.filter((task) =>
      task.orderIndex > source.orderIndex &&
      task.status === 'completed' &&
      logsByTaskId.has(task.id),
    ).length

    if (
      completedGap < targetGap ||
      completedGap > LESSON_QUEUE_LIMITS.plannedGapMaximum
    ) continue

    const reinforcementTask = withTaskMetadata(
      factories.createReinforcement(source),
      {
        wordId: source.wordId,
        status: 'pending',
        role: 'bridge',
        required: true,
        reinforcementSourceTaskId: source.id,
      },
    )
    const problem: LessonQueueSchedulingProblem<TTask> = {
      snapshot,
      sourceTaskId: source.id,
      recurrenceTask: reinforcementTask,
      bridgeCandidates: [],
      maximumTaskCount: factories.maximumTaskCount,
      preferEarliestCompletion: true,
    }
    const tasks = buildSchedule(problem)

    if (!tasks) continue

    const persistedSource = tasksById.get(source.id)

    if (!persistedSource) continue

    return { tasks, createdSourceTaskId: persistedSource.id }
  }

  return { tasks: ordered }
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

    const bridgeCount = Math.max(0, fillerCount - model.existingFillers.length)

    if (
      model.maximumTaskCount !== undefined &&
      model.fixedPrefix.length + model.allPending.length + bridgeCount >
        model.maximumTaskCount
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
    const bridgeCount = fillerCount - usedExistingCount

    if (
      model.maximumTaskCount !== undefined &&
      model.fixedPrefix.length + model.allPending.length + bridgeCount >
        model.maximumTaskCount
    ) {
      continue
    }

    candidates.push({
      lastSlot,
      assignment,
      bridgeCount,
      usedExistingCount,
    })
  }

  candidates.sort(
    (left, right) =>
      left.bridgeCount - right.bridgeCount ||
      (problem.preferEarliestCompletion === true
        ? left.lastSlot - right.lastSlot
        : right.usedExistingCount - left.usedExistingCount ||
          left.lastSlot - right.lastSlot),
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

  if (
    ordered.length >
      primaryWordIds.size * LESSON_QUEUE_LIMITS.maxTasksPerWordPerLesson
  ) {
    throw new Error('Lesson task count exceeds three times the frozen lesson word set')
  }

  if (
    snapshot.maximumTaskCount !== undefined &&
    ordered.length > snapshot.maximumTaskCount
  ) {
    throw new Error('Lesson task count exceeds the configured maximum')
  }

  const tasksById = new Map(ordered.map((task) => [task.id, task]))
  const refluxChildrenBySource = new Map<string, TTask[]>()
  const reinforcementChildrenBySource = new Map<string, TTask[]>()
  const taskCountByWord = new Map<string, number>()

  if (
    ordered.filter((task) => task.reinforcementSourceTaskId !== undefined).length >
      LESSON_QUEUE_LIMITS.maxPlannedReinforcements
  ) {
    throw new Error('Lesson has more than three planned reinforcements')
  }

  for (const task of ordered) {
    const taskCount = (taskCountByWord.get(task.wordId) ?? 0) + 1
    taskCountByWord.set(task.wordId, taskCount)

    if (taskCount > LESSON_QUEUE_LIMITS.maxTasksPerWordPerLesson) {
      throw new Error(`Word ${task.wordId} has more than three tasks`)
    }

    if (task.role !== 'reflux' && task.refluxSourceTaskId !== undefined) {
      throw new Error(`Non-reflux task ${task.id} has a reflux source`)
    }

    if (task.refluxSourceTaskId !== undefined) {
      const source = tasksById.get(task.refluxSourceTaskId)

      if (!source || source.wordId !== task.wordId) {
        throw new Error(`Reflux task ${task.id} has an invalid source`)
      }

      if (task.reinforcementSourceTaskId !== undefined) {
        throw new Error(`Task ${task.id} cannot have two queue sources`)
      }

      const children = refluxChildrenBySource.get(source.id) ?? []
      children.push(task)
      refluxChildrenBySource.set(source.id, children)
    } else if (task.role === 'reflux') {
      throw new Error(`Reflux task ${task.id} has no source`)
    }

    if (task.reinforcementSourceTaskId === undefined) continue

    const source = tasksById.get(task.reinforcementSourceTaskId)

    if (
      !source ||
      source.wordId !== task.wordId ||
      source.role !== 'primary' ||
      source.status !== 'completed' ||
      task.role !== 'bridge' ||
      !task.required
    ) {
      throw new Error(`Planned reinforcement ${task.id} has an invalid source`)
    }

    if (source.stage !== undefined && source.stage !== 'S0') {
      throw new Error(`Planned reinforcement source ${source.id} must be S0`)
    }

    if (task.stage !== undefined && task.stage !== 'S1') {
      throw new Error(`Planned reinforcement ${task.id} must be S1`)
    }

    const children = reinforcementChildrenBySource.get(source.id) ?? []
    children.push(task)
    reinforcementChildrenBySource.set(source.id, children)

    if (children.length > 1) {
      throw new Error(`Planned reinforcement source ${source.id} has two children`)
    }
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
      reviewLog.queueCapacityReason !== undefined &&
      reviewLog.queueDisposition !== 'deferred_capacity'
    ) {
      throw new Error(`Queue capacity reason for ${reviewLog.taskId} is inconsistent`)
    }

    if (
      snapshot.requireCapacityReasons === true &&
      reviewLog.queueDisposition === 'deferred_capacity' &&
      reviewLog.queueCapacityReason === undefined
    ) {
      throw new Error(`Capacity defer ${reviewLog.taskId} requires a reason`)
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

    const children = refluxChildrenBySource.get(source.id) ?? []

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

    if (
      interveningCount < LESSON_QUEUE_LIMITS.wrongGapMinimum ||
      interveningCount > LESSON_QUEUE_LIMITS.wrongGapMaximum
    ) {
      throw new Error(
        `Reflux child ${child.id} must follow three to six completed tasks`,
      )
    }
  }

  for (const [sourceId, children] of reinforcementChildrenBySource) {
    const source = tasksById.get(sourceId)
    const child = children[0]
    const sourceLog = reviewLogsByTaskId.get(sourceId)

    if (!source || !child || sourceLog === undefined || sourceLog.score < 2) {
      throw new Error(`Planned reinforcement source ${sourceId} must be passing`)
    }

    const firstLaterSameWord = ordered.find(
      (task) => task.orderIndex > source.orderIndex && task.wordId === source.wordId,
    )

    if (firstLaterSameWord?.id !== child.id) {
      throw new Error(
        `Planned reinforcement source ${source.id} first later same-word task must be its child`,
      )
    }

    const sourceIndex = ordered.indexOf(source)
    const childIndex = ordered.indexOf(child)
    const interveningCount = ordered
      .slice(sourceIndex + 1, childIndex)
      .filter((task) => task.status === 'completed' && reviewLogsByTaskId.has(task.id))
      .length

    if (
      interveningCount < LESSON_QUEUE_LIMITS.plannedGapMinimum ||
      interveningCount > LESSON_QUEUE_LIMITS.plannedGapMaximum
    ) {
      throw new Error(
        `Planned reinforcement ${child.id} must follow two to four completed tasks`,
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
  maximumTaskCount?: number
}

const createSchedulingModel = <TTask extends LessonQueueTask>(
  problem: LessonQueueSchedulingProblem<TTask>,
): SchedulingModel<TTask> | undefined => {
  const ordered = [...problem.snapshot.tasks].sort(compareTaskOrder)
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

  const queueTasks = allPending.filter(
    (task) => task.role === 'reflux' || task.reinforcementSourceTaskId !== undefined,
  )
  const seenJobKeys = new Set<string>()
  const jobs: Array<SchedulingJob<TTask>> = []

  for (const task of queueTasks) {
    const isPlanned = task.reinforcementSourceTaskId !== undefined
    const sourceTaskId = isPlanned
      ? task.reinforcementSourceTaskId
      : task.refluxSourceTaskId
    const source = sourceTaskId ? tasksById.get(sourceTaskId) : undefined
    const sourceRank = sourceTaskId ? sourceRankById.get(sourceTaskId) : undefined
    const jobKey = `${isPlanned ? 'planned' : 'wrong'}:${sourceTaskId ?? ''}`

    if (
      !sourceTaskId ||
      !source ||
      source.status !== 'completed' ||
      source.wordId !== task.wordId ||
      sourceRank === undefined ||
      seenJobKeys.has(jobKey)
    ) {
      return undefined
    }

    seenJobKeys.add(jobKey)
    jobs.push({
      task,
      release:
        sourceRank +
        (isPlanned
          ? LESSON_QUEUE_LIMITS.plannedGapMinimum + 1
          : LESSON_QUEUE_LIMITS.wrongGapMinimum + 1),
      deadline:
        sourceRank +
        (isPlanned
          ? LESSON_QUEUE_LIMITS.plannedGapMaximum + 1
          : LESSON_QUEUE_LIMITS.wrongGapMaximum + 1),
    })
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
    ...(problem.maximumTaskCount === undefined
      ? {}
      : { maximumTaskCount: problem.maximumTaskCount }),
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
  > & {
    refluxSourceTaskId?: string
    reinforcementSourceTaskId?: string
  },
): TTask => ({ ...task, ...metadata })

const compareTaskOrder = (
  left: Pick<LessonQueueTask, 'orderIndex' | 'id'>,
  right: Pick<LessonQueueTask, 'orderIndex' | 'id'>,
): number => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id)
