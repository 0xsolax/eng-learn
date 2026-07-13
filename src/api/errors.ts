import type { ApiError } from '@shared/api/schemas'

export class ApiFailureError extends Error {
  readonly kind = 'api_failure'
  readonly code: ApiError['code']

  constructor(
    readonly status: number,
    readonly apiError: ApiError,
  ) {
    super(`API request failed (${apiError.code})`)
    this.name = 'ApiFailureError'
    this.code = apiError.code
  }
}

export class InvalidApiResponseError extends Error {
  readonly kind = 'invalid_response'

  constructor(readonly status: number, cause?: unknown) {
    super('API response did not match the expected contract', { cause })
    this.name = 'InvalidApiResponseError'
  }
}

export class ApiNetworkError extends Error {
  readonly kind = 'network'

  constructor(cause: unknown) {
    super('API request could not reach the server', { cause })
    this.name = 'ApiNetworkError'
  }
}
