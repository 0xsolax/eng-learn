import { inject, type InjectionKey } from 'vue'
import type { z } from 'zod'
import type {
  CompletedLessonDto,
  CourseHomeDto,
  LessonReportDto,
  StartedLessonDto,
} from '@shared/api/courseSchemas'
import type {
  SentenceOutputPreview,
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
  TaskAnswerResult,
} from '@shared/api/taskSchemas'
import type {
  establishedLearnerSessionSchema,
  restoredLearnerSessionSchema,
} from '@shared/api/courseSchemas'

export type EstablishedLearnerSession = z.output<typeof establishedLearnerSessionSchema>
export type RestoredLearnerSession = z.output<typeof restoredLearnerSessionSchema>
export type LearnerSession = EstablishedLearnerSession | RestoredLearnerSession

export type LearnerApiPort = {
  exchangeAccessCode(accessCode: string): Promise<EstablishedLearnerSession>
  restoreSession(): Promise<RestoredLearnerSession>
  logout(): Promise<{ loggedOut: true }>
  getCourseHome(): Promise<CourseHomeDto>
  startLesson(courseId: string): Promise<StartedLessonDto>
  getLesson(sessionId: string): Promise<StartedLessonDto>
  previewSentenceOutput(
    sessionId: string,
    taskId: string,
    preview: SentenceOutputPreviewRequest,
  ): Promise<SentenceOutputPreview>
  submitAnswer(
    sessionId: string,
    taskId: string,
    submission: SubmitTaskAnswerRequest,
  ): Promise<TaskAnswerResult>
  completeLesson(sessionId: string): Promise<CompletedLessonDto>
  getLessonReport(sessionId: string): Promise<LessonReportDto>
}

export const learnerApiKey: InjectionKey<LearnerApiPort> = Symbol('learner-api')

export const useLearnerApi = (
  createDefault: () => LearnerApiPort,
): LearnerApiPort => inject(learnerApiKey, null) ?? createDefault()
