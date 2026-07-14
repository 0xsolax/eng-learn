export const ADMIN_SESSION_COOKIE_NAME = '__Host-eng_learn_admin_session'

const ADMIN_SESSION_MAX_AGE_SECONDS = '28800'
const RAW_ADMIN_SESSION_PATTERN = /^[0-9a-f]{64}$/

export const createAdminSessionCookie = (token: string): string => {
  if (!RAW_ADMIN_SESSION_PATTERN.test(token)) {
    throw new Error('Admin session token is invalid')
  }
  return `${ADMIN_SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`
}

export const clearAdminSessionCookie = (): string =>
  `${ADMIN_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`

export const hasAdminSessionCookie = (cookieHeader: string | null): boolean =>
  readCookieCandidates(cookieHeader).length > 0

export const readAdminSessionCookie = (
  cookieHeader: string | null,
): string | undefined => {
  const candidates = readCookieCandidates(cookieHeader)
  if (candidates.length !== 1) return undefined
  const token = candidates[0]
  return token && RAW_ADMIN_SESSION_PATTERN.test(token) ? token : undefined
}

const readCookieCandidates = (cookieHeader: string | null): string[] => {
  if (!cookieHeader) return []
  const prefix = `${ADMIN_SESSION_COOKIE_NAME}=`
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
}
