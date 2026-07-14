import { describe, expect, it } from 'vitest'
import { createTestWorkerApp } from '../../server/app'
import { createAdminAuthConfig } from '../../server/security/adminCredential'
import { ADMIN_SESSION_COOKIE_NAME } from '../../server/security/adminHttpSecurity'

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
})
