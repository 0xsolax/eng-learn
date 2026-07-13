import type { WordStage } from './content'
import type {
  LessonTaskDto,
  TaskAnswerFeedback,
} from '../api/taskSchemas'

export type CourseStatus = 'active' | 'paused' | 'completed'

export type LearnerRecordView = {
  id: string
  name: string
  accessCode: string
}

export type CourseView = {
  id: string
  learnerId: string
  sourceVersionId: string
  currentLessonNo: number
  status: CourseStatus
}

export type CreatedCourse = {
  learner: LearnerRecordView
  course: CourseView
}

export type LessonSessionStatus = 'started' | 'completed' | 'abandoned'

export type LessonTaskStatus = 'pending' | 'completed' | 'skipped'

export type LessonSessionView = {
  id: string
  courseId: string
  lessonNo: number
  status: LessonSessionStatus
  taskCount: number
  completedTaskCount: number
}

export type LessonTaskView = LessonTaskDto

export type StartedLesson = {
  session: LessonSessionView
  tasks: LessonTaskView[]
}

export type ReviewScore = 0 | 1 | 2 | 3

export const isPassingReviewScore = (score: ReviewScore): boolean => score >= 2

export type UserWordStateView = {
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
  status: 'new' | 'learning' | 'reviewing' | 'mastered' | 'suspended'
}

export type ReviewLogView = {
  id: string
  sessionId: string
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

export type SubmittedAnswer = {
  wordState: UserWordStateView
  reviewLog: ReviewLogView
}

export type SubmittedTaskAnswer = SubmittedAnswer & {
  feedback: TaskAnswerFeedback
}

export type CompletedLesson = {
  course: CourseView
  session: LessonSessionView
}
