import { describe, expect, it } from 'vitest'
import type { AdminAuthenticator } from '../../server/security/adminAuthentication'
import {
  requireAdminIdentity,
  requireLearnerPrincipal,
} from '../../server/http/authentication'
import type { LearnerSessionService } from '../../server/services/LearnerSessionService'
import { parseRawSessionToken } from '../../server/security/credentialCrypto'
import { createLearnerSessionCookie } from '../../server/security/learnerHttpSecurity'
import {
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionCookie,
} from '../../server/security/adminHttpSecurity'
import type { AdminSessionService } from '../../server/services/AdminSessionService'

const ORIGIN = 'https://eng-learn.test'
const TOKEN = parseRawSessionToken('a'.repeat(64))

if (!TOKEN) throw new Error('Expected a valid test token')

describe('HTTP authentication boundary', () => {
  it('does not downgrade an invalid Access assertion to a valid service token', async () => {
    const access = authenticator(undefined)
    const service = authenticator({ source: 'service_token', subject: 'smoke' })
    const request = new Request(`${ORIGIN}/api/admin/health`, {
      headers: {
        'cf-access-jwt-assertion': 'invalid-access-token',
        'x-admin-token': 'valid-service-token',
      },
    })

    await expect(
      requireAdminIdentity(request, {
        accessAuthenticator: access,
        serviceAuthenticator: service,
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: 'admin_identity_invalid' })
  })

  it('enforces exact Origin for Access browser writes but not service-token calls', async () => {
    const access = authenticator({
      source: 'cloudflare_access',
      subject: 'admin-1',
      email: 'admin@example.test',
    })
    const service = authenticator({ source: 'service_token', subject: 'smoke' })
    const browserWrite = new Request(`${ORIGIN}/api/admin/source-versions/import`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.test',
        'cf-access-jwt-assertion': 'signed-token',
      },
    })
    const serviceWrite = new Request(`${ORIGIN}/api/admin/source-versions/import`, {
      method: 'POST',
      headers: { 'x-admin-token': 'service-token' },
    })

    await expect(
      requireAdminIdentity(browserWrite, {
        accessAuthenticator: access,
        serviceAuthenticator: service,
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: 'origin_forbidden' })
    await expect(
      requireAdminIdentity(serviceWrite, {
        accessAuthenticator: access,
        serviceAuthenticator: service,
        allowedOrigin: ORIGIN,
      }),
    ).resolves.toMatchObject({ source: 'service_token' })
  })

  it('resolves an application cookie before service token and enforces browser write Origin', async () => {
    const token = 'b'.repeat(64)
    const applicationSessionService = adminSessionService({
      status: 'active',
      session: {
        id: 'credential-1',
        source: 'application_session',
        displayName: 'Solazhu',
      },
    })
    const validRead = new Request(`${ORIGIN}/api/admin/session`, {
      headers: {
        cookie: createAdminSessionCookie(token),
        'x-admin-token': 'valid-service-token',
      },
    })
    const invalidWriteOrigin = new Request(`${ORIGIN}/api/admin/courses`, {
      method: 'POST',
      headers: {
        cookie: createAdminSessionCookie(token),
        origin: 'https://attacker.test',
      },
    })

    await expect(
      requireAdminIdentity(validRead, {
        browserMode: 'application_session',
        applicationSessionService,
        serviceAuthenticator: authenticator({ source: 'service_token', subject: 'smoke' }),
        allowedOrigin: ORIGIN,
      }),
    ).resolves.toEqual({
      source: 'application_session',
      subject: 'credential-1',
      displayName: 'Solazhu',
    })
    await expect(
      requireAdminIdentity(invalidWriteOrigin, {
        browserMode: 'application_session',
        applicationSessionService,
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: 'origin_forbidden' })
  })

  it('never downgrades an invalid application cookie to a valid service token', async () => {
    const request = new Request(`${ORIGIN}/api/admin/session`, {
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=invalid`,
        'x-admin-token': 'valid-service-token',
      },
    })

    await expect(
      requireAdminIdentity(request, {
        browserMode: 'application_session',
        applicationSessionService: adminSessionService({ status: 'invalid' }),
        serviceAuthenticator: authenticator({ source: 'service_token', subject: 'smoke' }),
        allowedOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: 'admin_session_required' })
  })

  it('maps learner cookie resolution states and returns only an active principal', async () => {
    const request = new Request(`${ORIGIN}/api/app/course`, {
      headers: { cookie: createLearnerSessionCookie(TOKEN) },
    })
    const service = sessionService({
      status: 'active',
      principal: {
        sessionId: 'browser-session-1',
        learnerId: 'learner-1',
        courseId: 'course-1',
        expiresAt: '2026-08-12T00:00:00.000Z',
      },
    })

    await expect(requireLearnerPrincipal(request, service)).resolves.toMatchObject({
      learnerId: 'learner-1',
      courseId: 'course-1',
    })
    await expect(
      requireLearnerPrincipal(request, sessionService({ status: 'revoked' })),
    ).rejects.toMatchObject({ code: 'learner_session_revoked' })
  })
})

const authenticator = (
  identity: Awaited<ReturnType<AdminAuthenticator['authenticate']>>,
): AdminAuthenticator => ({ authenticate: () => Promise.resolve(identity) })

const sessionService = (
  result: Awaited<ReturnType<LearnerSessionService['resolve']>>,
): LearnerSessionService => ({
  exchangeAccessCode: () => Promise.resolve(undefined),
  resolve: () => Promise.resolve(result),
  revoke: () => Promise.resolve(false),
  revokeAll: () => Promise.resolve(0),
  rotateAccessCode: () => Promise.resolve(undefined),
})

const adminSessionService = (
  result: Awaited<ReturnType<AdminSessionService['resolve']>>,
): AdminSessionService => ({
  login: () => Promise.reject(new Error('Not used in this test')),
  resolve: () => Promise.resolve(result),
  logout: () => Promise.resolve(false),
})
