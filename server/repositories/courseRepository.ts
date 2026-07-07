import type {
  CourseStatus,
  CreatedCourse,
  CompletedLesson,
  LessonSessionStatus,
  LessonTaskStatus,
  ReviewScore,
  StartedLesson,
  SubmittedAnswer,
  UserWordStateView,
} from '../../shared/domain/course'
import type { WordStage } from '../../shared/domain/content'

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
  startedAt: string
  completedAt?: string
}

export type LessonTaskRecord = {
  id: string
  sessionId: string
  courseId: string
  wordId: string
  stage: string
  taskType: string
  prompt: unknown
  answer: unknown
  orderIndex: number
  status: LessonTaskStatus
  createdAt: string
}

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
  lessonNo: number
  createdAt: string
}

export type CreateCourseInput = {
  learner: LearnerRecord
  course: CourseRecord
}

export type CreateLessonInput = {
  session: LessonSessionRecord
  tasks: LessonTaskRecord[]
  wordStates: UserWordStateRecord[]
}

export type RecordAnswerInput = {
  task: LessonTaskRecord
  wordState: UserWordStateRecord
  reviewLog: ReviewLogRecord
  newTasks?: LessonTaskRecord[]
}

export type CourseRepository = {
  createCourse(input: CreateCourseInput): Promise<CreatedCourse>
  getCourse(courseId: string): Promise<CourseRecord | undefined>
  getCourseByAccessCode(accessCode: string): Promise<CreatedCourse | undefined>
  getStartedLesson(courseId: string, lessonNo: number): Promise<StartedLesson | undefined>
  createLesson(input: CreateLessonInput): Promise<StartedLesson>
  getLessonTask(sessionId: string, taskId: string): Promise<LessonTaskRecord | undefined>
  getLessonTasks(sessionId: string): Promise<LessonTaskRecord[]>
  getLessonSession(sessionId: string): Promise<LessonSessionRecord | undefined>
  getWordStates(courseId: string): Promise<UserWordStateRecord[]>
  getWordState(courseId: string, wordId: string): Promise<UserWordStateRecord | undefined>
  getSubmittedAnswer(sessionId: string, taskId: string): Promise<SubmittedAnswer | undefined>
  recordAnswer(input: RecordAnswerInput): Promise<SubmittedAnswer>
  completeLesson(sessionId: string, completedAt: string): Promise<CompletedLesson>
}
