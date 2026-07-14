import {
  exerciseItemContentSchema,
  lessonTaskSchema,
  previewSentenceOutputRequestSchema,
  submitTaskAnswerRequestSchema,
  type LessonTaskDto,
  type SentenceOutputPreview,
  type SentenceOutputPreviewRequest,
  type SubmitTaskAnswerRequest,
} from '../../shared/api/taskSchemas'
import type {
  CompletedLesson,
  CreatedCourse,
  StartedLesson,
  SubmittedTaskAnswer,
} from '../../shared/domain/course'
import { isPassingReviewScore } from '../../shared/domain/course'
import type {
  CourseRecord,
  CourseRepository,
  LessonSessionRecord,
  LessonTaskRecord,
  RecordAnswerInput,
  UserWordStateRecord,
} from '../repositories/courseRepository'
import type { ContentRepository, SourceVersionSnapshot } from '../repositories/contentRepository'
import { requireLearnerSafeExerciseItemContent } from '../errors/PersistedContentCompatibilityError'
import { DomainError } from '../errors/DomainError'
import { applyAnswerScore } from './StageEngine'
import {
  getLessonCompletionDecision,
  getNextPendingTask,
  scheduleReflux,
} from './lessonTaskQueue'
import {
  createTaskFeedback,
  evaluateTaskSubmission,
} from './taskEvaluation'
import type {
  AdminOperationLedgerReader,
  CreateCourseAdminOperation,
} from '../repositories/adminOperationLedger'
import { deriveAdminOperationAccessCode } from '../security/adminOperationCrypto'
import { hashAccessCode } from '../security/credentialCrypto'
import { findExactAdminOperation, prepareAdminOperation } from './adminOperation'
import type { RawAdminOperationToken } from '../../shared/security/adminOperationToken'

export type CourseRuntime = {
  createCourse(input: {
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse>
  createCourseIdempotently(input: {
    operationToken: string
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse>
  enterCourseByAccessCode(accessCode: string): Promise<CreatedCourse>
  startLesson(courseId: string): Promise<StartedLesson>
  getLesson(sessionId: string): Promise<StartedLesson>
  previewSentenceOutput(input: {
    sessionId: string
    taskId: string
    preview: SentenceOutputPreviewRequest
  }): Promise<SentenceOutputPreview>
  submitAnswer(input: {
    sessionId: string
    taskId: string
    submission: SubmitTaskAnswerRequest
  }): Promise<SubmittedTaskAnswer>
  completeLesson(sessionId: string): Promise<CompletedLesson>
}

export type CreateCourseRuntimeInput = {
  contentRepository: ContentRepository
  courseRepository: CourseRepository
  now: () => Date
  operationLedger?: AdminOperationLedgerReader
  selectRefluxGap?: () => number
}

export const createCourseRuntime = ({
  contentRepository,
  courseRepository,
  now,
  operationLedger,
  selectRefluxGap = selectDefaultRefluxGap,
}: CreateCourseRuntimeInput): CourseRuntime => {
  const createCourse = async (input: {
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse> => {
    const sourceVersion = await contentRepository.getSourceVersion(input.sourceVersionId)

    if (!sourceVersion || sourceVersion.version.status !== 'published') {
      throw new DomainError(
        'course_unavailable',
        'Courses can only bind published source versions',
      )
    }

    const createdAt = now().toISOString()
    const learnerId = crypto.randomUUID()

    return courseRepository.createCourse({
      learner: {
        id: learnerId,
        name: input.learnerName,
        accessCode: createAccessCode(),
        createdAt,
      },
      course: {
        id: crypto.randomUUID(),
        learnerId,
        sourceVersionId: input.sourceVersionId,
        currentLessonNo: 1,
        status: 'active',
        createdAt,
      },
    })
  }

  const createCourseIdempotently = async (input: {
    operationToken: string
    learnerName: string
    sourceVersionId: string
  }): Promise<CreatedCourse> => {
    if (!operationLedger) {
      throw new Error('Admin operation ledger is required')
    }

    const request = {
      kind: 'create_course' as const,
      learnerName: input.learnerName,
      sourceVersionId: input.sourceVersionId,
    }
    const prepared = await prepareAdminOperation(input.operationToken, request)
    const expected = {
      kind: 'create_course' as const,
      targetId: input.sourceVersionId,
    }
    const existing = await findExactAdminOperation(operationLedger, prepared, expected)

    if (existing) {
      if (existing.kind !== 'create_course') {
        throw new Error('Matched create-course operation has an invalid kind')
      }

      return replayCreatedCourse(courseRepository, prepared.token, existing)
    }

    const sourceVersion = await contentRepository.getSourceVersion(input.sourceVersionId)

    if (!sourceVersion || sourceVersion.version.status !== 'published') {
      throw new DomainError(
        'course_unavailable',
        'Courses can only bind published source versions',
      )
    }

    const createdAt = now().toISOString()
    const learnerId = crypto.randomUUID()
    const courseId = crypto.randomUUID()
    const accessCode = await deriveAdminOperationAccessCode('create_course', prepared.token)
    const adminOperation: CreateCourseAdminOperation = {
      operationHash: prepared.operationHash,
      kind: 'create_course',
      targetId: input.sourceVersionId,
      requestFingerprint: prepared.requestFingerprint,
      outcomeLearnerId: learnerId,
      outcomeCourseId: courseId,
      outcomeCredentialVersion: 1,
      createdAt,
    }

    try {
      return await courseRepository.createCourse({
        learner: {
          id: learnerId,
          name: input.learnerName,
          accessCode,
          createdAt,
        },
        course: {
          id: courseId,
          learnerId,
          sourceVersionId: input.sourceVersionId,
          currentLessonNo: 1,
          status: 'active',
          createdAt,
        },
        adminOperation,
      })
    } catch (error) {
      const raced = await findExactAdminOperation(operationLedger, prepared, expected)

      if (raced?.kind === 'create_course') {
        return replayCreatedCourse(courseRepository, prepared.token, raced)
      }

      throw error
    }
  }

  const startLesson = async (courseId: string): Promise<StartedLesson> => {
    const initialCourse = await courseRepository.getCourse(courseId)

    if (!initialCourse) {
      throw new DomainError('not_found', `Course ${courseId} is missing`)
    }

    let course = initialCourse

    for (;;) {
      requireActiveCourse(course)

      const existing = await courseRepository.getStartedLesson(
        course.id,
        course.currentLessonNo,
      )

      if (existing) {
        return existing
      }

      const sourceVersion = await contentRepository.getSourceVersion(course.sourceVersionId)

      if (!sourceVersion || sourceVersion.version.status !== 'published') {
        throw new DomainError('course_unavailable', 'Course source version is not available')
      }

      const existingStates = await courseRepository.getWordStates(course.id)
      const dueStates = existingStates.filter(
        (state) =>
          state.status !== 'suspended' && state.nextDueLessonNo <= course.currentLessonNo,
      )
      const activatedGroupIds = new Set(existingStates.map((state) => state.groupId))
      const nextGroup = sourceVersion.groups.find((group) => !activatedGroupIds.has(group.id))

      if (existingStates.length === 0 && !nextGroup) {
        throw new DomainError('course_unavailable', 'Course source version has no word groups')
      }

      if (dueStates.length === 0 && !nextGroup) {
        const nextDueLessonNo = existingStates.reduce<number | undefined>(
          (minimum, state) =>
            state.status === 'suspended' || state.nextDueLessonNo <= course.currentLessonNo
              ? minimum
              : minimum === undefined
                ? state.nextDueLessonNo
                : Math.min(minimum, state.nextDueLessonNo),
          undefined,
        )

        if (nextDueLessonNo === undefined) {
          throw new DomainError('course_unavailable', 'Course has no schedulable words')
        }

        const advanced = await courseRepository.advanceCourseLessonNo({
          courseId: course.id,
          expectedLessonNo: course.currentLessonNo,
          nextLessonNo: nextDueLessonNo,
        })

        if (!advanced || advanced.currentLessonNo <= course.currentLessonNo) {
          throw new DomainError('conflict', 'Course lesson number could not be advanced')
        }

        course = advanced
        continue
      }

      const createdAt = now().toISOString()
      const sessionId = crypto.randomUUID()
      const nextGroupWords = nextGroup
        ? sourceVersion.words.filter(
            (word) =>
              word.orderIndex >= nextGroup.startOrderIndex &&
              word.orderIndex <= nextGroup.endOrderIndex,
          )
        : []
      const initialStates = nextGroup
        ? nextGroupWords.map<UserWordStateRecord>((word) =>
            createInitialWordState({
              courseId: course.id,
              wordId: word.id,
              groupId: nextGroup.id,
              lessonNo: course.currentLessonNo,
              createdAt,
            }),
          )
        : []
      const dueTasks = dueStates.map((state, index) =>
        createLessonTask({
          sourceVersion,
          state,
          sessionId,
          orderIndex: index + 1,
          createdAt,
        }),
      )
      const newTasks = initialStates.map((state, index) =>
        createLessonTask({
          sourceVersion,
          state,
          sessionId,
          orderIndex: dueTasks.length + index + 1,
          createdAt,
        }),
      )
      const tasks = [...dueTasks, ...newTasks]

      if (tasks.length === 0) {
        throw new DomainError('course_unavailable', 'Lesson has no schedulable tasks')
      }

      return courseRepository.createLesson({
        session: {
          id: sessionId,
          courseId: course.id,
          lessonNo: course.currentLessonNo,
          status: 'started',
          taskCount: tasks.length,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt: createdAt,
        },
        tasks,
        wordStates: initialStates,
      })
    }
  }

  const getLesson = async (sessionId: string): Promise<StartedLesson> => {
    const session = await requireLessonSession(courseRepository, sessionId)
    await requireActiveCourseById(courseRepository, session.courseId)
    const tasks = await courseRepository.getLessonTasks(session.id)

    return toStartedLesson(session, tasks)
  }

  const enterCourseByAccessCode = async (accessCode: string): Promise<CreatedCourse> => {
    const course = await courseRepository.getCourseByAccessCode(accessCode)

    if (!course) {
      throw new DomainError('invalid_access_code', 'Course access code is invalid')
    }

    requireActiveCourse(course.course)

    return course
  }

  const previewSentenceOutput = async (input: {
    sessionId: string
    taskId: string
    preview: SentenceOutputPreviewRequest
  }): Promise<SentenceOutputPreview> => {
    const preview = previewSentenceOutputRequestSchema.parse(input.preview)
    const { session, task } = await requireSessionTask(courseRepository, input)

    if (task.taskType !== 'sentence_output') {
      throw new DomainError(
        'task_type_mismatch',
        'Only sentence-output tasks support a reference preview',
      )
    }

    if (task.draftAnswer !== undefined || task.referenceRevealedAt !== undefined) {
      if (task.draftAnswer !== preview.draft || task.referenceRevealedAt === undefined) {
        throw new DomainError('conflict', 'Sentence output preview is already fixed')
      }

      return {
        taskId: task.id,
        draft: task.draftAnswer,
        referenceSentence: task.answer.referenceSentence,
        revealedAt: task.referenceRevealedAt,
      }
    }

    await requireCurrentTask(courseRepository, session.id, task.id)

    const saved = await courseRepository.saveSentenceOutputPreview({
      sessionId: session.id,
      courseId: session.courseId,
      taskId: task.id,
      draft: preview.draft,
      revealedAt: now().toISOString(),
    })

    if (!saved) {
      throw new DomainError('conflict', 'Sentence output preview could not be persisted')
    }

    return saved
  }

  const submitAnswer = async (input: {
    sessionId: string
    taskId: string
    submission: SubmitTaskAnswerRequest
  }): Promise<SubmittedTaskAnswer> => {
    const submission = submitTaskAnswerRequestSchema.parse(input.submission)
    const { session, task } = await requireSessionTask(courseRepository, input)
    const existing = await courseRepository.getSubmittedAnswer(session.id, task.id)

    if (existing) {
      return {
        ...existing,
        feedback: createTaskFeedback(task, existing.reviewLog.score),
      }
    }

    const lessonTasks = await courseRepository.getLessonTasks(session.id)
    const currentTask = getNextPendingTask(lessonTasks)

    if (!currentTask || currentTask.id !== task.id) {
      throw new DomainError('task_not_current', 'Only the first pending task can be answered')
    }

    const evaluation = evaluateTaskSubmission(task, submission)

    if (
      task.taskType === 'sentence_output' &&
      (task.draftAnswer === undefined ||
        task.referenceRevealedAt === undefined ||
        submission.taskType !== 'sentence_output' ||
        submission.draft !== task.draftAnswer)
    ) {
      throw new DomainError(
        's5_preview_required',
        'Preview the persisted sentence draft before self-scoring',
      )
    }

    const wordState = await courseRepository.getWordState(task.courseId, task.wordId)

    if (!wordState) {
      throw new DomainError('not_found', `Word state is missing for ${task.wordId}`)
    }

    const createdAt = now().toISOString()
    const advanceWordState = task.role === 'primary'
    const updatedWordState = advanceWordState
      ? applyAnswerScore(wordState, {
          lessonNo: session.lessonNo,
          score: evaluation.score,
          updatedAt: createdAt,
        })
      : wordState
    const completedTask: LessonTaskRecord = {
      ...task,
      status: 'completed',
    }
    const completedQueue = lessonTasks.map((candidate) =>
      candidate.id === completedTask.id ? completedTask : candidate,
    )
    const nextQueue =
      !isPassingReviewScore(evaluation.score) && task.role !== 'bridge'
        ? scheduleWrongAnswerReflux({
            tasks: completedQueue,
            task: completedTask,
            gap: selectRefluxGap(),
            createdAt,
          })
        : completedQueue
    const taskDelta = createRecordAnswerTaskDelta(lessonTasks, nextQueue)
    const recorded = await courseRepository.recordAnswer({
      task: completedTask,
      wordState: updatedWordState,
      reviewLog: {
        id: crypto.randomUUID(),
        sessionId: session.id,
        taskId: task.id,
        courseId: task.courseId,
        wordId: task.wordId,
        stage: task.stage,
        taskType: task.taskType,
        userAnswer: JSON.stringify(submission),
        correctAnswer: evaluation.logCorrectAnswer,
        score: evaluation.score,
        lessonNo: session.lessonNo,
        createdAt,
      },
      ...taskDelta,
      advanceWordState,
    })

    return {
      ...recorded,
      feedback: createTaskFeedback(task, recorded.reviewLog.score),
    }
  }

  const completeLesson = async (sessionId: string): Promise<CompletedLesson> => {
    const session = await requireLessonSession(courseRepository, sessionId)
    await requireActiveCourseById(courseRepository, session.courseId)

    if (session.status === 'abandoned') {
      throw new DomainError('lesson_not_active', 'Lesson session is not active')
    }

    if (session.status === 'completed') {
      const completed = await courseRepository.completeLesson({
        sessionId,
        completedAt: session.completedAt ?? now().toISOString(),
        nextLessonNo: session.lessonNo + 1,
        skippablePrimaryTaskIds: [],
      })

      if (!completed) {
        throw new DomainError('conflict', 'Completed lesson state is inconsistent')
      }

      return completed
    }

    const tasks = await courseRepository.getLessonTasks(sessionId)
    const decision = getLessonCompletionDecision(tasks)

    if (!decision.allowed) {
      throw incompleteLessonError(decision)
    }

    const nextLessonNo = await resolveNextActionableLessonNo({
      contentRepository,
      courseRepository,
      courseId: session.courseId,
      minimumLessonNo: session.lessonNo + 1,
    })

    const completed = await courseRepository.completeLesson({
      sessionId,
      completedAt: now().toISOString(),
      nextLessonNo,
      skippablePrimaryTaskIds: decision.skippablePrimaryTaskIds,
    })

    if (!completed) {
      const latestSession = await requireLessonSession(courseRepository, sessionId)

      if (latestSession.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      const latestTasks = await courseRepository.getLessonTasks(sessionId)
      throw incompleteLessonError(getLessonCompletionDecision(latestTasks))
    }

    return completed
  }

  return {
    createCourse,
    createCourseIdempotently,
    enterCourseByAccessCode,
    startLesson,
    getLesson,
    previewSentenceOutput,
    submitAnswer,
    completeLesson,
  }
}

const createRecordAnswerTaskDelta = (
  before: LessonTaskRecord[],
  after: LessonTaskRecord[],
): Pick<
  RecordAnswerInput,
  | 'taskMutations'
  | 'reorderedExistingTaskIds'
  | 'taskCount'
  | 'completedTaskCount'
> => {
  const beforeById = new Map(before.map((task) => [task.id, task]))
  const taskMutations: LessonTaskRecord[] = []
  const reorderedExistingTaskIds: string[] = []

  for (const task of after) {
    const previous = beforeById.get(task.id)

    if (previous && previous.orderIndex !== task.orderIndex) {
      reorderedExistingTaskIds.push(task.id)
    }

    if (!previous || hasMutableTaskColumnChange(previous, task)) {
      taskMutations.push(task)
    }
  }

  return {
    taskMutations,
    reorderedExistingTaskIds,
    taskCount: after.length,
    completedTaskCount: after.filter((task) => task.status === 'completed').length,
  }
}

const hasMutableTaskColumnChange = (
  before: LessonTaskRecord,
  after: LessonTaskRecord,
): boolean =>
  before.orderIndex !== after.orderIndex ||
  before.status !== after.status ||
  before.role !== after.role ||
  before.required !== after.required ||
  before.refluxSourceTaskId !== after.refluxSourceTaskId ||
  before.draftAnswer !== after.draftAnswer ||
  before.referenceRevealedAt !== after.referenceRevealedAt

const replayCreatedCourse = async (
  repository: CourseRepository,
  token: RawAdminOperationToken,
  operation: CreateCourseAdminOperation,
): Promise<CreatedCourse> => {
  const [course, credential, records, accessCode] = await Promise.all([
    repository.getCourse(operation.outcomeCourseId),
    repository.getAdminLearnerCredential(operation.outcomeLearnerId),
    repository.listAdminCourses(),
    deriveAdminOperationAccessCode('create_course', token),
  ])

  if (!course || course.learnerId !== operation.outcomeLearnerId || !credential) {
    throw new DomainError(
      'dependency_failure',
      'Committed course creation outcome is unavailable',
    )
  }

  const expectedAccessCodeHash = await hashAccessCode(accessCode)

  if (
    credential.credentialVersion !== operation.outcomeCredentialVersion ||
    credential.accessCodeHash !== expectedAccessCodeHash
  ) {
    throw new DomainError(
      'operation_superseded',
      'The committed one-time code has been superseded',
    )
  }

  const record = records.find(
    (candidate) =>
      candidate.learner.id === operation.outcomeLearnerId &&
      candidate.course.id === operation.outcomeCourseId,
  )

  if (!record) {
    throw new DomainError(
      'dependency_failure',
      'Committed course creation identity is unavailable',
    )
  }

  return {
    learner: {
      id: record.learner.id,
      name: record.learner.name,
      accessCode,
    },
    course: {
      id: course.id,
      learnerId: course.learnerId,
      sourceVersionId: course.sourceVersionId,
      currentLessonNo: course.currentLessonNo,
      status: course.status,
    },
  }
}

const requireActiveCourse = (course: Pick<CourseRecord, 'status'>): void => {
  if (course.status !== 'active') {
    throw new DomainError('course_unavailable', 'Course is not active')
  }
}

const requireActiveCourseById = async (
  repository: CourseRepository,
  courseId: string,
): Promise<void> => {
  const course = await repository.getCourse(courseId)

  if (!course) {
    throw new DomainError('not_found', `Course ${courseId} is missing`)
  }

  requireActiveCourse(course)
}

const resolveNextActionableLessonNo = async (input: {
  contentRepository: ContentRepository
  courseRepository: CourseRepository
  courseId: string
  minimumLessonNo: number
}): Promise<number> => {
  const course = await input.courseRepository.getCourse(input.courseId)

  if (!course) {
    throw new DomainError('not_found', `Course ${input.courseId} is missing`)
  }

  requireActiveCourse(course)

  const [sourceVersion, states] = await Promise.all([
    input.contentRepository.getSourceVersion(course.sourceVersionId),
    input.courseRepository.getWordStates(course.id),
  ])

  if (!sourceVersion || sourceVersion.version.status !== 'published') {
    throw new DomainError('course_unavailable', 'Course source version is not available')
  }

  const activatedGroupIds = new Set(states.map((state) => state.groupId))
  const hasUnactivatedGroup = sourceVersion.groups.some(
    (group) => !activatedGroupIds.has(group.id),
  )

  if (hasUnactivatedGroup) {
    return input.minimumLessonNo
  }

  const nextDueLessonNo = states.reduce<number | undefined>(
    (minimum, state) => {
      if (state.status === 'suspended') return minimum

      const candidate = Math.max(input.minimumLessonNo, state.nextDueLessonNo)
      return minimum === undefined ? candidate : Math.min(minimum, candidate)
    },
    undefined,
  )

  if (nextDueLessonNo === undefined) {
    throw new DomainError('course_unavailable', 'Course has no schedulable words')
  }

  return nextDueLessonNo
}

const createLessonTask = (input: {
  sourceVersion: SourceVersionSnapshot
  state: UserWordStateRecord
  sessionId: string
  orderIndex: number
  createdAt: string
}): LessonTaskRecord => {
  const word = input.sourceVersion.words.find((candidate) => candidate.id === input.state.wordId)

  if (!word) {
    throw new DomainError('course_unavailable', `Word ${input.state.wordId} is missing`)
  }

  const exerciseItem = input.sourceVersion.exerciseItems.find(
    (item) =>
      item.wordId === input.state.wordId &&
      item.stage === input.state.stage &&
      item.status === 'approved',
  )

  if (!exerciseItem) {
    throw new DomainError(
      'course_unavailable',
      `Approved ${input.state.stage} exercise item is missing for ${word.word}`,
    )
  }

  const content = exerciseItemContentSchema.parse({
    stage: exerciseItem.stage,
    taskType: exerciseItem.taskType,
    prompt: exerciseItem.prompt,
    answer: exerciseItem.answer,
  })

  requireLearnerSafeExerciseItemContent(content, word.word)

  return {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    courseId: input.state.courseId,
    wordId: word.id,
    orderIndex: input.orderIndex,
    status: 'pending',
    role: 'primary',
    required: false,
    createdAt: input.createdAt,
    ...content,
  }
}

const requireLessonSession = async (
  repository: CourseRepository,
  sessionId: string,
): Promise<LessonSessionRecord> => {
  const session = await repository.getLessonSession(sessionId)

  if (!session) {
    throw new DomainError('not_found', `Lesson session ${sessionId} is missing`)
  }

  return session
}

const requireSessionTask = async (
  repository: CourseRepository,
  input: { sessionId: string; taskId: string },
): Promise<{ session: LessonSessionRecord; task: LessonTaskRecord }> => {
  const session = await requireLessonSession(repository, input.sessionId)
  await requireActiveCourseById(repository, session.courseId)

  if (session.status !== 'started') {
    throw new DomainError(
      'lesson_not_active',
      `Lesson session ${input.sessionId} is not active`,
    )
  }

  const task = await repository.getLessonTaskForResource({
    sessionId: session.id,
    courseId: session.courseId,
    taskId: input.taskId,
  })

  if (!task) {
    throw new DomainError('not_found', `Lesson task ${input.taskId} is missing`)
  }

  return { session, task }
}

const requireCurrentTask = async (
  repository: CourseRepository,
  sessionId: string,
  taskId: string,
): Promise<void> => {
  const currentTask = getNextPendingTask(await repository.getLessonTasks(sessionId))

  if (!currentTask || currentTask.id !== taskId) {
    throw new DomainError('task_not_current', 'Only the first pending task can be answered')
  }
}

const scheduleWrongAnswerReflux = (input: {
  tasks: LessonTaskRecord[]
  task: LessonTaskRecord
  gap: number
  createdAt: string
}): LessonTaskRecord[] => {
  const primarySources = input.tasks.filter((task) => task.role === 'primary')
  const differentWordSources = primarySources.filter(
    (task) => task.wordId !== input.task.wordId,
  )
  const bridgeSources =
    differentWordSources.length > 0 ? differentWordSources : primarySources

  if (bridgeSources.length === 0) {
    throw new DomainError('course_unavailable', 'No lesson snapshot is available for bridge tasks')
  }

  return scheduleReflux({
    tasks: input.tasks,
    sourceTaskId: input.task.id,
    gap: input.gap,
    createBridge: (index) => {
      const source = bridgeSources[(index - 1) % bridgeSources.length]

      if (!source) {
        throw new DomainError('course_unavailable', 'No bridge task source is available')
      }

      return cloneQueueTask(source, {
        role: 'bridge',
        required: true,
        createdAt: input.createdAt,
      })
    },
    createReflux: () =>
      cloneQueueTask(input.task, {
        role: 'reflux',
        required: true,
        refluxSourceTaskId: input.task.id,
        createdAt: input.createdAt,
      }),
  })
}

const cloneQueueTask = (
  source: LessonTaskRecord,
  input: {
    role: LessonTaskRecord['role']
    required: boolean
    refluxSourceTaskId?: string
    createdAt: string
  },
): LessonTaskRecord => {
  const base = {
    id: crypto.randomUUID(),
    sessionId: source.sessionId,
    courseId: source.courseId,
    wordId: source.wordId,
    orderIndex: 1,
    status: 'pending' as const,
    role: input.role,
    required: input.required,
    ...(input.refluxSourceTaskId === undefined
      ? {}
      : { refluxSourceTaskId: input.refluxSourceTaskId }),
    createdAt: input.createdAt,
  }

  switch (source.taskType) {
    case 'recognize_meaning':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
    case 'recall_word':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
    case 'multiple_choice':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
    case 'fill_blank':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
    case 'sentence_build':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
    case 'sentence_output':
      return { ...base, stage: source.stage, taskType: source.taskType, prompt: source.prompt, answer: source.answer }
  }
}

const toStartedLesson = (
  session: LessonSessionRecord,
  tasks: LessonTaskRecord[],
): StartedLesson => ({
  session: {
    id: session.id,
    courseId: session.courseId,
    lessonNo: session.lessonNo,
    status: session.status,
    taskCount: session.taskCount,
    completedTaskCount: session.completedTaskCount,
  },
  tasks: tasks.map(toLessonTaskDto),
})

const toLessonTaskDto = (task: LessonTaskRecord): LessonTaskDto =>
  lessonTaskSchema.parse({
    id: task.id,
    sessionId: task.sessionId,
    courseId: task.courseId,
    wordId: task.wordId,
    stage: task.stage,
    taskType: task.taskType,
    prompt: task.prompt,
    orderIndex: task.orderIndex,
    status: task.status,
    role: task.role,
    required: task.required,
    ...(task.refluxSourceTaskId === undefined
      ? {}
      : { refluxSourceTaskId: task.refluxSourceTaskId }),
    ...(task.taskType === 'sentence_output' &&
    task.draftAnswer !== undefined &&
    task.referenceRevealedAt !== undefined
      ? {
          preview: {
            draft: task.draftAnswer,
            referenceSentence: task.answer.referenceSentence,
            revealedAt: task.referenceRevealedAt,
          },
        }
      : {}),
  })

const incompleteLessonError = (
  decision: ReturnType<typeof getLessonCompletionDecision>,
): DomainError =>
  new DomainError('lesson_incomplete', 'Lesson completion requirements are not met', {
    completedPrimary: decision.completedPrimary,
    totalPrimary: decision.totalPrimary,
    pendingRequiredTaskIds: decision.pendingRequiredTaskIds,
  })

const createAccessCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const values = new Uint8Array(10)
  crypto.getRandomValues(values)

  return Array.from(values, (value) => alphabet.charAt(value % alphabet.length)).join('')
}

const selectDefaultRefluxGap = (): number => {
  const value = new Uint8Array(1)
  crypto.getRandomValues(value)

  return 5 + ((value[0] ?? 0) % 4)
}

const createInitialWordState = (input: {
  courseId: string
  wordId: string
  groupId: string
  lessonNo: number
  createdAt: string
}): UserWordStateRecord => ({
  id: crypto.randomUUID(),
  courseId: input.courseId,
  wordId: input.wordId,
  groupId: input.groupId,
  stage: 'S0',
  totalAttemptCount: 0,
  totalCorrectCount: 0,
  totalWrongCount: 0,
  currentStreak: 0,
  wrongStreak: 0,
  lapseCount: 0,
  easeFactor: 1,
  masteryScore: 0,
  firstLessonNo: input.lessonNo,
  nextDueLessonNo: input.lessonNo,
  status: 'new',
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
})
