import { ApiFailureError, InvalidApiResponseError } from './errors'

export const ADMIN_SESSION_FAILURE_CODES = [
  'admin_session_required',
  'admin_session_expired',
  'admin_session_revoked',
  'admin_identity_invalid',
] as const

export type AdminSessionFailureCode = (typeof ADMIN_SESSION_FAILURE_CODES)[number]

export const isAdminSessionFailureCode = (
  code: string,
): code is AdminSessionFailureCode =>
  (ADMIN_SESSION_FAILURE_CODES as readonly string[]).includes(code)

export const getAdminSessionFailureCode = (
  error: unknown,
): AdminSessionFailureCode | undefined =>
  error instanceof ApiFailureError &&
  (error.status === 401 || error.status === 403) &&
  isAdminSessionFailureCode(error.code)
    ? error.code
    : undefined

export const isAdminSessionAccessError = (error: unknown): boolean =>
  getAdminSessionFailureCode(error) !== undefined ||
  (error instanceof InvalidApiResponseError &&
    (error.status === 401 || error.status === 403))

type AdminAuthorizationFailureListener = (code: AdminSessionFailureCode) => void

const listeners = new Set<AdminAuthorizationFailureListener>()

export const subscribeAdminAuthorizationFailure = (
  listener: AdminAuthorizationFailureListener,
): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const reportAdminAuthorizationFailure = (
  code: AdminSessionFailureCode,
): void => {
  for (const listener of listeners) {
    listener(code)
  }
}
