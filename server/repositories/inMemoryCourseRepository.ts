import type {
  CourseRecord,
  CourseLearningRunWordStateSnapshot,
  CourseProgressResetOperationRecord,
  CourseRepository,
  CreateLessonInput,
  CreateCourseInput,
  LearnerRecord,
  LessonSessionRecord,
  LessonTaskRecord,
  RecordAnswerInput,
  ReviewLogRecord,
  UserWordStateRecord,
} from './courseRepository'
import {
  getCourseLearningRunNo,
  getCourseRunLessonNo,
  getCourseRunStartLessonNo,
  getSessionLearningRunNo,
  getSessionRunLessonNo,
} from './courseRepository'
import { lessonTaskSchema, type LessonTaskDto } from '../../shared/api/taskSchemas'
import { isPassingReviewScore } from '../../shared/domain/course'
import type { AccessCodeHash } from '../security/credentialCrypto'
import {
  hashAccessCode,
  normalizeAccessCode,
  parseRawAccessCode,
} from '../security/credentialCrypto'
import {
  createInMemoryAdminOperationLedger,
  type InMemoryAdminOperationLedger,
} from './adminOperationLedger'
import { DomainError } from '../errors/DomainError'

type StoredLearnerRecord = LearnerRecord & {
  credentialVersion: number
}

const withLegacyFlowPolicyDefault = (
  value: LessonSessionRecord['flowPolicyVersion'] | undefined,
): LessonSessionRecord['flowPolicyVersion'] =>
  value ?? 'v1_due_then_new_unbounded'

export type InMemoryLearnerCredentialPort = {
  getLearnerSessionEligibility(input: {
    learnerId: string
    courseId: string
  }):
    | {
        credentialVersion: number
        courseStatus: CourseRecord['status']
      }
    | undefined
  getLearnerCredentialVersion(learnerId: string): Promise<number | undefined>
  advanceLearnerCredential(input: {
    learnerId: string
    accessCodeHash: AccessCodeHash
    expectedCredentialVersion?: number
  }): Promise<boolean>
}

export const createInMemoryCourseRepository = (
  input: { ledger?: InMemoryAdminOperationLedger } = {},
): CourseRepository & InMemoryLearnerCredentialPort => {
  const ledger = input.ledger ?? createInMemoryAdminOperationLedger()
  const learners = new Map<string, StoredLearnerRecord>()
  const courses = new Map<string, CourseRecord>()
  const sessions = new Map<string, LessonSessionRecord>()
  const tasksBySession = new Map<string, LessonTaskRecord[]>()
  const wordStates = new Map<string, UserWordStateRecord>()
  const reviewLogs = new Map<string, ReviewLogRecord>()
  const reviewLogByTask = new Map<string, string>()
  const resetOperations = new Map<string, CourseProgressResetOperationRecord>()
  const wordStateSnapshots: CourseLearningRunWordStateSnapshot[] = []

  const toStartedLesson = (session: LessonSessionRecord) => ({
    session: {
      id: session.id,
      courseId: session.courseId,
      lessonNo: getSessionRunLessonNo(session),
      status: session.status,
      taskCount: session.taskCount,
      completedTaskCount: session.completedTaskCount,
    },
    tasks: [...(tasksBySession.get(session.id) ?? [])]
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map(toLessonTaskView),
  })

  const toSubmittedAnswer = (reviewLog: ReviewLogRecord, wordState: UserWordStateRecord) => ({
    wordState: toWordStateView(wordState),
    reviewLog: {
      id: reviewLog.id,
      sessionId: reviewLog.sessionId,
      courseId: reviewLog.courseId,
      wordId: reviewLog.wordId,
      stage: reviewLog.stage,
      taskType: reviewLog.taskType,
      ...(reviewLog.userAnswer ? { userAnswer: reviewLog.userAnswer } : {}),
      correctAnswer: reviewLog.correctAnswer,
      score: reviewLog.score,
      lessonNo: reviewLog.lessonNo,
      createdAt: reviewLog.createdAt,
    },
  })

  const toRecordedAnswerOutcome = (
    reviewLog: ReviewLogRecord,
    wordState: UserWordStateRecord,
  ) => ({
    submittedAnswer: toSubmittedAnswer(reviewLog, wordState),
    ...(reviewLog.queueDisposition === undefined
      ? {}
      : { queueDisposition: reviewLog.queueDisposition }),
    ...(reviewLog.queueCapacityReason === undefined
      ? {}
      : { queueCapacityReason: reviewLog.queueCapacityReason }),
  })

  const wordStateKey = (courseId: string, wordId: string) => `${courseId}:${wordId}`
  const taskKey = (sessionId: string, taskId: string) => `${sessionId}:${taskId}`

  const findStartedSession = (courseId: string, lessonNo: number) =>
    Array.from(sessions.values()).find(
      (candidate) =>
        candidate.courseId === courseId &&
        candidate.lessonNo === lessonNo &&
        candidate.status === 'started',
    )

  const findTask = (sessionId: string, taskId: string) =>
    (tasksBySession.get(sessionId) ?? []).find((task) => task.id === taskId)

  const findCourseCredentialByAccessCode = async (accessCode: string) => {
    const rawAccessCode = parseRawAccessCode(accessCode)

    if (!rawAccessCode) {
      return undefined
    }

    const normalizedAccessCode = normalizeAccessCode(rawAccessCode)
    const accessCodeHash = await hashAccessCode(rawAccessCode)
    const learner = Array.from(learners.values()).find(
      (candidate) =>
        candidate.accessCode === accessCodeHash || candidate.accessCode === normalizedAccessCode,
    )

    if (!learner) {
      return undefined
    }

    if (learner.accessCode === normalizedAccessCode) {
      learners.set(learner.id, { ...learner, accessCode: accessCodeHash })
    }

    const course = Array.from(courses.values()).find(
      (candidate) => candidate.learnerId === learner.id,
    )

    if (!course) {
      return undefined
    }

    return {
      identity: {
        learner: {
          id: learner.id,
          name: learner.name,
        },
        course: {
          id: course.id,
          learnerId: course.learnerId,
          sourceVersionId: course.sourceVersionId,
          currentLessonNo: getCourseRunLessonNo(course),
          status: course.status,
        },
      },
      credentialVersion: learner.credentialVersion,
    }
  }

  const toLessonTaskView = (task: LessonTaskRecord): LessonTaskDto =>
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
      ...(task.reinforcementSourceTaskId === undefined
        ? {}
        : { reinforcementSourceTaskId: task.reinforcementSourceTaskId }),
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

  const toWordStateView = (state: UserWordStateRecord) => ({
    id: state.id,
    courseId: state.courseId,
    wordId: state.wordId,
    groupId: state.groupId,
    stage: state.stage,
    totalAttemptCount: state.totalAttemptCount,
    totalCorrectCount: state.totalCorrectCount,
    totalWrongCount: state.totalWrongCount,
    currentStreak: state.currentStreak,
    wrongStreak: state.wrongStreak,
    lapseCount: state.lapseCount,
    easeFactor: state.easeFactor,
    masteryScore: state.masteryScore,
    firstLessonNo: state.firstLessonNo,
    ...(state.lastSeenLessonNo === undefined ? {} : { lastSeenLessonNo: state.lastSeenLessonNo }),
    nextDueLessonNo: state.nextDueLessonNo,
    status: state.status,
  })

  return {
    async createCourse(input: CreateCourseInput) {
      const create = async () => {
        if (
          input.adminOperation &&
          (await ledger.get(input.adminOperation.operationHash))
        ) {
          throw new Error('Admin operation already exists')
        }

        const rawAccessCode = parseRawAccessCode(input.learner.accessCode)

        if (!rawAccessCode) {
          throw new Error('Learner access code is invalid')
        }

        learners.set(input.learner.id, {
          ...input.learner,
          accessCode: await hashAccessCode(rawAccessCode),
          credentialVersion: 1,
        })
        const storedCourse = input.course
        storedCourse.currentLearningRunNo ??= 1
        storedCourse.currentRunStartLessonNo ??= 1
        courses.set(input.course.id, storedCourse)
        if (input.adminOperation) ledger.insert(input.adminOperation)

        return {
          learner: {
            id: input.learner.id,
            name: input.learner.name,
            accessCode: input.learner.accessCode,
          },
          course: {
            id: input.course.id,
            learnerId: input.course.learnerId,
            sourceVersionId: input.course.sourceVersionId,
            currentLessonNo: getCourseRunLessonNo(storedCourse),
            status: input.course.status,
          },
        }
      }

      return input.adminOperation ? ledger.runExclusive(create) : create()
    },

    async getCourse(courseId: string) {
      return courses.get(courseId)
    },

    async getCourseForLearner(input) {
      const course = courses.get(input.courseId)

      return course?.learnerId === input.learnerId ? course : undefined
    },

    async getCourseIdentityByAccessCode(accessCode: string) {
      return (await findCourseCredentialByAccessCode(accessCode))?.identity
    },

    async getCourseCredentialByAccessCode(accessCode: string) {
      return findCourseCredentialByAccessCode(accessCode)
    },

    async getCourseByAccessCode(accessCode: string) {
      const match = await findCourseCredentialByAccessCode(accessCode)

      if (!match) {
        return undefined
      }

      const { identity } = match

      return {
        learner: {
          ...identity.learner,
          accessCode: normalizeAccessCode(accessCode),
        },
        course: identity.course,
      }
    },

    async getAdminLearnerCredential(learnerId) {
      const learner = learners.get(learnerId)

      return learner
        ? {
            accessCodeHash: learner.accessCode as AccessCodeHash,
            credentialVersion: learner.credentialVersion,
          }
        : undefined
    },

    async listAdminCourses() {
      return Array.from(courses.values())
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
        )
        .flatMap((course) => {
          const learner = learners.get(course.learnerId)

          return learner
            ? [
                {
                  learner: { id: learner.id, name: learner.name },
                  course: { ...course },
                  credentialVersion: learner.credentialVersion,
                },
              ]
            : []
        })
    },

    getLearnerSessionEligibility(input) {
      const learner = learners.get(input.learnerId)
      const course = courses.get(input.courseId)

      if (!learner || !course || course.learnerId !== learner.id) return undefined

      return {
        credentialVersion: learner.credentialVersion,
        courseStatus: course.status,
      }
    },

    async getLearnerCredentialVersion(learnerId) {
      return learners.get(learnerId)?.credentialVersion
    },

    async advanceLearnerCredential(input) {
      const learner = learners.get(input.learnerId)

      if (!learner) {
        return false
      }

      if (
        input.expectedCredentialVersion !== undefined &&
        learner.credentialVersion !== input.expectedCredentialVersion
      ) {
        return false
      }

      learners.set(input.learnerId, {
        ...learner,
        accessCode: input.accessCodeHash,
        credentialVersion: learner.credentialVersion + 1,
      })
      return true
    },

    async advanceCourseLessonNo(input) {
      const course = courses.get(input.courseId)

      if (!course) {
        return course
      }

      if (course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      if (input.nextLessonNo <= input.expectedLessonNo) return course

      if (course.currentLessonNo === input.expectedLessonNo) {
        const advanced = { ...course, currentLessonNo: input.nextLessonNo }
        courses.set(course.id, advanced)
        return advanced
      }

      return course
    },

    async getStartedLesson(courseId: string, lessonNo: number) {
      const session = findStartedSession(courseId, lessonNo)

      return session ? toStartedLesson(session) : undefined
    },

    async getLatestCompletedLessonBefore(input) {
      const course = courses.get(input.courseId)
      const currentLearningRunNo = course ? getCourseLearningRunNo(course) : 1

      return Array.from(sessions.values())
        .filter(
          (session) =>
            session.courseId === input.courseId &&
            session.status === 'completed' &&
            getSessionLearningRunNo(session) === currentLearningRunNo &&
            session.lessonNo < input.beforeLessonNo,
        )
        .sort((left, right) => right.lessonNo - left.lessonNo)[0]
    },

    async listCompletedLessonSessions(input) {
      const after = input.after

      return Array.from(sessions.values())
        .filter((session) => session.courseId === input.courseId && session.status === 'completed')
        .sort((left, right) =>
          getSessionLearningRunNo(left) - getSessionLearningRunNo(right) ||
          getSessionRunLessonNo(left) - getSessionRunLessonNo(right) ||
          left.lessonNo - right.lessonNo,
        )
        .filter((session) => {
          if (!after) return true
          const learningRunNo = getSessionLearningRunNo(session)
          const runLessonNo = getSessionRunLessonNo(session)

          return (
            learningRunNo > after.learningRunNo ||
            (learningRunNo === after.learningRunNo && runLessonNo > after.runLessonNo) ||
            (learningRunNo === after.learningRunNo &&
              runLessonNo === after.runLessonNo &&
              session.lessonNo > after.physicalLessonNo)
          )
        })
        .slice(0, input.limit)
    },

    async createLesson(input: CreateLessonInput) {
      const course = courses.get(input.session.courseId)

      if (!course || course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      const existing = findStartedSession(input.session.courseId, input.session.lessonNo)

      if (existing) {
        return toStartedLesson(existing)
      }

      const session = {
        ...input.session,
        learningRunNo:
          input.session.learningRunNo ?? getCourseLearningRunNo(course),
        runLessonNo:
          input.session.runLessonNo ??
          input.session.lessonNo - getCourseRunStartLessonNo(course) + 1,
        flowPolicyVersion: withLegacyFlowPolicyDefault(input.session.flowPolicyVersion),
      }

      sessions.set(session.id, session)
      tasksBySession.set(input.session.id, [...input.tasks])
      for (const state of input.wordStates) {
        wordStates.set(wordStateKey(state.courseId, state.wordId), {
          ...state,
          learningRunNo: state.learningRunNo ?? getCourseLearningRunNo(course),
        })
      }

      return toStartedLesson(session)
    },

    async getLessonSessionForCourse(input) {
      const session = sessions.get(input.sessionId)

      return session?.courseId === input.courseId ? session : undefined
    },

    async getLessonTaskForResource(input) {
      const task = findTask(input.sessionId, input.taskId)

      return task?.courseId === input.courseId ? task : undefined
    },

    async getLessonTask(sessionId: string, taskId: string) {
      return findTask(sessionId, taskId)
    },

    async getLessonTasks(sessionId: string) {
      return [...(tasksBySession.get(sessionId) ?? [])].sort(
        (left, right) => left.orderIndex - right.orderIndex,
      )
    },

    async getLessonSession(sessionId: string) {
      return sessions.get(sessionId)
    },

    async getLessonQueueSnapshot(input) {
      return this.getLessonReportSnapshot(input)
    },

    async getLessonReportSnapshot(input) {
      const session = sessions.get(input.sessionId)

      if (!session || session.courseId !== input.courseId) {
        return undefined
      }

      const tasks = [...(tasksBySession.get(session.id) ?? [])].sort(
        (left, right) => left.orderIndex - right.orderIndex,
      )
      const taskOrder = new Map(tasks.map((task) => [task.id, task.orderIndex]))
      const logs = Array.from(reviewLogs.values())
        .filter(
          (log) =>
            log.sessionId === session.id &&
            log.courseId === input.courseId &&
            taskOrder.has(log.taskId),
        )
        .sort(
          (left, right) =>
            (taskOrder.get(left.taskId) ?? 0) - (taskOrder.get(right.taskId) ?? 0),
        )
        .map((log) => ({ ...log }))

      return {
        session: { ...session },
        tasks,
        reviewLogs: logs,
      }
    },

    async saveSentenceOutputPreview(input) {
      const course = courses.get(input.courseId)

      if (!course || course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      const session = sessions.get(input.sessionId)

      if (!session || session.courseId !== input.courseId) return undefined
      if (session.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }
      if (getSessionLearningRunNo(session) !== getCourseLearningRunNo(course)) {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      const tasks = tasksBySession.get(input.sessionId) ?? []
      const task = tasks.find((candidate) => candidate.id === input.taskId)

      if (
        !task ||
        task.courseId !== input.courseId ||
        task.status !== 'pending' ||
        task.taskType !== 'sentence_output'
      ) {
        return undefined
      }

      if (task.draftAnswer !== undefined || task.referenceRevealedAt !== undefined) {
        if (
          task.draftAnswer !== input.draft ||
          task.referenceRevealedAt === undefined
        ) {
          return undefined
        }

        return {
          taskId: task.id,
          draft: task.draftAnswer,
          referenceSentence: task.answer.referenceSentence,
          revealedAt: task.referenceRevealedAt,
        }
      }

      const previewedTask: LessonTaskRecord = {
        ...task,
        draftAnswer: input.draft,
        referenceRevealedAt: input.revealedAt,
      }
      tasksBySession.set(
        input.sessionId,
        tasks.map((candidate) => (candidate.id === task.id ? previewedTask : candidate)),
      )

      return {
        taskId: task.id,
        draft: input.draft,
        referenceSentence: task.answer.referenceSentence,
        revealedAt: input.revealedAt,
      }
    },

    async getWordStates(courseId: string) {
      const course = courses.get(courseId)
      if (!course) return []
      const learningRunNo = getCourseLearningRunNo(course)

      return Array.from(wordStates.values()).filter(
        (state) =>
          state.courseId === courseId &&
          (state.learningRunNo ?? 1) === learningRunNo,
      )
    },

    async getWordState(courseId: string, wordId: string) {
      const course = courses.get(courseId)
      const state = wordStates.get(wordStateKey(courseId, wordId))

      return course && state && (state.learningRunNo ?? 1) === getCourseLearningRunNo(course)
        ? state
        : undefined
    },

    async getSubmittedAnswer(sessionId: string, taskId: string) {
      const reviewLogId = reviewLogByTask.get(taskKey(sessionId, taskId))

      if (!reviewLogId) {
        return undefined
      }

      const reviewLog = reviewLogs.get(reviewLogId)

      if (!reviewLog) {
        return undefined
      }

      const state = wordStates.get(wordStateKey(reviewLog.courseId, reviewLog.wordId))

      if (!state) {
        throw new Error(`Word state is missing for ${reviewLog.wordId}`)
      }

      return toRecordedAnswerOutcome(reviewLog, state)
    },

    async recordAnswer(input: RecordAnswerInput) {
      const course = courses.get(input.task.courseId)

      if (!course || course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      const existingReviewLogId = reviewLogByTask.get(
        taskKey(input.reviewLog.sessionId, input.reviewLog.taskId),
      )

      if (existingReviewLogId) {
        const existingReviewLog = reviewLogs.get(existingReviewLogId)
        const existingWordState = wordStates.get(
          wordStateKey(input.reviewLog.courseId, input.reviewLog.wordId),
        )

        if (!existingReviewLog || !existingWordState) {
          throw new Error('Submitted answer integrity is invalid')
        }

        return toRecordedAnswerOutcome(existingReviewLog, existingWordState)
      }

      const session = sessions.get(input.task.sessionId)

      if (!session || session.courseId !== input.task.courseId) {
        throw new Error(`Lesson session ${input.task.sessionId} is missing`)
      }

      if (session.status !== 'started') {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }
      if (getSessionLearningRunNo(session) !== getCourseLearningRunNo(course)) {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      const sessionPolicy = session.queuePolicyVersion
      const expectedPolicy = input.expectedQueuePolicyVersion
      const sessionFlowPolicy = session.flowPolicyVersion
      const expectedFlowPolicy = withLegacyFlowPolicyDefault(
        input.expectedFlowPolicyVersion,
      )
      const isWrongAnswer = !isPassingReviewScore(input.reviewLog.score)
      const hasWrongDisposition =
        input.reviewLog.queueDisposition === 'scheduled' ||
        input.reviewLog.queueDisposition === 'deferred_cap' ||
        input.reviewLog.queueDisposition === 'deferred_capacity'
      const dispositionMatches =
        sessionPolicy === 'v1_5_8_unbounded'
          ? input.reviewLog.queueDisposition === undefined
          : isWrongAnswer
            ? hasWrongDisposition
            : input.reviewLog.queueDisposition === undefined
      const capacityReasonMatches =
        sessionFlowPolicy === 'v2_rolling_reinforcement_budget24'
          ? input.reviewLog.queueDisposition === 'deferred_capacity'
            ? input.reviewLog.queueCapacityReason !== undefined
            : input.reviewLog.queueCapacityReason === undefined
          : input.reviewLog.queueCapacityReason === undefined

      if (
        sessionPolicy !== expectedPolicy ||
        sessionFlowPolicy !== expectedFlowPolicy ||
        !dispositionMatches ||
        !capacityReasonMatches
      ) {
        throw new Error('review_log_queue_policy_mismatch')
      }

      const storedTask = findTask(input.task.sessionId, input.task.id)

      if (!storedTask || storedTask.status !== 'pending') {
        throw new Error(`Lesson task ${input.task.id} is not pending`)
      }

      const firstPendingTask = (tasksBySession.get(input.task.sessionId) ?? [])
        .filter((task) => task.status === 'pending')
        .sort((left, right) => left.orderIndex - right.orderIndex)[0]

      if (!firstPendingTask || firstPendingTask.id !== storedTask.id) {
        throw new Error(`Lesson task ${input.task.id} is not current`)
      }

      const storedTasks = tasksBySession.get(input.task.sessionId) ?? []
      const nextTasksById = new Map(storedTasks.map((task) => [task.id, task]))

      for (const mutation of input.taskMutations) {
        if (
          mutation.sessionId !== input.task.sessionId ||
          mutation.courseId !== input.task.courseId
        ) {
          throw new Error(`Lesson task mutation ${mutation.id} is outside the answer scope`)
        }

        nextTasksById.set(mutation.id, mutation)
      }

      tasksBySession.set(
        input.task.sessionId,
        Array.from(nextTasksById.values()).sort(
          (left, right) => left.orderIndex - right.orderIndex,
        ),
      )

      sessions.set(input.task.sessionId, {
        ...session,
        taskCount: input.taskCount,
        completedTaskCount: input.completedTaskCount,
        correctCount:
          session.correctCount +
          (storedTask.role === 'primary' && isPassingReviewScore(input.reviewLog.score) ? 1 : 0),
        wrongCount:
          session.wrongCount +
          (storedTask.role === 'primary' && !isPassingReviewScore(input.reviewLog.score) ? 1 : 0),
      })

      if (input.persistWordState) {
        wordStates.set(
          wordStateKey(input.wordState.courseId, input.wordState.wordId),
          {
            ...input.wordState,
            learningRunNo: getCourseLearningRunNo(course),
          },
        )
      }
      const persistedReviewLog = { ...input.reviewLog }
      reviewLogs.set(persistedReviewLog.id, persistedReviewLog)
      reviewLogByTask.set(taskKey(input.reviewLog.sessionId, input.reviewLog.taskId), input.reviewLog.id)

      return toRecordedAnswerOutcome(persistedReviewLog, input.wordState)
    },

    async completeLesson(input) {
      const session = sessions.get(input.sessionId)

      if (!session) {
        return undefined
      }

      const course = courses.get(session.courseId)

      if (!course) {
        throw new Error(`Course ${session.courseId} is missing`)
      }

      if (course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }
      if (getSessionLearningRunNo(session) !== getCourseLearningRunNo(course)) {
        throw new DomainError('lesson_not_active', 'Lesson session is not active')
      }

      if (session.status !== 'started') {
        if (session.status !== 'completed' || session.completedAt === undefined) {
          throw new DomainError('lesson_not_active', 'Lesson session is not active')
        }

        return {
          course: {
            id: course.id,
            learnerId: course.learnerId,
            sourceVersionId: course.sourceVersionId,
            currentLessonNo: getCourseRunLessonNo(course),
            status: course.status,
          },
          session: {
            id: session.id,
            courseId: session.courseId,
            lessonNo: getSessionRunLessonNo(session),
            status: session.status,
            taskCount: session.taskCount,
            completedTaskCount: session.completedTaskCount,
          },
        }
      }

      const tasks = tasksBySession.get(session.id) ?? []
      const primaryTasks = tasks.filter((task) => task.role === 'primary')
      const completedPrimary = primaryTasks.filter(
        (task) => task.status === 'completed',
      ).length
      const pendingRequired = tasks.some(
        (task) => task.required && task.status !== 'completed',
      )
      const skippablePrimaryTaskIds = primaryTasks
        .filter((task) => task.status === 'pending')
        .map((task) => task.id)
      const providedSkippableIds = new Set(input.skippablePrimaryTaskIds)
      const canComplete =
        primaryTasks.length > 0 &&
        completedPrimary * 5 >= primaryTasks.length * 4 &&
        !pendingRequired &&
        input.nextLessonNo > session.lessonNo &&
        skippablePrimaryTaskIds.length === providedSkippableIds.size &&
        skippablePrimaryTaskIds.every((taskId) => providedSkippableIds.has(taskId))

      if (!canComplete || course.currentLessonNo !== session.lessonNo) {
        return undefined
      }

      const completedTasks = tasks.map((task) =>
        providedSkippableIds.has(task.id) && task.role === 'primary' && task.status === 'pending'
          ? { ...task, status: 'skipped' as const }
          : task,
      )
      const completedTaskCount = completedTasks.filter(
        (task) => task.status === 'completed',
      ).length
      const completedSession: LessonSessionRecord = {
        ...session,
        status: 'completed',
        completedTaskCount,
        completedAt: input.completedAt,
      }
      const advancedCourse: CourseRecord = {
        ...course,
        currentLessonNo: input.nextLessonNo,
      }

      tasksBySession.set(session.id, completedTasks)
      sessions.set(session.id, completedSession)
      courses.set(course.id, advancedCourse)

      return {
        course: {
          id: advancedCourse.id,
          learnerId: advancedCourse.learnerId,
          sourceVersionId: advancedCourse.sourceVersionId,
          currentLessonNo: getCourseRunLessonNo(advancedCourse),
          status: advancedCourse.status,
        },
        session: {
          id: completedSession.id,
          courseId: completedSession.courseId,
          lessonNo: getSessionRunLessonNo(completedSession),
          status: completedSession.status,
          taskCount: completedSession.taskCount,
          completedTaskCount: completedSession.completedTaskCount,
        },
      }
    },

    async getCourseProgressResetOperation(operationHash) {
      return resetOperations.get(operationHash)
    },

    async resetCourseProgress(input) {
      return ledger.runExclusive(async () => {
        const existing = resetOperations.get(input.operationHash)
        const existingCourse = courses.get(input.courseId)

        if (existing) {
          if (
            existing.courseId !== input.courseId ||
            existing.requestFingerprint !== input.requestFingerprint
          ) {
            throw new DomainError(
              'idempotency_conflict',
              'Admin operation token was already used for a different request',
            )
          }
          if (!existingCourse) throw new Error('Reset course is missing')
          return { course: existingCourse, operation: existing }
        }

        if (await ledger.get(input.operationHash)) {
          throw new DomainError(
            'idempotency_conflict',
            'Admin operation token was already used for a different request',
          )
        }
        if (!existingCourse) {
          throw new DomainError('not_found', 'Course is missing')
        }
        if (existingCourse.status !== 'active') {
          throw new DomainError('course_unavailable', 'Course is not active')
        }
        if (
          getCourseLearningRunNo(existingCourse) !== input.expectedLearningRunNo ||
          getCourseRunLessonNo(existingCourse) !== input.expectedCurrentRunLessonNo
        ) {
          throw new DomainError('progress_conflict', 'Course learning progress has changed')
        }

        const currentLearningRunNo = getCourseLearningRunNo(existingCourse)
        const courseSessions = Array.from(sessions.values()).filter(
          (session) => session.courseId === existingCourse.id,
        )
        const toPhysicalLessonNo =
          Math.max(
            existingCourse.currentLessonNo,
            ...courseSessions.map((session) => session.lessonNo),
          ) + 1
        const startedSessions = courseSessions.filter(
          (session) =>
            session.status === 'started' &&
            getSessionLearningRunNo(session) === currentLearningRunNo,
        )
        const operation: CourseProgressResetOperationRecord = {
          operationHash: input.operationHash,
          courseId: existingCourse.id,
          requestFingerprint: input.requestFingerprint,
          fromLearningRunNo: currentLearningRunNo,
          expectedCurrentRunLessonNo: input.expectedCurrentRunLessonNo,
          fromPhysicalLessonNo: existingCourse.currentLessonNo,
          toLearningRunNo: currentLearningRunNo + 1,
          toPhysicalLessonNo,
          abandonedSessionCount: startedSessions.length,
          actorSource: input.actor.source,
          actorSubject: input.actor.subject,
          createdAt: input.createdAt,
        }

        for (const state of wordStates.values()) {
          if (
            state.courseId === existingCourse.id &&
            (state.learningRunNo ?? 1) === currentLearningRunNo
          ) {
            wordStateSnapshots.push({
              ...state,
              learningRunNo: currentLearningRunNo,
              archivedAt: input.createdAt,
              resetOperationHash: input.operationHash,
            })
          }
        }
        for (const session of startedSessions) {
          sessions.set(session.id, { ...session, status: 'abandoned' })
        }

        const resetCourse: CourseRecord = {
          ...existingCourse,
          currentLessonNo: toPhysicalLessonNo,
          currentLearningRunNo: currentLearningRunNo + 1,
          currentRunStartLessonNo: toPhysicalLessonNo,
        }
        courses.set(resetCourse.id, resetCourse)
        resetOperations.set(operation.operationHash, operation)
        ledger.insert({
          operationHash: operation.operationHash,
          kind: 'reset_course_progress',
          targetId: operation.courseId,
          requestFingerprint: operation.requestFingerprint,
          outcomeLearningRunNo: operation.toLearningRunNo,
          outcomePhysicalLessonNo: operation.toPhysicalLessonNo,
          abandonedSessionCount: operation.abandonedSessionCount,
          createdAt: operation.createdAt,
        })

        return { course: resetCourse, operation }
      })
    },

    async getLearningRunWordStateSnapshots(input) {
      return wordStateSnapshots
        .filter(
          (snapshot) =>
            snapshot.courseId === input.courseId &&
            snapshot.learningRunNo === input.learningRunNo,
        )
        .map((snapshot) => ({ ...snapshot }))
    },
  }
}
