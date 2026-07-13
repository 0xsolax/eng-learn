export type AdminAuthorizationFailureStatus = 401 | 403

type AdminAuthorizationFailureListener = (
  status: AdminAuthorizationFailureStatus,
) => void

const listeners = new Set<AdminAuthorizationFailureListener>()

export const subscribeAdminAuthorizationFailure = (
  listener: AdminAuthorizationFailureListener,
): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const reportAdminAuthorizationFailure = (
  status: AdminAuthorizationFailureStatus,
): void => {
  for (const listener of listeners) {
    listener(status)
  }
}
