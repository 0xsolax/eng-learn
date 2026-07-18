import {
  courseProgressResetResultSchema,
  type CourseProgressResetResultDto,
} from '../../shared/api/courseSchemas'
import {
  courseProgressResetRequestSchema,
} from '../../shared/api/schemas'
import type { z } from 'zod'
import { DomainError } from '../errors/DomainError'
import type { CourseRecord, CourseRepository } from '../repositories/courseRepository'
import type { CourseProgressResetOperationRecord } from '../repositories/courseRepository'
import { getCourseRunLessonNo } from '../repositories/courseRepository'
import type { AdminOperationLedgerReader } from '../repositories/adminOperationLedger'
import type { AdminIdentity } from '../security/adminAuthentication'
import { prepareAdminOperation } from './adminOperation'

export type CourseProgressResetCommand = z.input<
  typeof courseProgressResetRequestSchema
>

export type LearningProgressService = {
  resetCourseProgress(
    courseId: string,
    command: CourseProgressResetCommand,
    actor: Pick<AdminIdentity, 'source' | 'subject'>,
  ): Promise<CourseProgressResetResultDto>
}

export const createLearningProgressService = (input: {
  courseRepository: CourseRepository
  operationLedger?: AdminOperationLedgerReader
  now?: () => Date
}): LearningProgressService => ({
  async resetCourseProgress(courseId, rawCommand, actor) {
    const command = courseProgressResetRequestSchema.parse(rawCommand)
    const prepared = await prepareAdminOperation(command.operationToken, {
      kind: 'reset_course_progress',
      courseId,
      expectedLearningRunNo: command.expectedLearningRunNo,
      expectedCurrentLessonNo: command.expectedCurrentLessonNo,
    })
    const existing = await input.courseRepository.getCourseProgressResetOperation(
      prepared.operationHash,
    )

    if (existing) {
      if (
        existing.courseId !== courseId ||
        existing.requestFingerprint !== prepared.requestFingerprint
      ) {
        throw new DomainError(
          'idempotency_conflict',
          'Admin operation token was already used for a different request',
        )
      }
      const course = await input.courseRepository.getCourse(courseId)
      if (!course) throw new DomainError('dependency_failure', 'Reset course is unavailable')
      return toResult(
        toCommittedCourse(course, existing),
        existing,
      )
    }

    const registered = await input.operationLedger?.get(prepared.operationHash)
    if (
      registered &&
      (registered.kind !== 'reset_course_progress' ||
        registered.targetId !== courseId ||
        registered.requestFingerprint !== prepared.requestFingerprint)
    ) {
      throw new DomainError(
        'idempotency_conflict',
        'Admin operation token was already used for a different request',
      )
    }

    const outcome = await input.courseRepository.resetCourseProgress({
      courseId,
      operationHash: prepared.operationHash,
      requestFingerprint: prepared.requestFingerprint,
      expectedLearningRunNo: command.expectedLearningRunNo,
      expectedCurrentRunLessonNo: command.expectedCurrentLessonNo,
      actor,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    })

    return toResult(toCommittedCourse(outcome.course, outcome.operation), outcome.operation)
  },
})

const toResult = (
  course: CourseRecord,
  operation: CourseProgressResetOperationRecord,
): CourseProgressResetResultDto =>
  courseProgressResetResultSchema.parse({
    course: {
      id: course.id,
      learnerId: course.learnerId,
      sourceVersionId: course.sourceVersionId,
      currentLessonNo: getCourseRunLessonNo(course),
      status: course.status,
    },
    learningRunNo: operation.toLearningRunNo,
    abandonedSessionCount: operation.abandonedSessionCount,
    historyPreserved: true,
  })

const toCommittedCourse = (
  course: CourseRecord,
  operation: CourseProgressResetOperationRecord,
): CourseRecord => ({
  ...course,
  currentLessonNo: operation.toPhysicalLessonNo,
  currentLearningRunNo: operation.toLearningRunNo,
  currentRunStartLessonNo: operation.toPhysicalLessonNo,
  status: 'active',
})
