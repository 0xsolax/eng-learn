import {
  adminExerciseItemSchema,
  adminExerciseItemListSchema,
  archivedSourceVersionSchema,
  approveExerciseItemsRequestSchema,
  batchApprovalResultSchema,
  buildCoverageSchema,
  editExerciseItemRequestSchema,
  exerciseItemStatusResultSchema,
  importedSourceVersionSchema,
  publishedSourceVersionSchema,
  sourceVersionDetailSchema,
  sourceVersionListSchema,
} from '@shared/api/contentSchemas'
import {
  adminCourseListSchema,
  adminSessionSchema,
  createdCourseSchema,
  rotatedAccessCodeSchema,
} from '@shared/api/courseSchemas'
import {
  createCourseRequestSchema,
  importSourceVersionCommandSchema,
  rotateAccessCodeRequestSchema,
} from '@shared/api/schemas'
import { z } from 'zod'
import { reportAdminAuthorizationFailure } from './adminAuthorizationBoundary'
import { ApiFailureError, InvalidApiResponseError } from './errors'
import { createHttpClient, type HttpRequestOptions } from './httpClient'

type HttpClient = ReturnType<typeof createHttpClient>
export type ImportSourceVersionCommand = z.input<typeof importSourceVersionCommandSchema>
export type EditExerciseItemRequest = z.input<typeof editExerciseItemRequestSchema>
export type ApproveExerciseItemsRequest = z.input<
  typeof approveExerciseItemsRequestSchema
>
export type CreateCourseRequest = z.input<typeof createCourseRequestSchema>
export type RotateAccessCodeRequest = z.input<typeof rotateAccessCodeRequestSchema>
const resourceIdSchema = z.string().trim().min(1)

export const createAdminApi = (client: HttpClient = createHttpClient()) => {
  const request = async <TSchema extends z.ZodType>(
    path: string,
    options: HttpRequestOptions<TSchema>,
  ): Promise<z.output<TSchema>> => {
    try {
      return await client.request(path, options)
    } catch (error) {
      if (
        (error instanceof ApiFailureError || error instanceof InvalidApiResponseError) &&
        (error.status === 401 || error.status === 403)
      ) {
        reportAdminAuthorizationFailure(error.status)
      }
      throw error
    }
  }

  return {
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
  }
}

const sourceVersionPath = (versionId: string): string =>
  `/api/admin/source-versions/${encodePathSegment(versionId)}`

const exerciseItemPath = (itemId: string): string =>
  `/api/admin/exercise-items/${encodePathSegment(itemId)}`

const encodePathSegment = (resourceId: string): string =>
  encodeURIComponent(resourceIdSchema.parse(resourceId))
