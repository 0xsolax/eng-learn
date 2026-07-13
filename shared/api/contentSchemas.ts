import { z } from 'zod'
import {
  coverageBlockReasonSchema,
  missingCoverageItemSchema,
} from './schemas'
import {
  exerciseItemContentSchema,
  taskTypeSchema,
  wordStageSchema,
} from './taskSchemas'

const nonEmptyText = z.string().trim().min(1)

export const MAX_BATCH_APPROVAL_ITEMS = 500

export const sourceVersionStatusSchema = z.enum(['draft', 'published', 'archived'])
export const exerciseItemStatusSchema = z.enum(['draft', 'approved', 'disabled'])

export const importedSourceVersionSchema = z
  .object({
    sourceId: nonEmptyText,
    versionId: nonEmptyText,
    versionNo: z.number().int().positive(),
    status: sourceVersionStatusSchema,
    wordCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
  })
  .strict()

export const sourceVersionSummarySchema = z
  .object({
    sourceId: nonEmptyText,
    sourceName: nonEmptyText,
    versionId: nonEmptyText,
    versionNo: z.number().int().positive(),
    status: sourceVersionStatusSchema,
    wordCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    exerciseItemCount: z.number().int().nonnegative(),
    approvedItemCount: z.number().int().nonnegative(),
    createdAt: nonEmptyText,
    publishedAt: nonEmptyText.optional(),
  })
  .strict()

export const sourceVersionDetailSchema = sourceVersionSummarySchema
  .extend({
    readyToPublish: z.boolean(),
    missingItems: z.array(missingCoverageItemSchema),
  })
  .strict()

export const coverageCellSchema = z
  .object({
    wordId: nonEmptyText,
    word: nonEmptyText,
    stage: wordStageSchema,
    taskType: taskTypeSchema,
    status: z.union([exerciseItemStatusSchema, z.literal('missing')]),
    itemId: nonEmptyText.optional(),
    reason: coverageBlockReasonSchema.optional(),
  })
  .strict()

export const buildCoverageSchema = z
  .object({
    sourceVersionId: nonEmptyText,
    wordCount: z.number().int().nonnegative(),
    readyToPublish: z.boolean(),
    cells: z.array(coverageCellSchema),
    missingItems: z.array(missingCoverageItemSchema),
  })
  .strict()

const adminExerciseItemIdentitySchema = z
  .object({
    id: nonEmptyText,
    sourceVersionId: nonEmptyText,
    wordId: nonEmptyText,
    word: nonEmptyText,
    status: exerciseItemStatusSchema,
  })
  .strict()

export const adminExerciseItemSchema = z.intersection(
  adminExerciseItemIdentitySchema,
  exerciseItemContentSchema,
)

export const editExerciseItemRequestSchema = z
  .object({
    content: exerciseItemContentSchema,
  })
  .strict()

export const approveExerciseItemsRequestSchema = z
  .object({
    itemIds: z.array(nonEmptyText).min(1).max(MAX_BATCH_APPROVAL_ITEMS),
  })
  .strict()

export const sourceVersionListSchema = z.array(sourceVersionSummarySchema)
export const adminExerciseItemListSchema = z.array(adminExerciseItemSchema)

export const publishedSourceVersionSchema = z
  .object({
    sourceVersionId: nonEmptyText,
    status: z.literal('published'),
  })
  .strict()

export const archivedSourceVersionSchema = z
  .object({
    sourceVersionId: nonEmptyText,
    sourceId: nonEmptyText,
    status: z.literal('archived'),
  })
  .strict()

export const exerciseItemStatusResultSchema = z
  .object({
    itemId: nonEmptyText,
    status: z.enum(['approved', 'disabled']),
  })
  .strict()

export const batchApprovalResultSchema = z
  .object({
    approvedCount: z.number().int().positive(),
  })
  .strict()

export type SourceVersionSummaryDto = z.infer<typeof sourceVersionSummarySchema>
export type SourceVersionDetailDto = z.infer<typeof sourceVersionDetailSchema>
export type BuildCoverageDto = z.infer<typeof buildCoverageSchema>
export type AdminExerciseItemDto = z.infer<typeof adminExerciseItemSchema>
