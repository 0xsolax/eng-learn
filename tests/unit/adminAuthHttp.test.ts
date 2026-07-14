import { describe, expect, it } from 'vitest'
import { DomainError } from '../../server/errors/DomainError'
import { createTestWorkerApp } from '../../server/app'
import { createAdminAuthConfig } from '../../server/security/adminCredential'
import { ADMIN_SESSION_COOKIE_NAME } from '../../server/security/adminHttpSecurity'
import { adminSessionSchema } from '../../shared/api/adminAuthSchemas'

const ORIGIN = 'https://eng-learn.test'
const PASSWORD = 'correct horse battery staple'

const assets = {
  fetch(request: Request) {
    return Promise.resolve(
      new Response(request.method === 'HEAD' ? null : '<main>admin app</main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
  },
}

const createApplication = async () =>
  createTestWorkerApp({
    adminAuthConfig: await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: PASSWORD,
    }),
    allowedOrigin: ORIGIN,
    assets,
    browserMode: 'application_session',
  })

const login = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/admin/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'cf-connecting-ip': '203.0.113.10',
      ...headers,
    },
    body: JSON.stringify(body),
  })

const readJson = (response: Response): Promise<unknown> => response.json()

describe('administrator application-session HTTP flow', () => {
  it('serves only the public login document and safely redirects protected documents', async () => {
    const app = await createApplication()
    const loginDocument = await app.fetch(new Request(`${ORIGIN}/admin/login`))
    const loginHead = await app.fetch(new Request(`${ORIGIN}/admin/login`, { method: 'HEAD' }))
    const protectedDocument = await app.fetch(
      new Request(`${ORIGIN}/admin/source-versions/version-1?tab=coverage`),
    )
    const protectedHead = await app.fetch(
      new Request(`${ORIGIN}/admin/courses?state=active`, { method: 'HEAD' }),
    )
    const api = await app.fetch(new Request(`${ORIGIN}/api/admin/session`))

    expect(loginDocument.status).toBe(200)
    expect(await loginDocument.text()).toContain('admin app')
    expect(loginDocument.headers.get('cache-control')).toBe('no-store')
    expect(loginHead.status).toBe(200)
    expect(await loginHead.text()).toBe('')
    expect(protectedDocument.status).toBe(302)
    expect(protectedDocument.headers.get('location')).toBe(
      '/admin/login?returnTo=%2Fadmin%2Fsource-versions%2Fversion-1%3Ftab%3Dcoverage',
    )
    expect(protectedHead.status).toBe(302)
    expect(await protectedHead.text()).toBe('')
    expect(api.status).toBe(401)
    expect(await readJson(api)).toMatchObject({
      ok: false,
      error: { code: 'admin_session_required' },
    })
  })

  it('rejects Origin and oversized bodies before credential work', async () => {
    const app = await createApplication()
    const wrongOrigin = await app.fetch(
      login({ username: 'admin', password: PASSWORD }, { origin: 'https://attacker.test' }),
    )
    const oversized = await app.fetch(
      new Request(`${ORIGIN}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ username: 'admin', password: 'x'.repeat(4_200) }),
      }),
    )

    expect(wrongOrigin.status).toBe(403)
    expect(await readJson(wrongOrigin)).toMatchObject({
      error: { code: 'origin_forbidden' },
    })
    expect(oversized.status).toBe(413)
    expect(await readJson(oversized)).toMatchObject({
      error: { code: 'payload_too_large' },
    })
  })

  it('logs in, resolves the cookie session, logs out, and rejects replay', async () => {
    const app = await createApplication()
    const loginResponse = await app.fetch(
      login({ username: ' Admin ', password: PASSWORD }),
    )
    const setCookie = loginResponse.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';', 1)[0] ?? ''

    expect(loginResponse.status).toBe(200)
    expect(await readJson(loginResponse)).toMatchObject({
      data: {
        source: 'application_session',
        displayName: 'Solazhu',
      },
    })
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')

    const sessionResponse = await app.fetch(
      new Request(`${ORIGIN}/api/admin/session`, { headers: { cookie } }),
    )
    expect(sessionResponse.status).toBe(200)
    expect(await readJson(sessionResponse)).toMatchObject({
      data: { source: 'application_session', displayName: 'Solazhu' },
    })

    const logoutResponse = await app.fetch(
      new Request(`${ORIGIN}/api/admin/auth/logout`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN },
      }),
    )
    expect(logoutResponse.status).toBe(200)
    expect(logoutResponse.headers.get('set-cookie')).toContain('Max-Age=0')

    const replay = await app.fetch(
      new Request(`${ORIGIN}/api/admin/session`, { headers: { cookie } }),
    )
    expect(replay.status).toBe(401)
    expect(await readJson(replay)).toMatchObject({
      error: { code: 'admin_session_revoked' },
    })
  })

  it('idempotently clears missing, expired, and already-revoked cookies', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z')
    const app = createTestWorkerApp({
      adminAuthConfig: await createAdminAuthConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: PASSWORD,
      }),
      allowedOrigin: ORIGIN,
      assets,
      browserMode: 'application_session',
      now: () => now,
    })
    const logout = (cookie?: string) =>
      app.fetch(
        new Request(`${ORIGIN}/api/admin/auth/logout`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            ...(cookie ? { cookie } : {}),
          },
        }),
      )

    const missingCookieResponse = await logout()
    expect(missingCookieResponse.status).toBe(200)
    expect(missingCookieResponse.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect(readJson(missingCookieResponse)).resolves.toMatchObject({
      data: { loggedOut: true },
    })

    const loginResponse = await app.fetch(
      login({ username: 'admin', password: PASSWORD }),
    )
    const cookie = (loginResponse.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? ''
    now = new Date('2026-07-13T09:00:00.000Z')

    const expiredCookieResponse = await logout(cookie)
    expect(expiredCookieResponse.status).toBe(200)
    expect(expiredCookieResponse.headers.get('cache-control')).toBe('no-store')
    expect(expiredCookieResponse.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect(readJson(expiredCookieResponse)).resolves.toMatchObject({
      data: { loggedOut: true },
    })

    const revokedCookieResponse = await logout(cookie)
    expect(revokedCookieResponse.status).toBe(200)
    expect(revokedCookieResponse.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect(readJson(revokedCookieResponse)).resolves.toMatchObject({
      data: { loggedOut: true },
    })
  })

  it('keeps the cookie when authentication storage prevents logout confirmation', async () => {
    const app = createTestWorkerApp({
      adminSessionService: {
        login: () => Promise.reject(new Error('not used')),
        resolve: () => Promise.resolve({ status: 'invalid' }),
        logout: () =>
          Promise.reject(
            new DomainError(
              'dependency_failure',
              'Administrator authentication storage is unavailable',
            ),
          ),
      },
      allowedOrigin: ORIGIN,
      browserMode: 'application_session',
    })
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/admin/auth/logout`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          cookie: `${ADMIN_SESSION_COOKIE_NAME}=${'a'.repeat(64)}`,
        },
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    await expect(readJson(response)).resolves.toMatchObject({
      error: { code: 'dependency_failure' },
    })
  })

  it('keeps a presented cookie when application-session configuration is unavailable', async () => {
    const app = createTestWorkerApp({
      allowedOrigin: ORIGIN,
      browserMode: 'application_session',
    })
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/admin/auth/logout`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          cookie: `${ADMIN_SESSION_COOKIE_NAME}=${'a'.repeat(64)}`,
        },
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    await expect(readJson(response)).resolves.toMatchObject({
      error: { code: 'admin_not_configured' },
    })
  })

  it('returns Retry-After when the fifth failed login starts persistent cooldown', async () => {
    const app = await createApplication()
    const responses: Response[] = []
    for (let index = 0; index < 5; index += 1) {
      responses.push(
        await app.fetch(login({ username: 'admin', password: 'wrong password value' })),
      )
    }

    expect(responses.slice(0, 4).map((response) => response.status)).toEqual([
      401, 401, 401, 401,
    ])
    expect(responses[4]?.status).toBe(429)
    expect(responses[4]?.headers.get('retry-after')).toBe('900')
  })

  it('keeps service tokens API-only and never downgrades an invalid cookie', async () => {
    const config = await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: PASSWORD,
    })
    const app = createTestWorkerApp({
      adminAuthConfig: config,
      adminToken: 'service-token',
      allowedOrigin: ORIGIN,
      assets,
      browserMode: 'application_session',
    })
    const documentResponse = await app.fetch(
      new Request(`${ORIGIN}/admin/source-versions`, {
        headers: { 'x-admin-token': 'service-token' },
      }),
    )
    const apiResponse = await app.fetch(
      new Request(`${ORIGIN}/api/admin/session`, {
        headers: { 'x-admin-token': 'service-token' },
      }),
    )
    const downgrade = await app.fetch(
      new Request(`${ORIGIN}/api/admin/session`, {
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE_NAME}=invalid`,
          'x-admin-token': 'service-token',
        },
      }),
    )

    expect(documentResponse.status).toBe(401)
    expect(documentResponse.headers.get('content-type')).toContain('application/json')
    expect(apiResponse.status).toBe(200)
    expect(await readJson(apiResponse)).toMatchObject({
      data: { source: 'service_token' },
    })
    expect(downgrade.status).toBe(401)
    expect(await readJson(downgrade)).toMatchObject({
      error: { code: 'admin_session_required' },
    })
  })

  it('accepts only the configured browser identity for protected documents', async () => {
    const app = createTestWorkerApp({
      adminIdentity: { id: 'access-admin', email: 'admin@example.test' },
      adminAuthConfig: await createAdminAuthConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: PASSWORD,
      }),
      assets,
      browserMode: 'application_session',
      allowedOrigin: ORIGIN,
    })
    const response = await app.fetch(
      new Request(`${ORIGIN}/admin/source-versions`, {
        headers: { 'cf-access-jwt-assertion': 'valid-access-assertion' },
      }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      '/admin/login?returnTo=%2Fadmin%2Fsource-versions',
    )
  })

  it('does not expose the application password endpoint in Access mode', async () => {
    const app = createTestWorkerApp({
      adminIdentity: { id: 'access-admin', email: 'admin@example.test' },
      assets,
      browserMode: 'cloudflare_access',
      allowedOrigin: ORIGIN,
    })
    const response = await app.fetch(
      login({ username: 'admin', password: PASSWORD }),
    )

    expect(response.status).toBe(404)
  })

  it('normalizes a long Access email into the shared administrator session contract', async () => {
    const email = `${'a'.repeat(60)}@long-example-domain.test`
    const app = createTestWorkerApp({
      adminIdentity: { id: 'access-admin', email },
      browserMode: 'cloudflare_access',
      allowedOrigin: ORIGIN,
    })
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/admin/session`, {
        headers: { 'cf-access-jwt-assertion': 'valid-test-assertion' },
      }),
    )
    const body = (await readJson(response)) as { data?: unknown }

    expect(response.status).toBe(200)
    const session = adminSessionSchema.parse(body.data)
    expect(session.email).toBe(email)
    expect(Array.from(session.displayName)).toHaveLength(64)
  })

  it('uses the Access subject when the email claim is absent or invalid', async () => {
    for (const email of [undefined, 'not-an-email']) {
      const app = createTestWorkerApp({
        adminIdentity: {
          id: 'access-subject-1',
          ...(email ? { email } : {}),
        },
        browserMode: 'cloudflare_access',
        allowedOrigin: ORIGIN,
      })
      const response = await app.fetch(
        new Request(`${ORIGIN}/api/admin/session`, {
          headers: { 'cf-access-jwt-assertion': 'valid-test-assertion' },
        }),
      )
      const body = (await readJson(response)) as { data?: unknown }

      expect(response.status).toBe(200)
      expect(adminSessionSchema.parse(body.data)).toEqual({
        id: 'access-subject-1',
        source: 'cloudflare_access',
        displayName: 'access-subject-1',
      })
    }
  })
})
