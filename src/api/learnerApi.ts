import {
  completedLessonSchema,
  courseHomeSchema,
  establishedLearnerSessionSchema,
  lessonReportSchema,
  restoredLearnerSessionSchema,
  startedLessonSchema,
} from '@shared/api/courseSchemas'
import { enterCourseByAccessCodeRequestSchema } from '@shared/api/schemas'
import {
  previewSentenceOutputRequestSchema,
  sentenceOutputPreviewSchema,
  submitTaskAnswerRequestSchema,
  taskAnswerResultSchema,
} from '@shared/api/taskSchemas'
import { z } from 'zod'
import { createHttpClient } from './httpClient'

type HttpClient = ReturnType<typeof createHttpClient>
export type PreviewSentenceOutputRequest = z.input<
  typeof previewSentenceOutputRequestSchema
>
export type SubmitAnswerRequest = z.input<typeof submitTaskAnswerRequestSchema>
const logoutResultSchema = z.object({ loggedOut: z.literal(true) }).strict()
const resourceIdSchema = z.string().trim().min(1)

export const createLearnerApi = (client: HttpClient = createHttpClient()) => ({
  exchangeAccessCode(accessCode: string) {
    return client.request('/api/app/session/by-code', {
      dataSchema: establishedLearnerSessionSchema,
      method: 'POST',
      json: enterCourseByAccessCodeRequestSchema.parse({ accessCode }),
    })
  },
  restoreSession() {
    return client.request('/api/app/session', {
      dataSchema: restoredLearnerSessionSchema,
    })
  },
  getCourseHome() {
    return client.request('/api/app/course', {
      dataSchema: courseHomeSchema,
    })
  },
  logout() {
    return client.request('/api/app/session/logout', {
      dataSchema: logoutResultSchema,
      method: 'POST',
    })
  },
  startLesson(courseId: string) {
    return client.request(
      `/api/app/courses/${encodePathSegment(courseId)}/lessons/start`,
      {
        dataSchema: startedLessonSchema,
        method: 'POST',
      },
    )
  },
  getLesson(sessionId: string) {
    return client.request(`/api/app/lessons/${encodePathSegment(sessionId)}`, {
      dataSchema: startedLessonSchema,
    })
  },
  previewSentenceOutput(
    sessionId: string,
    taskId: string,
    preview: PreviewSentenceOutputRequest,
  ) {
    return client.request(lessonTaskActionPath(sessionId, taskId, 'preview'), {
      dataSchema: sentenceOutputPreviewSchema,
      method: 'POST',
      json: previewSentenceOutputRequestSchema.parse(preview),
    })
  },
  submitAnswer(
    sessionId: string,
    taskId: string,
    submission: SubmitAnswerRequest,
  ) {
    return client.request(lessonTaskActionPath(sessionId, taskId, 'answer'), {
      dataSchema: taskAnswerResultSchema,
      method: 'POST',
      json: submitTaskAnswerRequestSchema.parse(submission),
    })
  },
  completeLesson(sessionId: string) {
    return client.request(
      `/api/app/lessons/${encodePathSegment(sessionId)}/complete`,
      {
        dataSchema: completedLessonSchema,
        method: 'POST',
      },
    )
  },
  getLessonReport(sessionId: string) {
    return client.request(`/api/app/lessons/${encodePathSegment(sessionId)}/report`, {
      dataSchema: lessonReportSchema,
    })
  },
})

const encodePathSegment = (resourceId: string): string =>
  encodeURIComponent(resourceIdSchema.parse(resourceId))

const lessonTaskActionPath = (
  sessionId: string,
  taskId: string,
  action: 'preview' | 'answer',
): string =>
  `/api/app/lessons/${encodePathSegment(sessionId)}/tasks/${encodePathSegment(taskId)}/${action}`

export default createLearnerApi
