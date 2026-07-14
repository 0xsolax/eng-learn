import type {
  CourseStatus,
  CourseView,
  CreatedCourse,
  CompletedLesson,
  LessonSessionStatus,
  LessonQueuePolicyVersion,
  LessonTaskStatus,
  QueueDisposition,
  ReviewScore,
  StartedLesson,
  SubmittedAnswer,
  UserWordStateView,
} from '../../shared/domain/course'
import type { WordStage } from '../../shared/domain/content'
import type {
  ExerciseItemContent,
  LessonTaskRole,
  SentenceOutputPreview,
} from '../../shared/api/taskSchemas'
import type { CreateCourseAdminOperation } from './adminOperationLedger'
import type { AccessCodeHash } from '../security/credentialCrypto'

export type {
  LessonQueuePolicyVersion,
  QueueDisposition,
} from '../../shared/domain/course'

export type LearnerRecord = {
  id: string
  name: string
  accessCode: string
  createdAt: string
}

export type CourseRecord = {
  id: string
  learnerId: string
  sourceVersionId: string
  currentLessonNo: number
  status: CourseStatus
  createdAt: string
}

export type LessonSessionRecord = {
  id: string
  courseId: string
  lessonNo: number
  status: LessonSessionStatus
  taskCount: number
  completedTaskCount: number
  correctCount: number
  wrongCount: number
  queuePolicyVersion: LessonQueuePolicyVersion
  startedAt: string
  completedAt?: string
}

type LessonTaskRecordBase = {
  id: string
  sessionId: string
  courseId: string
  wordId: string
  orderIndex: number
  status: LessonTaskStatus
  role: LessonTaskRole
  required: boolean
  refluxSourceTaskId?: string
  draftAnswer?: string
  referenceRevealedAt?: string
  createdAt: string
}

export type LessonTaskRecord = LessonTaskRecordBase & ExerciseItemContent

export type UserWordStateRecord = {
  id: string
  courseId: string
  wordId: string
  groupId: string
  stage: WordStage
  totalAttemptCount: number
  totalCorrectCount: number
  totalWrongCount: number
  currentStreak: number
  wrongStreak: number
  lapseCount: number
  easeFactor: number
  masteryScore: number
  firstLessonNo: number
  lastSeenLessonNo?: number
  nextDueLessonNo: number
  status: UserWordStateView['status']
  createdAt: string
  updatedAt: string
}

export type ReviewLogRecord = {
  id: string
  sessionId: string
  taskId: string
  courseId: string
  wordId: string
  stage: WordStage
  taskType: string
  userAnswer?: string
  correctAnswer: string
  score: ReviewScore
  queueDisposition?: QueueDisposition
  lessonNo: number
  createdAt: string
}

export type CreateCourseInput = {
  learner: LearnerRecord
  course: CourseRecord
  adminOperation?: CreateCourseAdminOperation
}

export type CourseAccessIdentity = {
  learner: {
    id: string
    name: string
  }
  course: CourseView
}

export type CourseCredentialMatch = {
  identity: CourseAccessIdentity
  credentialVersion: number
}

export type AdminCourseReadRecord = {
  learner: {
    id: string
    name: string
  }
  course: CourseRecord
  credentialVersion: number
}

export type AdminLearnerCredential = {
  accessCodeHash: AccessCodeHash
  credentialVersion: number
}

export type LessonQueueSnapshot = {
  session: LessonSessionRecord
  tasks: LessonTaskRecord[]
  reviewLogs: ReviewLogRecord[]
}

export type LessonReportSnapshot = LessonQueueSnapshot

export type CreateLessonInput = {
  session: LessonSessionRecord
  tasks: LessonTaskRecord[]
  wordStates: UserWordStateRecord[]
}

export type AdvanceCourseLessonNoInput = {
  courseId: string
  expectedLessonNo: number
  nextLessonNo: number
}

export type RecordAnswerInput = {
  task: LessonTaskRecord
  wordState: UserWordStateRecord
  reviewLog: ReviewLogRecord
  taskMutations: LessonTaskRecord[]
  reorderedExistingTaskIds: string[]
  taskCount: number
  completedTaskCount: number
  persistWordState: boolean
  expectedQueuePolicyVersion: LessonQueuePolicyVersion
}

export type RecordedAnswerOutcome = {
  submittedAnswer: SubmittedAnswer
  queueDisposition?: QueueDisposition
}

export type SaveSentenceOutputPreviewInput = {
  sessionId: string
  courseId: string
  taskId: string
  draft: string
  revealedAt: string
}

export type CompleteLessonInput = {
  sessionId: string
  completedAt: string
  nextLessonNo: number
  skippablePrimaryTaskIds: string[]
}

export type CourseRepository = {
  createCourse(input: CreateCourseInput): Promise<CreatedCourse>
  getCourse(courseId: string): Promise<CourseRecord | undefined>
  getCourseForLearner(input: {
    courseId: string
    learnerId: string
  }): Promise<CourseRecord | undefined>
  getCourseCredentialByAccessCode(accessCode: string): Promise<CourseCredentialMatch | undefined>
  getCourseIdentityByAccessCode(accessCode: string): Promise<CourseAccessIdentity | undefined>
  getCourseByAccessCode(accessCode: string): Promise<CreatedCourse | undefined>
  getAdminLearnerCredential(learnerId: string): Promise<AdminLearnerCredential | undefined>
  listAdminCourses(): Promise<AdminCourseReadRecord[]>
  advanceCourseLessonNo(
    input: AdvanceCourseLessonNoInput,
  ): Promise<CourseRecord | undefined>
  getStartedLesson(courseId: string, lessonNo: number): Promise<StartedLesson | undefined>
  getLatestCompletedLessonBefore(input: {
    courseId: string
    beforeLessonNo: number
  }): Promise<LessonSessionRecord | undefined>
  createLesson(input: CreateLessonInput): Promise<StartedLesson>
  getLessonSessionForCourse(input: {
    sessionId: string
    courseId: string
  }): Promise<LessonSessionRecord | undefined>
  getLessonTaskForResource(input: {
    taskId: string
    sessionId: string
    courseId: string
  }): Promise<LessonTaskRecord | undefined>
  getLessonTask(sessionId: string, taskId: string): Promise<LessonTaskRecord | undefined>
  getLessonTasks(sessionId: string): Promise<LessonTaskRecord[]>
  getLessonSession(sessionId: string): Promise<LessonSessionRecord | undefined>
  getLessonQueueSnapshot(input: {
    sessionId: string
    courseId: string
  }): Promise<LessonQueueSnapshot | undefined>
  getLessonReportSnapshot(input: {
    sessionId: string
    courseId: string
  }): Promise<LessonReportSnapshot | undefined>
  saveSentenceOutputPreview(
    input: SaveSentenceOutputPreviewInput,
  ): Promise<SentenceOutputPreview | undefined>
  getWordStates(courseId: string): Promise<UserWordStateRecord[]>
  getWordState(courseId: string, wordId: string): Promise<UserWordStateRecord | undefined>
  getSubmittedAnswer(
    sessionId: string,
    taskId: string,
  ): Promise<RecordedAnswerOutcome | undefined>
  recordAnswer(input: RecordAnswerInput): Promise<RecordedAnswerOutcome>
  completeLesson(input: CompleteLessonInput): Promise<CompletedLesson | undefined>
}
