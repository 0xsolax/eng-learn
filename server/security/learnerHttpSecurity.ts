import { parseRawSessionToken, type RawSessionToken } from './credentialCrypto'

const LEARNER_SESSION_COOKIE = '__Host-eng_learn_session'
const SESSION_MAX_AGE_SECONDS = '2592000'
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const createLearnerSessionCookie = (token: RawSessionToken): string =>
  `${LEARNER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`

export const clearLearnerSessionCookie = (): string =>
  `${LEARNER_SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`

export const readLearnerSessionCookie = (cookieHeader: string | null): RawSessionToken | undefined => {
  if (!cookieHeader) {
    return undefined
  }

  const cookiePrefix = `${LEARNER_SESSION_COOKIE}=`
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookiePrefix))

  return cookie ? parseRawSessionToken(cookie.slice(cookiePrefix.length)) : undefined
}

export const hasExactWriteOrigin = (request: Request, expectedOrigin: string): boolean => {
  if (!WRITE_METHODS.has(request.method.toUpperCase())) {
    return true
  }

  try {
    return request.headers.get('origin') === new URL(expectedOrigin).origin
  } catch {
    return false
  }
}
