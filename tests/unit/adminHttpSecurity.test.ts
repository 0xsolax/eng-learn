import { describe, expect, it } from 'vitest'
import {
  ADMIN_SESSION_COOKIE_NAME,
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasAdminSessionCookie,
  readAdminSessionCookie,
} from '../../server/security/adminHttpSecurity'

const TOKEN = 'a'.repeat(64)

describe('admin HTTP security', () => {
  it('creates and clears only the frozen host cookie', () => {
    expect(createAdminSessionCookie(TOKEN)).toBe(
      `${ADMIN_SESSION_COOKIE_NAME}=${TOKEN}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`,
    )
    expect(clearAdminSessionCookie()).toBe(
      `${ADMIN_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`,
    )
  })

  it('fails closed for malformed or duplicate admin cookies', () => {
    expect(readAdminSessionCookie(`other=1; ${ADMIN_SESSION_COOKIE_NAME}=${TOKEN}`)).toBe(TOKEN)
    expect(hasAdminSessionCookie(`${ADMIN_SESSION_COOKIE_NAME}=invalid`)).toBe(true)
    expect(readAdminSessionCookie(`${ADMIN_SESSION_COOKIE_NAME}=invalid`)).toBeUndefined()
    expect(
      readAdminSessionCookie(
        `${ADMIN_SESSION_COOKIE_NAME}=${TOKEN}; ${ADMIN_SESSION_COOKIE_NAME}=${'b'.repeat(64)}`,
      ),
    ).toBeUndefined()
  })
})
