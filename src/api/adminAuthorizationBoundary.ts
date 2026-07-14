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
