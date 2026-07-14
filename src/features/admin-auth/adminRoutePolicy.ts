import type { Router } from 'vue-router'

export const DEFAULT_ADMIN_ROUTE = '/admin/source-versions'

export const resolveSafeAdminReturnTo = (
  router: Router,
  candidate: unknown,
): string => {
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith('/admin') ||
    candidate.startsWith('//') ||
    candidate.includes('#')
  ) {
    return DEFAULT_ADMIN_ROUTE
  }

  const resolved = router.resolve(candidate)
  const isProtectedAdminRoute = resolved.matched.some(
    (route) => route.meta.requiresAdmin === true,
  )

  return isProtectedAdminRoute && resolved.name !== 'admin-login'
    ? resolved.fullPath
    : DEFAULT_ADMIN_ROUTE
}
