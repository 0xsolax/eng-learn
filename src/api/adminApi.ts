import {
  adminExerciseItemSchema,
  adminExerciseItemListSchema,
  archivedSourceVersionSchema,
  approveExerciseItemsRequestSchema,
  batchApprovalResultSchema,
  buildCoverageSchema,
  editExerciseItemRequestSchema,
  exerciseReviewDecisionRequestSchema,
  exerciseReviewDecisionResultSchema,
  exerciseReviewEvaluateRequestSchema,
  exerciseReviewEvaluateResultSchema,
  exerciseReviewPreviewRequestSchema,
  exerciseReviewPreviewResultSchema,
  exerciseReviewWindowSchema,
  exerciseItemStatusResultSchema,
  importedSourceVersionSchema,
  publishedSourceVersionSchema,
  sourceVersionDetailSchema,
  sourceVersionListSchema,
} from '@shared/api/contentSchemas'
import {
  adminLoginRequestSchema,
  adminLogoutResultSchema,
  adminSessionSchema,
} from '@shared/api/adminAuthSchemas'
import {
  adminCourseListSchema,
  courseProgressResetResultSchema,
  createdCourseSchema,
  rotatedAccessCodeSchema,
  updatedLearnerLoginSchema,
} from '@shared/api/courseSchemas'
import {
  createCourseRequestSchema,
  courseProgressResetRequestSchema,
  importSourceVersionCommandSchema,
  rotateAccessCodeRequestSchema,
  updateLearnerLoginRequestSchema,
} from '@shared/api/schemas'
import { z } from 'zod'
import {
  getAdminSessionFailureCode,
  reportAdminAuthorizationFailure,
} from './adminAuthorizationBoundary'
import { createHttpClient, type HttpRequestOptions } from './httpClient'

type HttpClient = ReturnType<typeof createHttpClient>
export type ImportSourceVersionCommand = z.input<typeof importSourceVersionCommandSchema>
export type EditExerciseItemRequest = z.input<typeof editExerciseItemRequestSchema>
export type ExerciseReviewDecisionCommand = z.input<typeof exerciseReviewDecisionRequestSchema>
export type ExerciseReviewEvaluateCommand = z.input<typeof exerciseReviewEvaluateRequestSchema>
export type ExerciseReviewPreviewCommand = z.input<typeof exerciseReviewPreviewRequestSchema>
export type ApproveExerciseItemsRequest = z.input<
  typeof approveExerciseItemsRequestSchema
>
export type CreateCourseRequest = z.input<typeof createCourseRequestSchema>
export type RotateAccessCodeRequest = z.input<typeof rotateAccessCodeRequestSchema>
export type UpdateLearnerLoginRequest = z.input<typeof updateLearnerLoginRequestSchema>
export type CourseProgressResetRequest = z.input<typeof courseProgressResetRequestSchema>
export type AdminLoginRequest = z.input<typeof adminLoginRequestSchema>
const resourceIdSchema = z.string().trim().min(1)

export const createAdminApi = (client: HttpClient = createHttpClient()) => {
  const request = async <TSchema extends z.ZodType>(
    path: string,
    options: HttpRequestOptions<TSchema>,
    broadcastSessionFailure = true,
  ): Promise<z.output<TSchema>> => {
    try {
      return await client.request(path, options)
    } catch (error) {
      const sessionFailureCode = getAdminSessionFailureCode(error)
      if (broadcastSessionFailure && sessionFailureCode) {
        reportAdminAuthorizationFailure(sessionFailureCode)
      }
      throw error
    }
  }

  return {
    loginAdmin(command: AdminLoginRequest) {
      return request(
        '/api/admin/auth/login',
        {
          dataSchema: adminSessionSchema,
          method: 'POST',
          json: adminLoginRequestSchema.parse(command),
        },
        false,
      )
    },
    logoutAdmin() {
      return request(
        '/api/admin/auth/logout',
        {
          dataSchema: adminLogoutResultSchema,
          method: 'POST',
        },
        false,
      )
    },
    getAdminSession() {
      return request('/api/admin/session', {
        dataSchema: adminSessionSchema,
      })
    },
    listSourceVersions() {
      return request('/api/admin/source-versions', {
        dataSchema: sourceVersionListSchema,
      })
    },
    getSourceVersion(versionId: string) {
      return request(sourceVersionPath(versionId), {
        dataSchema: sourceVersionDetailSchema,
      })
    },
    importSourceVersion(command: ImportSourceVersionCommand) {
      return request('/api/admin/source-versions/import', {
        dataSchema: importedSourceVersionSchema,
        method: 'POST',
        json: importSourceVersionCommandSchema.parse(command),
      })
    },
    buildSourceVersion(versionId: string) {
      return request(`${sourceVersionPath(versionId)}/build`, {
        dataSchema: buildCoverageSchema,
        method: 'POST',
      })
    },
    getCoverage(versionId: string) {
      return request(`${sourceVersionPath(versionId)}/coverage`, {
        dataSchema: buildCoverageSchema,
      })
    },
    listExerciseItems(versionId: string) {
      return request(`${sourceVersionPath(versionId)}/exercises`, {
        dataSchema: adminExerciseItemListSchema,
      })
    },
    getExerciseItem(itemId: string) {
      return request(exerciseItemPath(itemId), {
        dataSchema: adminExerciseItemSchema,
      })
    },
    getExerciseReviewWindow(versionId: string, itemId?: string) {
      const query = itemId === undefined
        ? ''
        : `?${new URLSearchParams({ itemId: resourceIdSchema.parse(itemId) }).toString()}`

      return request(`${sourceVersionPath(versionId)}/review${query}`, {
        dataSchema: exerciseReviewWindowSchema,
      })
    },
    previewExerciseReview(itemId: string, command: ExerciseReviewPreviewCommand) {
      return request(`${exerciseItemPath(itemId)}/review/preview`, {
        dataSchema: exerciseReviewPreviewResultSchema,
        method: 'POST',
        json: exerciseReviewPreviewRequestSchema.parse(command),
      })
    },
    evaluateExerciseReview(itemId: string, command: ExerciseReviewEvaluateCommand) {
      return request(`${exerciseItemPath(itemId)}/review/evaluate`, {
        dataSchema: exerciseReviewEvaluateResultSchema,
        method: 'POST',
        json: exerciseReviewEvaluateRequestSchema.parse(command),
      })
    },
    decideExerciseReview(itemId: string, command: ExerciseReviewDecisionCommand) {
      return request(`${exerciseItemPath(itemId)}/review/decision`, {
        dataSchema: exerciseReviewDecisionResultSchema,
        method: 'POST',
        json: exerciseReviewDecisionRequestSchema.parse(command),
      })
    },
    editExerciseItem(itemId: string, command: EditExerciseItemRequest) {
      return request(exerciseItemPath(itemId), {
        dataSchema: adminExerciseItemSchema,
        method: 'PUT',
        json: editExerciseItemRequestSchema.parse(command),
      })
    },
    approveExerciseItem(itemId: string) {
      return request(`${exerciseItemPath(itemId)}/approve`, {
        dataSchema: exerciseItemStatusResultSchema,
        method: 'POST',
      })
    },
    disableExerciseItem(itemId: string) {
      return request(`${exerciseItemPath(itemId)}/disable`, {
        dataSchema: exerciseItemStatusResultSchema,
        method: 'POST',
      })
    },
    approveExerciseItems(command: ApproveExerciseItemsRequest) {
      return request('/api/admin/exercise-items/batch-approve', {
        dataSchema: batchApprovalResultSchema,
        method: 'POST',
        json: approveExerciseItemsRequestSchema.parse(command),
      })
    },
    publishSourceVersion(versionId: string) {
      return request(`${sourceVersionPath(versionId)}/publish`, {
        dataSchema: publishedSourceVersionSchema,
        method: 'POST',
      })
    },
    discardSourceVersion(versionId: string) {
      return request(`${sourceVersionPath(versionId)}/discard`, {
        dataSchema: archivedSourceVersionSchema,
        method: 'POST',
      })
    },
    createCourse(command: CreateCourseRequest) {
      return request('/api/admin/courses', {
        dataSchema: createdCourseSchema,
        method: 'POST',
        json: createCourseRequestSchema.parse(command),
      })
    },
    listCourses() {
      return request('/api/admin/courses', {
        dataSchema: adminCourseListSchema,
      })
    },
    rotateAccessCode(learnerId: string, command: RotateAccessCodeRequest) {
      return request(
        `/api/admin/learners/${encodePathSegment(learnerId)}/access-code/rotate`,
        {
          dataSchema: rotatedAccessCodeSchema,
          method: 'POST',
          json: rotateAccessCodeRequestSchema.parse(command),
        },
      )
    },
    updateLearnerLogin(
      learnerId: string,
      command: UpdateLearnerLoginRequest,
    ) {
      return request(
        `/api/admin/learners/${encodePathSegment(learnerId)}/login-credential`,
        {
          dataSchema: updatedLearnerLoginSchema,
          method: 'POST',
          json: updateLearnerLoginRequestSchema.parse(command),
        },
      )
    },
    resetCourseProgress(courseId: string, command: CourseProgressResetRequest) {
      return request(
        `/api/admin/courses/${encodePathSegment(courseId)}/learning-progress/reset`,
        {
          dataSchema: courseProgressResetResultSchema,
          method: 'POST',
          json: courseProgressResetRequestSchema.parse(command),
        },
      )
    },
  }
}

export type ExerciseReviewApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'decideExerciseReview'
  | 'evaluateExerciseReview'
  | 'getExerciseItem'
  | 'getExerciseReviewWindow'
  | 'previewExerciseReview'
>

const sourceVersionPath = (versionId: string): string =>
  `/api/admin/source-versions/${encodePathSegment(versionId)}`

const exerciseItemPath = (itemId: string): string =>
  `/api/admin/exercise-items/${encodePathSegment(itemId)}`

const encodePathSegment = (resourceId: string): string =>
  encodeURIComponent(resourceIdSchema.parse(resourceId))
