import { apiErrorSchema, type ApiError, type ApiSuccess } from '../../shared/api/schemas'
import { isDomainError } from '../errors/DomainError'

const DOMAIN_ERROR_STATUS: Record<ApiError['code'], number> = {
  admin_disabled: 403,
  admin_identity_invalid: 401,
  admin_login_rate_limited: 429,
  admin_not_configured: 503,
  admin_session_expired: 401,
  admin_session_required: 401,
  admin_session_revoked: 401,
  bad_request: 400,
  conflict: 409,
  credential_conflict: 409,
  course_unavailable: 409,
  coverage_incomplete: 409,
  dependency_failure: 503,
  forbidden_resource: 403,
  internal_error: 500,
  invalid_admin_credentials: 401,
  invalid_access_code: 401,
  idempotency_conflict: 409,
  import_reconcile_required: 503,
  learner_session_expired: 401,
  learner_session_required: 401,
  learner_session_revoked: 401,
  legacy_content_incompatible: 409,
  lesson_incomplete: 409,
  lesson_not_active: 409,
  not_found: 404,
  origin_forbidden: 403,
  operation_superseded: 409,
  payload_too_large: 413,
  queue_invariant_violation: 409,
  report_unavailable: 409,
  review_feedback_open: 409,
  schema_not_ready: 503,
  s5_preview_required: 409,
  source_draft_exists: 409,
  source_version_immutable: 409,
  task_not_current: 409,
  task_type_mismatch: 400,
  unauthorized: 401,
  validation_error: 400,
}

export const apiJson = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('content-type', 'application/json; charset=utf-8')

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

export const apiOk = (data: unknown, status = 200, headers?: HeadersInit): Response =>
  apiJson({ ok: true, data } satisfies ApiSuccess<unknown>, status, headers)

export const toApiErrorResponse = (error: unknown): Response => {
  if (isDomainError(error)) {
    const candidate = {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
    const parsed = apiErrorSchema.safeParse(candidate)

    if (parsed.success) {
      const retryAfterSeconds =
        parsed.data.code === 'admin_login_rate_limited'
          ? parsed.data.details.retryAfterSeconds
          : undefined
      return apiJson(
        {
          ok: false,
          error: parsed.data,
        },
        DOMAIN_ERROR_STATUS[parsed.data.code],
        retryAfterSeconds === undefined
          ? undefined
          : { 'retry-after': String(retryAfterSeconds) },
      )
    }
  }

  return apiJson(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Unexpected server error',
      },
    },
    500,
  )
}
