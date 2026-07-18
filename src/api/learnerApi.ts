import {
  completedLessonSchema,
  completedLessonPageSchema,
  courseHomeSchema,
  establishedLearnerSessionSchema,
  lessonReportSchema,
  restoredLearnerSessionSchema,
  lessonReplaySchema,
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
const completedLessonPageRequestSchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()

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
  listCompletedLessons(
    courseId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const page = completedLessonPageRequestSchema.parse(input)
    const query = new URLSearchParams()
    if (page.cursor) query.set('cursor', page.cursor)
    if (page.limit !== undefined) query.set('limit', String(page.limit))
    const suffix = query.size === 0 ? '' : `?${query.toString()}`

    return client.request(
      `/api/app/courses/${encodePathSegment(courseId)}/completed-lessons${suffix}`,
      { dataSchema: completedLessonPageSchema },
    )
  },
  startLessonReplay(sourceSessionId: string) {
    return client.request(
      `/api/app/lessons/${encodePathSegment(sourceSessionId)}/replays`,
      { dataSchema: lessonReplaySchema, method: 'POST' },
    )
  },
  getLessonReplay(replaySessionId: string) {
    return client.request(
      `/api/app/lesson-replays/${encodePathSegment(replaySessionId)}`,
      { dataSchema: lessonReplaySchema },
    )
  },
  previewReplaySentenceOutput(
    replaySessionId: string,
    taskId: string,
    preview: PreviewSentenceOutputRequest,
  ) {
    return client.request(
      replayTaskActionPath(replaySessionId, taskId, 'preview'),
      {
        dataSchema: sentenceOutputPreviewSchema,
        method: 'POST',
        json: previewSentenceOutputRequestSchema.parse(preview),
      },
    )
  },
  submitReplayAnswer(
    replaySessionId: string,
    taskId: string,
    submission: SubmitAnswerRequest,
  ) {
    return client.request(
      replayTaskActionPath(replaySessionId, taskId, 'answer'),
      {
        dataSchema: taskAnswerResultSchema,
        method: 'POST',
        json: submitTaskAnswerRequestSchema.parse(submission),
      },
    )
  },
  completeLessonReplay(replaySessionId: string) {
    return client.request(
      `/api/app/lesson-replays/${encodePathSegment(replaySessionId)}/complete`,
      { dataSchema: lessonReplaySchema, method: 'POST' },
    )
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

const replayTaskActionPath = (
  replaySessionId: string,
  taskId: string,
  action: 'preview' | 'answer',
): string =>
  `/api/app/lesson-replays/${encodePathSegment(replaySessionId)}/tasks/${encodePathSegment(taskId)}/${action}`

export default createLearnerApi
