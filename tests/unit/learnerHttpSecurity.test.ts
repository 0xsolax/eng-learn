import { describe, expect, it } from 'vitest'
import {
  clearLearnerSessionCookie,
  createLearnerSessionCookie,
  hasExactWriteOrigin,
  readLearnerSessionCookie,
} from '../../server/security/learnerHttpSecurity'
import { parseRawSessionToken } from '../../server/security/credentialCrypto'

const TOKEN = parseRawSessionToken('a'.repeat(64))

if (!TOKEN) {
  throw new Error('Test session token is invalid')
}

describe('learner HTTP security', () => {
  it('sets, reads, and clears a host-only hardened learner session cookie', () => {
    const setCookie = createLearnerSessionCookie(TOKEN)

    expect(setCookie).toBe(
      `__Host-eng_learn_session=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
    )
    expect(setCookie).not.toContain('Domain=')
    expect(readLearnerSessionCookie(`theme=dark; __Host-eng_learn_session=${TOKEN}`)).toBe(TOKEN)
    expect(readLearnerSessionCookie('__Host-eng_learn_session=forged')).toBeUndefined()
    expect(clearLearnerSessionCookie()).toBe(
      '__Host-eng_learn_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict',
    )
  })

  it('allows mutations only from the exact configured origin', () => {
    const request = (method: string, origin?: string) =>
      new Request('https://api.example.com/api/app/action', {
        method,
        ...(origin ? { headers: { origin } } : {}),
      })

    expect(
      hasExactWriteOrigin(request('POST', 'https://learn.example.com'), 'https://learn.example.com/'),
    ).toBe(true)
    expect(hasExactWriteOrigin(request('POST'), 'https://learn.example.com')).toBe(false)
    expect(hasExactWriteOrigin(request('POST', 'null'), 'https://learn.example.com')).toBe(false)
    expect(
      hasExactWriteOrigin(request('POST', 'https://child.learn.example.com'), 'https://learn.example.com'),
    ).toBe(false)
    expect(
      hasExactWriteOrigin(request('POST', 'https://learn.example.com:444'), 'https://learn.example.com'),
    ).toBe(false)
    expect(
      hasExactWriteOrigin(request('POST', 'https://learn.example.com.attacker.test'), 'https://learn.example.com'),
    ).toBe(false)
    expect(hasExactWriteOrigin(request('GET'), 'https://learn.example.com')).toBe(true)
  })
})
