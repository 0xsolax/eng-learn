import {
  adminCourseListSchema,
  courseHomeSchema,
  lessonReportSchema,
  type AdminCourseListDto,
  type CourseHomeDto,
  type LessonReportDto,
} from '../../shared/api/courseSchemas'
import { isPassingReviewScore, type UserWordStateView } from '../../shared/domain/course'
import type { CourseRecord, CourseRepository } from '../repositories/courseRepository'
import type { ContentRepository, SourceVersionSnapshot } from '../repositories/contentRepository'
import { DomainError } from '../errors/DomainError'

export type CourseQueryPrincipal = {
  learnerId: string
  courseId: string
}

export type CourseQueryService = {
  listAdminCourses(): Promise<AdminCourseListDto>
  getCourseHome(principal: CourseQueryPrincipal): Promise<CourseHomeDto>
  getLessonReport(
    principal: CourseQueryPrincipal,
    sessionId: string,
  ): Promise<LessonReportDto>
}

export const createCourseQueryService = (input: {
  contentRepository: ContentRepository
  courseRepository: CourseRepository
}): CourseQueryService => ({
  async listAdminCourses() {
    const records = await input.courseRepository.listAdminCourses()

    return adminCourseListSchema.parse({
      courses: records.map((record) => ({
        learner: record.learner,
        course: toCourseView(record.course),
        credentialVersion: record.credentialVersion,
      })),
    })
  },

  async getCourseHome(principal) {
    const course = await requireOwnedCourse(input.courseRepository, principal)

    if (course.status !== 'active') {
      throw new DomainError('course_unavailable', 'Course is not active')
    }

    const sourceVersion = await requireSourceVersion(
      input.contentRepository,
      course.sourceVersionId,
    )
    const wordStates = await input.courseRepository.getWordStates(course.id)
    const started = await input.courseRepository.getStartedLesson(
      course.id,
      course.currentLessonNo,
    )
    const previousCompletedLesson =
      await input.courseRepository.getLatestCompletedLessonBefore({
        courseId: course.id,
        beforeLessonNo: course.currentLessonNo,
      })
    const counts = started
      ? countStartedLessonWords(started.tasks, wordStates, course.currentLessonNo)
      : countNextLessonWords(sourceVersion, wordStates, course.currentLessonNo)

    return courseHomeSchema.parse({
      course: toCourseView(course),
      ...counts,
      action: started ? 'continue' : 'start',
      ...(started ? { startedSessionId: started.session.id } : {}),
      lessonPath: createLessonPath(
        course.currentLessonNo,
        previousCompletedLesson?.lessonNo,
      ),
    })
  },

  async getLessonReport(principal, sessionId) {
    const course = await requireOwnedCourse(input.courseRepository, principal)
    const snapshot = await input.courseRepository.getLessonReportSnapshot({
      sessionId,
      courseId: course.id,
    })

    if (!snapshot) {
      throw new DomainError('forbidden_resource', 'Lesson report access is forbidden')
    }

    if (snapshot.session.status !== 'completed') {
      throw new DomainError('report_unavailable', 'Lesson report is not available')
    }

    const sourceVersion = await requireSourceVersion(
      input.contentRepository,
      course.sourceVersionId,
    )
    const primaryTasks = snapshot.tasks.filter((task) => task.role === 'primary')
    const primaryTaskIds = new Set(primaryTasks.map((task) => task.id))
    const primaryLogs = snapshot.reviewLogs.filter((log) => primaryTaskIds.has(log.taskId))
    const loggedTaskIds = new Set(snapshot.reviewLogs.map((log) => log.taskId))
    const hasIncompleteV2Audit =
      snapshot.session.queuePolicyVersion === 'v2_3_6_cap3' &&
      (snapshot.tasks.some(
        (task) => task.status === 'completed' && !loggedTaskIds.has(task.id),
      ) ||
        snapshot.reviewLogs.some(
          (log) => !isPassingReviewScore(log.score) && log.queueDisposition === undefined,
        ))

    if (hasIncompleteV2Audit) {
      throw new DomainError('dependency_failure', 'Completed v2 task audit is incomplete')
    }

    const loggedPrimaryTaskIds = new Set(primaryLogs.map((log) => log.taskId))
    const hasMissingCompletedLog = primaryTasks.some(
      (task) => task.status === 'completed' && !loggedPrimaryTaskIds.has(task.id),
    )

    if (hasMissingCompletedLog) {
      throw new DomainError('dependency_failure', 'Completed primary task audit is incomplete')
    }

    const needsPracticeIds = new Set(
      primaryLogs.filter((log) => !isPassingReviewScore(log.score)).map((log) => log.wordId),
    )
    for (const log of snapshot.reviewLogs) {
      if (
        log.queueDisposition === 'deferred_cap' ||
        log.queueDisposition === 'deferred_capacity'
      ) {
        needsPracticeIds.add(log.wordId)
      }
    }
    const progressIds = new Set(
      primaryLogs
        .filter((log) => isPassingReviewScore(log.score) && !needsPracticeIds.has(log.wordId))
        .map((log) => log.wordId),
    )
    const correctCount = primaryLogs.filter((log) => isPassingReviewScore(log.score)).length

    return lessonReportSchema.parse({
      lessonNo: snapshot.session.lessonNo,
      completedTaskCount: snapshot.tasks.filter((task) => task.status === 'completed').length,
      totalTaskCount: snapshot.tasks.length,
      correctRate: primaryLogs.length === 0 ? 0 : correctCount / primaryLogs.length,
      needsPracticeWords: mapReportWords(primaryTasks, needsPracticeIds, sourceVersion),
      progressWords: mapReportWords(primaryTasks, progressIds, sourceVersion),
      nextLessonNo: course.currentLessonNo,
      courseStatus: course.status,
    })
  },
})

const requireOwnedCourse = async (
  repository: CourseRepository,
  principal: CourseQueryPrincipal,
): Promise<CourseRecord> => {
  const course = await repository.getCourseForLearner(principal)

  if (!course) {
    throw new DomainError('forbidden_resource', 'Course access is forbidden')
  }

  return course
}

const requireSourceVersion = async (
  repository: ContentRepository,
  sourceVersionId: string,
): Promise<SourceVersionSnapshot> => {
  const sourceVersion = await repository.getSourceVersion(sourceVersionId)

  if (!sourceVersion || sourceVersion.version.status !== 'published') {
    throw new DomainError('dependency_failure', 'Course source snapshot is unavailable')
  }

  return sourceVersion
}

const countStartedLessonWords = (
  tasks: Array<{ wordId: string; role: 'primary' | 'bridge' | 'reflux' }>,
  wordStates: Array<{ wordId: string; firstLessonNo: number }>,
  lessonNo: number,
): { newWordCount: number; reviewWordCount: number } => {
  const statesByWord = new Map(wordStates.map((state) => [state.wordId, state]))
  const primaryWordIds = new Set(
    tasks.filter((task) => task.role === 'primary').map((task) => task.wordId),
  )
  let newWordCount = 0
  let reviewWordCount = 0

  for (const wordId of primaryWordIds) {
    const state = statesByWord.get(wordId)

    if (!state) {
      throw new DomainError('dependency_failure', 'Lesson word state is unavailable')
    }

    if (state.firstLessonNo === lessonNo) newWordCount += 1
    else reviewWordCount += 1
  }

  return { newWordCount, reviewWordCount }
}

const countNextLessonWords = (
  sourceVersion: SourceVersionSnapshot,
  wordStates: Array<{
    wordId: string
    groupId: string
    nextDueLessonNo: number
    status: UserWordStateView['status']
  }>,
  lessonNo: number,
): { newWordCount: number; reviewWordCount: number } => {
  const activatedGroupIds = new Set(wordStates.map((state) => state.groupId))
  const nextGroup = sourceVersion.groups.find((group) => !activatedGroupIds.has(group.id))
  const newWordCount = nextGroup
    ? sourceVersion.words.filter(
        (word) =>
          word.orderIndex >= nextGroup.startOrderIndex &&
          word.orderIndex <= nextGroup.endOrderIndex,
      ).length
    : 0
  const reviewWordCount = new Set(
    wordStates
      .filter(
        (state) => state.status !== 'suspended' && state.nextDueLessonNo <= lessonNo,
      )
      .map((state) => state.wordId),
  ).size

  return { newWordCount, reviewWordCount }
}

const createLessonPath = (
  currentLessonNo: number,
  previousCompletedLessonNo?: number,
): Array<{ lessonNo: number; status: 'completed' | 'current' | 'locked' }> => [
  ...(previousCompletedLessonNo === undefined
    ? []
    : [{ lessonNo: previousCompletedLessonNo, status: 'completed' as const }]),
  { lessonNo: currentLessonNo, status: 'current' },
  { lessonNo: currentLessonNo + 1, status: 'locked' },
]

const mapReportWords = (
  primaryTasks: Array<{ wordId: string }>,
  includedWordIds: Set<string>,
  sourceVersion: SourceVersionSnapshot,
): Array<{ id: string; word: string }> => {
  const wordsById = new Map(sourceVersion.words.map((word) => [word.id, word.word]))
  const orderedWordIds = Array.from(
    new Set(
      primaryTasks
        .map((task) => task.wordId)
        .filter((wordId) => includedWordIds.has(wordId)),
    ),
  )

  return orderedWordIds.map((wordId) => {
    const word = wordsById.get(wordId)

    if (!word) {
      throw new DomainError('dependency_failure', `Report word ${wordId} is unavailable`)
    }

    return { id: wordId, word }
  })
}

const toCourseView = (course: CourseRecord) => ({
  id: course.id,
  learnerId: course.learnerId,
  sourceVersionId: course.sourceVersionId,
  currentLessonNo: course.currentLessonNo,
  status: course.status,
})
