export type QueueTask = {
  id: string
  orderIndex: number
  status: 'pending' | 'completed' | 'skipped'
  role: 'primary' | 'bridge' | 'reflux'
  required: boolean
  refluxSourceTaskId?: string
}

export type LessonCompletionDecision = {
  allowed: boolean
  completedPrimary: number
  totalPrimary: number
  pendingRequiredTaskIds: string[]
  skippablePrimaryTaskIds: string[]
}

export const getNextPendingTask = <T extends QueueTask>(tasks: T[]): T | undefined =>
  [...tasks]
    .sort((left, right) => left.orderIndex - right.orderIndex)
    .find((task) => task.status === 'pending')

export const scheduleReflux = <T extends QueueTask>(input: {
  tasks: T[]
  sourceTaskId: string
  gap: number
  createBridge(index: number): T
  createReflux(): T
}): T[] => {
  if (!Number.isInteger(input.gap) || input.gap < 5 || input.gap > 8) {
    throw new Error('Reflux gap must be between 5 and 8')
  }

  const ordered = [...input.tasks].sort((left, right) => left.orderIndex - right.orderIndex)
  const sourceIndex = ordered.findIndex((task) => task.id === input.sourceTaskId)

  if (sourceIndex < 0) {
    throw new Error(`Reflux source task ${input.sourceTaskId} is missing`)
  }

  const source = ordered[sourceIndex]

  if (!source) {
    throw new Error(`Reflux source task ${input.sourceTaskId} is missing`)
  }

  const newReflux = withQueueMetadata(input.createReflux(), {
    role: 'reflux',
    required: true,
    refluxSourceTaskId: source.id,
  })
  const head = ordered.slice(0, sourceIndex + 1)
  const tail = ordered.slice(sourceIndex + 1)
  const pendingRefluxes = [
    ...tail.filter(
      (task) => task.role === 'reflux' && task.status === 'pending',
    ),
    newReflux,
  ]
  const pendingRefluxIds = new Set(pendingRefluxes.map((task) => task.id))
  const ordinaryTail = tail.filter((task) => !pendingRefluxIds.has(task.id))
  const constraints = pendingRefluxes.map((task, index) => {
    const refluxSourceTaskId = task.refluxSourceTaskId

    if (!refluxSourceTaskId) {
      throw new Error(`Reflux task ${task.id} has no source task`)
    }

    const refluxSourceIndex = ordered.findIndex(
      (candidate) => candidate.id === refluxSourceTaskId,
    )

    if (refluxSourceIndex < 0 || refluxSourceIndex > sourceIndex) {
      throw new Error(`Reflux source task ${refluxSourceTaskId} is not in the completed prefix`)
    }

    const minimumIndex = refluxSourceIndex + 6
    const maximumIndex = refluxSourceIndex + 9
    const currentIndex = task.id === newReflux.id
      ? refluxSourceIndex + input.gap + 1
      : ordered.findIndex((candidate) => candidate.id === task.id)

    return {
      task,
      minimumIndex,
      maximumIndex,
      preferredIndex: Math.max(minimumIndex, Math.min(maximumIndex, currentIndex)),
      stableIndex: index,
    }
  })
  const scheduledTail: T[] = []
  let ordinaryIndex = 0
  let bridgeIndex = 0

  while (constraints.length > 0) {
    const absoluteIndex = head.length + scheduledTail.length
    const eligible = constraints
      .filter((constraint) => constraint.minimumIndex <= absoluteIndex)
      .sort(
        (left, right) =>
          left.maximumIndex - right.maximumIndex ||
          left.preferredIndex - right.preferredIndex ||
          left.stableIndex - right.stableIndex,
      )
    const selected =
      eligible.find((constraint) => constraint.maximumIndex <= absoluteIndex) ??
      eligible.find((constraint) => constraint.preferredIndex <= absoluteIndex)

    if (selected) {
      scheduledTail.push(selected.task)
      constraints.splice(constraints.indexOf(selected), 1)
      continue
    }

    const ordinary = ordinaryTail[ordinaryIndex]

    if (ordinary) {
      scheduledTail.push(ordinary)
      ordinaryIndex += 1
      continue
    }

    bridgeIndex += 1
    scheduledTail.push(
      withQueueMetadata(input.createBridge(bridgeIndex), {
        role: 'bridge',
        required: true,
      }),
    )
  }

  const combined = [...head, ...scheduledTail, ...ordinaryTail.slice(ordinaryIndex)]

  return combined.map((task, index) => withOrderIndex(task, index + 1))
}

export const getLessonCompletionDecision = (tasks: QueueTask[]): LessonCompletionDecision => {
  const primaryTasks = tasks.filter((task) => task.role === 'primary')
  const completedPrimary = primaryTasks.filter((task) => task.status === 'completed').length
  const pendingRequiredTaskIds = tasks
    .filter((task) => task.required && task.status !== 'completed')
    .sort((left, right) => left.orderIndex - right.orderIndex)
    .map((task) => task.id)
  const hasPrimaryThreshold =
    primaryTasks.length > 0 && completedPrimary * 5 >= primaryTasks.length * 4
  const allowed = hasPrimaryThreshold && pendingRequiredTaskIds.length === 0

  return {
    allowed,
    completedPrimary,
    totalPrimary: primaryTasks.length,
    pendingRequiredTaskIds,
    skippablePrimaryTaskIds: allowed
      ? primaryTasks.filter((task) => task.status === 'pending').map((task) => task.id)
      : [],
  }
}

const withQueueMetadata = <T extends QueueTask>(
  task: T,
  metadata: Pick<QueueTask, 'role' | 'required'> & { refluxSourceTaskId?: string },
): T => ({
    ...task,
    ...metadata,
  })

const withOrderIndex = <T extends QueueTask>(task: T, orderIndex: number): T =>
  ({
    ...task,
    orderIndex,
  })
