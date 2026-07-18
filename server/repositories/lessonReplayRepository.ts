import type { ReviewScore } from '../../shared/domain/course'
import type { LessonTaskRecord } from './courseRepository'

export type LessonReplayStatus = 'started' | 'completed'
export type LessonReplayTaskStatus = 'pending' | 'completed'

export type LessonReplaySessionRecord = {
  id: string
  courseId: string
  sourceSessionId: string
  sourceLearningRunNo: number
  sourceRunLessonNo: number
  status: LessonReplayStatus
  taskCount: number
  completedTaskCount: number
  correctCount: number
  wrongCount: number
  startedAt: string
  completedAt?: string
}

export type LessonReplayTaskStateRecord = {
  id: string
  replaySessionId: string
  sourceTaskId: string
  orderIndex: number
  status: LessonReplayTaskStatus
  submissionJson?: string
  score?: ReviewScore
  draftAnswer?: string
  referenceRevealedAt?: string
  answeredAt?: string
}

export type LessonReplayTaskRecord = LessonReplayTaskStateRecord & {
  sourceTask: LessonTaskRecord
}

export type LessonReplaySnapshot = {
  session: LessonReplaySessionRecord
  tasks: LessonReplayTaskRecord[]
}

export type CreateLessonReplayInput = LessonReplaySnapshot

export type RecordLessonReplayAnswerInput = {
  replaySessionId: string
  taskId: string
  submissionJson: string
  score: ReviewScore
  answeredAt: string
}

export type SaveLessonReplayPreviewInput = {
  replaySessionId: string
  taskId: string
  draft: string
  revealedAt: string
}

export type LessonReplayRepository = {
  getStartedReplay(input: {
    courseId: string
    sourceSessionId: string
  }): Promise<LessonReplaySnapshot | undefined>
  getReplayForCourse(input: {
    replaySessionId: string
    courseId: string
  }): Promise<LessonReplaySnapshot | undefined>
  createReplay(input: CreateLessonReplayInput): Promise<LessonReplaySnapshot>
  saveSentenceOutputPreview(
    input: SaveLessonReplayPreviewInput,
  ): Promise<LessonReplayTaskRecord | undefined>
  recordAnswer(
    input: RecordLessonReplayAnswerInput,
  ): Promise<LessonReplayTaskRecord | undefined>
  completeReplay(input: {
    replaySessionId: string
    completedAt: string
  }): Promise<LessonReplaySnapshot | undefined>
}
