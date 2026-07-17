import { z } from 'zod'
import {
  coverageBlockReasonSchema,
  missingCoverageItemSchema,
} from './schemas'
import {
  exerciseItemContentSchema,
  fillBlankPromptSchema,
  multipleChoicePromptSchema,
  recallWordPromptSchema,
  recognizeMeaningPromptSchema,
  reviewScoreSchema,
  sentenceBuildPromptSchema,
  sentenceOutputPromptSchema,
  submitTaskAnswerRequestSchema,
  taskAnswerFeedbackSchema,
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

export const exerciseReviewStateSchema = z.enum([
  'pending_review',
  'needs_rework',
  'approved',
  'disabled',
])

export const EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH = 2_000

const exerciseReviewFeedbackSchema = z
  .object({
    text: z.string().trim().min(1).max(EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH),
    requestedAt: z.iso.datetime(),
  })
  .strict()

const exerciseReviewItemBase = {
  id: nonEmptyText,
  wordId: nonEmptyText,
  word: nonEmptyText,
  wordOrderIndex: z.number().int().positive(),
  position: z.number().int().positive(),
  status: exerciseItemStatusSchema,
  reviewState: exerciseReviewStateSchema,
  feedback: exerciseReviewFeedbackSchema.optional(),
}

export const exerciseReviewItemSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.literal('S0'),
      taskType: z.literal('recognize_meaning'),
      prompt: recognizeMeaningPromptSchema,
    })
    .strict(),
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('recall_word'),
      prompt: recallWordPromptSchema,
    })
    .strict(),
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('multiple_choice'),
      prompt: multipleChoicePromptSchema,
    })
    .strict(),
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.literal('S3'),
      taskType: z.literal('fill_blank'),
      prompt: fillBlankPromptSchema,
    })
    .strict(),
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.literal('S4'),
      taskType: z.literal('sentence_build'),
      prompt: sentenceBuildPromptSchema,
    })
    .strict(),
  z
    .object({
      ...exerciseReviewItemBase,
      stage: z.literal('S5'),
      taskType: z.literal('sentence_output'),
      prompt: sentenceOutputPromptSchema,
    })
    .strict(),
])

export const exerciseReviewWindowSchema = z
  .object({
    sourceVersionId: nonEmptyText,
    sourceName: nonEmptyText,
    versionNo: z.number().int().positive(),
    contentRevision: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    approvedCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    needsReworkCount: z.number().int().nonnegative(),
    disabledCount: z.number().int().nonnegative(),
    allApproved: z.boolean(),
    firstItemId: nonEmptyText.optional(),
    previousItemId: nonEmptyText.optional(),
    nextItemId: nonEmptyText.optional(),
    current: exerciseReviewItemSchema.optional(),
  })
  .strict()

export const exerciseReviewPreviewRequestSchema = z
  .object({
    expectedContentRevision: z.number().int().nonnegative(),
    taskType: z.literal('sentence_output'),
    draft: z.string().trim().min(1).max(2_000),
  })
  .strict()

export const exerciseReviewPreviewResultSchema = z
  .object({
    exerciseItemId: nonEmptyText,
    referenceSentence: z.string().trim().min(1).max(2_000),
    revealedAt: z.iso.datetime(),
  })
  .strict()

export const exerciseReviewEvaluateRequestSchema = z
  .object({
    expectedContentRevision: z.number().int().nonnegative(),
    submission: submitTaskAnswerRequestSchema,
  })
  .strict()

export const exerciseReviewEvaluateResultSchema = z
  .object({
    exerciseItemId: nonEmptyText,
    score: reviewScoreSchema,
    correct: z.boolean(),
    feedback: taskAnswerFeedbackSchema,
  })
  .strict()

export const exerciseReviewDecisionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('approve'),
      expectedContentRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal('request_rework'),
      expectedContentRevision: z.number().int().nonnegative(),
      feedback: z.string().trim().min(1).max(EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      action: z.literal('correct'),
      expectedContentRevision: z.number().int().nonnegative(),
      content: exerciseItemContentSchema,
    })
    .strict(),
])

const exerciseReviewDecisionResultBase = {
  exerciseItemId: nonEmptyText,
  sourceVersionId: nonEmptyText,
  contentRevision: z.number().int().nonnegative(),
}

export const exerciseReviewDecisionResultSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...exerciseReviewDecisionResultBase,
      action: z.literal('approve'),
      status: z.literal('approved'),
      reviewState: z.literal('approved'),
    })
    .strict(),
  z
    .object({
      ...exerciseReviewDecisionResultBase,
      action: z.literal('request_rework'),
      status: z.literal('draft'),
      reviewState: z.literal('needs_rework'),
    })
    .strict(),
  z
    .object({
      ...exerciseReviewDecisionResultBase,
      action: z.literal('correct'),
      status: z.literal('draft'),
      reviewState: z.literal('pending_review'),
    })
    .strict(),
])

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
export type ExerciseReviewItemDto = z.infer<typeof exerciseReviewItemSchema>
export type ExerciseReviewWindowDto = z.infer<typeof exerciseReviewWindowSchema>
export type ExerciseReviewPreviewRequest = z.input<typeof exerciseReviewPreviewRequestSchema>
export type ExerciseReviewPreviewResult = z.infer<typeof exerciseReviewPreviewResultSchema>
export type ExerciseReviewEvaluateRequest = z.input<typeof exerciseReviewEvaluateRequestSchema>
export type ExerciseReviewEvaluateResult = z.infer<typeof exerciseReviewEvaluateResultSchema>
export type ExerciseReviewDecisionRequest = z.input<typeof exerciseReviewDecisionRequestSchema>
export type ExerciseReviewDecisionResult = z.infer<typeof exerciseReviewDecisionResultSchema>
