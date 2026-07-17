import { z } from 'zod'
import { taskTypeSchema, wordStageSchema } from './taskSchemas'

export type ApiSuccess<T> = {
  ok: true
  data: T
}

export type ApiFailure = {
  ok: false
  error: ApiError
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

const errorMessageSchema = z.string().min(1)

const fieldIssueSchema = z
  .object({
    path: z.string(),
    message: z.string().min(1),
  })
  .strict()

export const coverageBlockReasonSchema = z.enum([
  'exercise_item_disabled',
  'exercise_item_draft',
  'exercise_item_required',
  'exercise_item_invalid',
  'example_sentence_required',
  'distractors_required',
  'sentence_pieces_required',
])

export const missingCoverageItemSchema = z
  .object({
    word: z.string().min(1),
    stage: wordStageSchema,
    taskType: taskTypeSchema,
    reason: coverageBlockReasonSchema,
  })
  .strict()

const simpleApiErrorSchema = z
  .object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'admin_disabled',
      'admin_identity_invalid',
      'admin_not_configured',
      'admin_session_required',
      'admin_session_expired',
      'admin_session_revoked',
      'invalid_admin_credentials',
      'learner_session_required',
      'learner_session_expired',
      'learner_session_revoked',
      'legacy_content_incompatible',
      'lesson_not_active',
      'forbidden_resource',
      'invalid_access_code',
      'not_found',
      'source_version_immutable',
      'source_draft_exists',
      'task_not_current',
      'task_type_mismatch',
      's5_preview_required',
      'report_unavailable',
      'course_unavailable',
      'conflict',
      'credential_conflict',
      'idempotency_conflict',
      'import_reconcile_required',
      'operation_superseded',
      'queue_invariant_violation',
      'dependency_failure',
      'schema_not_ready',
      'internal_error',
      'origin_forbidden',
      'payload_too_large',
    ]),
    message: errorMessageSchema,
  })
  .strict()

export const apiErrorSchema = z.union([
  simpleApiErrorSchema,
  z
    .object({
      code: z.literal('admin_login_rate_limited'),
      message: errorMessageSchema,
      details: z
        .object({ retryAfterSeconds: z.number().int().positive() })
        .strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal('validation_error'),
      message: errorMessageSchema,
      details: z.object({ fields: z.array(fieldIssueSchema).min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal('coverage_incomplete'),
      message: errorMessageSchema,
      details: z.object({ missingItems: z.array(missingCoverageItemSchema).min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal('lesson_incomplete'),
      message: errorMessageSchema,
      details: z
        .object({
          completedPrimary: z.number().int().nonnegative(),
          totalPrimary: z.number().int().nonnegative(),
          pendingRequiredTaskIds: z.array(z.string().min(1)),
        })
        .strict(),
    })
    .strict(),
])

export const apiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: apiErrorSchema }).strict(),
  ])

export type ApiError = z.infer<typeof apiErrorSchema>

export const IMPORT_FIELD_LIMITS = {
  word: 120,
  meaning: 500,
  examplePhrase: 2_000,
  exampleSentence: 2_000,
  exampleSentenceExtended: 2_000,
  partOfSpeech: 64,
} as const

export const importWordRequestSchema = z.object({
  word: z.string().trim().min(1).max(IMPORT_FIELD_LIMITS.word),
  meaning: z.string().trim().min(1).max(IMPORT_FIELD_LIMITS.meaning),
  examplePhrase: z.string().trim().min(1).max(IMPORT_FIELD_LIMITS.examplePhrase),
  exampleSentence: z.string().trim().min(1).max(IMPORT_FIELD_LIMITS.exampleSentence),
  exampleSentenceExtended: z
    .string()
    .trim()
    .min(1)
    .max(IMPORT_FIELD_LIMITS.exampleSentenceExtended),
  partOfSpeech: z.string().trim().min(1).max(IMPORT_FIELD_LIMITS.partOfSpeech).optional(),
}).strict()

export const importSourceVersionRequestSchema = z.object({
  sourceName: z.string().trim().min(1).max(120),
  words: z.array(importWordRequestSchema).min(1).max(500),
}).strict()

export const importSourceVersionCommandSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('new_source'),
      operationToken: z.string().regex(/^[0-9a-f]{64}$/),
      sourceName: z.string().trim().min(1).max(120),
      words: z.array(importWordRequestSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      mode: z.literal('next_version'),
      operationToken: z.string().regex(/^[0-9a-f]{64}$/),
      sourceId: z.string().trim().min(1).max(128),
      words: z.array(importWordRequestSchema).min(1).max(500),
    })
    .strict(),
])

export const createCourseRequestSchema = z.object({
  operationToken: z.string().regex(/^[0-9a-f]{64}$/),
  learnerName: z.string().trim().min(1).max(80),
  sourceVersionId: z.string().trim().min(1).max(128),
}).strict()

export const rotateAccessCodeRequestSchema = z
  .object({
    operationToken: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCredentialVersion: z.number().int().positive(),
  })
  .strict()

export const enterCourseByAccessCodeRequestSchema = z
  .object({
    accessCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/),
  })
  .strict()

export const submitAnswerRequestSchema = z.object({
  userAnswer: z.string().trim().min(1).max(2_000),
})
