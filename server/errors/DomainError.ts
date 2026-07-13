import type { ApiError } from '../../shared/api/schemas'

export type DomainErrorCode = ApiError['code']

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details?: unknown

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError
