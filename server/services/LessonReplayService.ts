import {
  completedLessonPageSchema,
  lessonReplaySchema,
  type CompletedLessonPageDto,
  type LessonReplayDto,
} from '../../shared/api/courseSchemas'
import {
  lessonTaskSchema,
  previewSentenceOutputRequestSchema,
  submitTaskAnswerRequestSchema,
  type SentenceOutputPreview,
  type SentenceOutputPreviewRequest,
  type SubmitTaskAnswerRequest,
  type TaskAnswerResult,
} from '../../shared/api/taskSchemas'
import { isPassingReviewScore } from '../../shared/domain/course'
import { DomainError } from '../errors/DomainError'
import {
  getCourseLearningRunNo,
  getSessionLearningRunNo,
  getSessionRunLessonNo,
  type CourseRepository,
  type LessonSessionRecord,
} from '../repositories/courseRepository'
import type {
  LessonReplayRepository,
  LessonReplaySnapshot,
  LessonReplayTaskRecord,
} from '../repositories/lessonReplayRepository'
import { createTaskFeedback, evaluateTaskSubmission } from './taskEvaluation'

type LearnerPrincipal = {
  learnerId: string
  courseId: string
}

export type LessonReplayService = {
  listCompletedLessons(
    principal: LearnerPrincipal,
    input: { cursor?: string; limit: number },
  ): Promise<CompletedLessonPageDto>
  startReplay(
    principal: LearnerPrincipal,
    sourceSessionId: string,
  ): Promise<LessonReplayDto>
  getReplay(
    principal: LearnerPrincipal,
    replaySessionId: string,
  ): Promise<LessonReplayDto>
  previewSentenceOutput(
    principal: LearnerPrincipal,
    input: {
      replaySessionId: string
      taskId: string
      preview: SentenceOutputPreviewRequest
    },
  ): Promise<SentenceOutputPreview>
  submitAnswer(
    principal: LearnerPrincipal,
    input: {
      replaySessionId: string
      taskId: string
      submission: SubmitTaskAnswerRequest
    },
  ): Promise<TaskAnswerResult>
  completeReplay(
    principal: LearnerPrincipal,
    replaySessionId: string,
  ): Promise<LessonReplayDto>
}

export const createLessonReplayService = (input: {
  courseRepository: CourseRepository
  replayRepository: LessonReplayRepository
  now?: () => Date
}): LessonReplayService => {
  const now = input.now ?? (() => new Date())

  const requireOwnedActiveCourse = async (principal: LearnerPrincipal) => {
    const course = await input.courseRepository.getCourseForLearner(principal)

    if (!course) {
      throw new DomainError('forbidden_resource', 'Course access is forbidden')
    }
    if (course.status !== 'active') {
      throw new DomainError('course_unavailable', 'Course is not active')
    }

    return course
  }

  const requireReplay = async (
    principal: LearnerPrincipal,
    replaySessionId: string,
  ) => {
    await requireOwnedActiveCourse(principal)
    const replay = await input.replayRepository.getReplayForCourse({
      replaySessionId,
      courseId: principal.courseId,
    })

    if (!replay) {
      throw new DomainError('forbidden_resource', 'Replay access is forbidden')
    }

    return replay
  }

  return {
    async listCompletedLessons(principal, request) {
      const course = await requireOwnedActiveCourse(principal)
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
        throw new DomainError('bad_request', 'Completed lesson page limit is invalid')
      }
      const after = request.cursor ? parseCursor(request.cursor) : undefined
      const sessions = await input.courseRepository.listCompletedLessonSessions({
        courseId: course.id,
        ...(after ? { after } : {}),
        limit: request.limit + 1,
      })
      const page = sessions.slice(0, request.limit)
      const last = page.at(-1)

      return completedLessonPageSchema.parse({
        currentLearningRunNo: getCourseLearningRunNo(course),
        lessons: page.map((session) => ({
          sourceSessionId: session.id,
          learningRunNo: getSessionLearningRunNo(session),
          lessonNo: getSessionRunLessonNo(session),
          taskCount: session.taskCount,
          completedAt: session.completedAt,
        })),
        ...(sessions.length > request.limit && last
          ? { nextCursor: createCursor(last) }
          : {}),
      })
    },

    async startReplay(principal, sourceSessionId) {
      await requireOwnedActiveCourse(principal)
      const sourceSession = await input.courseRepository.getLessonSessionForCourse({
        sessionId: sourceSessionId,
        courseId: principal.courseId,
      })

      if (!sourceSession || sourceSession.status !== 'completed') {
        throw new DomainError('forbidden_resource', 'Completed lesson access is forbidden')
      }

      const existing = await input.replayRepository.getStartedReplay({
        courseId: principal.courseId,
        sourceSessionId,
      })
      if (existing) return toReplayDto(existing)

      const sourceTasks = await input.courseRepository.getLessonTasks(sourceSession.id)
      if (sourceTasks.length === 0) {
        throw new DomainError('course_unavailable', 'Completed lesson has no replayable tasks')
      }
      const replaySessionId = crypto.randomUUID()
      const startedAt = now().toISOString()
      const created = await input.replayRepository.createReplay({
        session: {
          id: replaySessionId,
          courseId: principal.courseId,
          sourceSessionId,
          sourceLearningRunNo: getSessionLearningRunNo(sourceSession),
          sourceRunLessonNo: getSessionRunLessonNo(sourceSession),
          status: 'started',
          taskCount: sourceTasks.length,
          completedTaskCount: 0,
          correctCount: 0,
          wrongCount: 0,
          startedAt,
        },
        tasks: sourceTasks
          .sort((left, right) => left.orderIndex - right.orderIndex)
          .map((sourceTask) => ({
            id: crypto.randomUUID(),
            replaySessionId,
            sourceTaskId: sourceTask.id,
            orderIndex: sourceTask.orderIndex,
            status: 'pending' as const,
            sourceTask,
          })),
      })

      return toReplayDto(created)
    },

    async getReplay(principal, replaySessionId) {
      return toReplayDto(await requireReplay(principal, replaySessionId))
    },

    async previewSentenceOutput(principal, request) {
      const preview = previewSentenceOutputRequestSchema.parse(request.preview)
      const replay = await requireReplay(principal, request.replaySessionId)
      const task = requireReplayTask(replay, request.taskId)

      if (task.sourceTask.taskType !== 'sentence_output') {
        throw new DomainError(
          'task_type_mismatch',
          'Only sentence-output replay tasks support a reference preview',
        )
      }
      requireCurrentPendingTask(replay, task)

      const saved = await input.replayRepository.saveSentenceOutputPreview({
        replaySessionId: replay.session.id,
        taskId: task.id,
        draft: preview.draft,
        revealedAt: now().toISOString(),
      })

      if (!saved?.draftAnswer || !saved.referenceRevealedAt) {
        throw new DomainError('conflict', 'Replay sentence preview could not be persisted')
      }
      if (saved.sourceTask.taskType !== 'sentence_output') {
        throw new DomainError('dependency_failure', 'Replay sentence snapshot is invalid')
      }

      return {
        taskId: saved.id,
        draft: saved.draftAnswer,
        referenceSentence: saved.sourceTask.answer.referenceSentence,
        revealedAt: saved.referenceRevealedAt,
      }
    },

    async submitAnswer(principal, request) {
      const submission = submitTaskAnswerRequestSchema.parse(request.submission)
      const replay = await requireReplay(principal, request.replaySessionId)
      const task = requireReplayTask(replay, request.taskId)

      if (task.status === 'completed' && task.score !== undefined) {
        return toAnswerResult(task)
      }
      requireCurrentPendingTask(replay, task)

      const evaluation = evaluateTaskSubmission(task.sourceTask, submission)
      if (
        task.sourceTask.taskType === 'sentence_output' &&
        (task.draftAnswer === undefined ||
          task.referenceRevealedAt === undefined ||
          submission.taskType !== 'sentence_output' ||
          submission.draft !== task.draftAnswer)
      ) {
        throw new DomainError(
          's5_preview_required',
          'Preview the persisted replay sentence draft before self-scoring',
        )
      }

      const saved = await input.replayRepository.recordAnswer({
        replaySessionId: replay.session.id,
        taskId: task.id,
        submissionJson: JSON.stringify(submission),
        score: evaluation.score,
        answeredAt: now().toISOString(),
      })

      if (!saved || saved.score === undefined) {
        throw new DomainError('conflict', 'Replay answer could not be persisted')
      }

      return toAnswerResult(saved)
    },

    async completeReplay(principal, replaySessionId) {
      const replay = await requireReplay(principal, replaySessionId)
      if (replay.session.status === 'completed') return toReplayDto(replay)
      if (replay.tasks.some((task) => task.status !== 'completed')) {
        throw new DomainError('conflict', 'Replay still has pending tasks')
      }

      const completed = await input.replayRepository.completeReplay({
        replaySessionId,
        completedAt: now().toISOString(),
      })
      if (!completed) {
        throw new DomainError('conflict', 'Replay still has pending tasks')
      }

      return toReplayDto(completed)
    },
  }
}

const requireReplayTask = (
  replay: LessonReplaySnapshot,
  taskId: string,
): LessonReplayTaskRecord => {
  const task = replay.tasks.find((candidate) => candidate.id === taskId)

  if (!task) throw new DomainError('forbidden_resource', 'Replay task access is forbidden')
  return task
}

const requireCurrentPendingTask = (
  replay: LessonReplaySnapshot,
  task: LessonReplayTaskRecord,
): void => {
  if (replay.session.status !== 'started' || task.status !== 'pending') {
    throw new DomainError('conflict', 'Replay task is no longer active')
  }
  const current = replay.tasks.find((candidate) => candidate.status === 'pending')
  if (current?.id !== task.id) {
    throw new DomainError('task_not_current', 'Only the first pending replay task can be used')
  }
}

const toAnswerResult = (task: LessonReplayTaskRecord): TaskAnswerResult => {
  if (task.score === undefined) {
    throw new DomainError('dependency_failure', 'Completed replay answer is unavailable')
  }

  return {
    taskId: task.id,
    score: task.score,
    correct: isPassingReviewScore(task.score),
    feedback: createTaskFeedback(task.sourceTask, task.score),
  }
}

const toReplayDto = (replay: LessonReplaySnapshot): LessonReplayDto =>
  lessonReplaySchema.parse({
    session: {
      id: replay.session.id,
      courseId: replay.session.courseId,
      sourceSessionId: replay.session.sourceSessionId,
      learningRunNo: replay.session.sourceLearningRunNo,
      lessonNo: replay.session.sourceRunLessonNo,
      status: replay.session.status,
      taskCount: replay.session.taskCount,
      completedTaskCount: replay.session.completedTaskCount,
      correctCount: replay.session.correctCount,
      wrongCount: replay.session.wrongCount,
    },
    tasks: replay.tasks.map((task) =>
      lessonTaskSchema.parse({
        id: task.id,
        sessionId: replay.session.id,
        courseId: replay.session.courseId,
        wordId: task.sourceTask.wordId,
        orderIndex: task.orderIndex,
        status: task.status,
        role: task.sourceTask.role,
        required: task.sourceTask.required,
        stage: task.sourceTask.stage,
        taskType: task.sourceTask.taskType,
        prompt: task.sourceTask.prompt,
        ...(task.sourceTask.taskType === 'sentence_output' &&
        task.draftAnswer !== undefined &&
        task.referenceRevealedAt !== undefined
          ? {
              preview: {
                draft: task.draftAnswer,
                referenceSentence: task.sourceTask.answer.referenceSentence,
                revealedAt: task.referenceRevealedAt,
              },
            }
          : {}),
      }),
    ),
  })

const CURSOR_PATTERN = /^v1\.(\d+)\.(\d+)\.(\d+)$/u

const parseCursor = (cursor: string) => {
  const match = CURSOR_PATTERN.exec(cursor)
  const values = match?.slice(1).map(Number)
  const [learningRunNo, runLessonNo, physicalLessonNo] = values ?? []

  if (
    !learningRunNo ||
    !runLessonNo ||
    !physicalLessonNo ||
    !values?.every(Number.isSafeInteger)
  ) {
    throw new DomainError('bad_request', 'Completed lesson cursor is invalid')
  }

  return { learningRunNo, runLessonNo, physicalLessonNo }
}

const createCursor = (session: LessonSessionRecord): string =>
  `v1.${String(getSessionLearningRunNo(session))}.${String(getSessionRunLessonNo(session))}.${String(session.lessonNo)}`
