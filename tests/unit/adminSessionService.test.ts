import { describe, expect, it, vi } from 'vitest'
import { createAdminAuthConfig } from '../../server/security/adminCredential'
import { createInMemoryAdminSessionRepository } from '../../server/repositories/inMemoryAdminSessionRepository'
import { createAdminSessionService } from '../../server/services/AdminSessionService'
import { DomainError } from '../../server/errors/DomainError'

const NOW = new Date('2026-07-14T00:00:00.000Z')
const RAW_TOKEN = 'a'.repeat(64)

const createConfig = () =>
  createAdminAuthConfig({
    username: 'admin',
    displayName: 'Solazhu',
    password: 'correct horse battery staple',
  })

describe('admin session service', () => {
  it('stores only a token hash and resolves then revokes the opaque session', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    const createSpy = vi.spyOn(repository, 'create')
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
      generateToken: () => RAW_TOKEN,
    })

    const established = await service.login({
      username: 'admin',
      password: 'correct horse battery staple',
      clientIdentifier: '203.0.113.4',
    })

    expect(established.token).toBe(RAW_TOKEN)
    expect(established.session).toEqual({
      id: config.credentialId,
      source: 'application_session',
      displayName: 'Solazhu',
    })
    expect(createSpy.mock.calls[0]?.[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(createSpy.mock.calls[0]?.[0].tokenHash).not.toBe(RAW_TOKEN)
    await expect(service.resolve(RAW_TOKEN)).resolves.toEqual({
      status: 'active',
      session: established.session,
    })
    await expect(service.logout(RAW_TOKEN)).resolves.toBe(true)
    await expect(service.resolve(RAW_TOKEN)).resolves.toEqual({ status: 'revoked' })
    await expect(service.logout(RAW_TOKEN)).resolves.toBe(true)
  })

  it('rejects expired sessions and sessions created by an older credential id', async () => {
    const firstConfig = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config: firstConfig,
      now: () => NOW,
      generateToken: () => RAW_TOKEN,
    })
    await service.login({
      username: 'admin',
      password: 'correct horse battery staple',
      clientIdentifier: '203.0.113.5',
    })

    const expired = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config: firstConfig,
      now: () => new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
    })
    await expect(expired.resolve(RAW_TOKEN)).resolves.toEqual({ status: 'expired' })

    const reset = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config: await createConfig(),
      now: () => NOW,
    })
    await expect(reset.resolve(RAW_TOKEN)).resolves.toEqual({ status: 'revoked' })
  })

  it('atomically allows only five concurrent verifications and persists cooldown', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    const verifyCredential = vi.fn().mockResolvedValue(false)
    const createService = () =>
      createAdminSessionService({
        sessionRepository: repository,
        rateLimitRepository: repository,
        config,
        now: () => NOW,
        verifyCredential,
      })

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        createService()
          .login({
            username: 'admin',
            password: 'wrong password value',
            clientIdentifier: '203.0.113.6',
          })
          .then(
            () => 'success',
            (error: unknown) =>
              error instanceof DomainError
                ? { code: error.code, details: error.details }
                : 'unexpected',
          ),
      ),
    )

    expect(verifyCredential).toHaveBeenCalledTimes(5)
    expect(outcomes.filter((result) => result === 'success')).toHaveLength(0)
    expect(outcomes.filter((result) => result === 'unexpected')).toHaveLength(0)
    expect(
      outcomes.filter(
        (result) =>
          typeof result === 'object' && result.code === 'invalid_admin_credentials',
      ),
    ).toHaveLength(4)
    expect(
      outcomes.filter(
        (result) =>
          typeof result === 'object' && result.code === 'admin_login_rate_limited',
      ),
    ).toHaveLength(16)

    await expect(
      createService().login({
        username: 'admin',
        password: 'correct horse battery staple',
        clientIdentifier: '203.0.113.6',
      }),
    ).rejects.toMatchObject({
      code: 'admin_login_rate_limited',
      details: { retryAfterSeconds: 900 },
    })
  })

  it('clears the current client failure window after a successful login', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    const verifyCredential = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
      verifyCredential,
      generateToken: () => RAW_TOKEN,
    })

    await expect(
      service.login({
        username: 'admin',
        password: 'wrong password value',
        clientIdentifier: '203.0.113.7',
      }),
    ).rejects.toMatchObject({ code: 'invalid_admin_credentials' })
    await expect(
      service.login({
        username: 'admin',
        password: 'correct horse battery staple',
        clientIdentifier: '203.0.113.7',
      }),
    ).resolves.toBeTruthy()
    await expect(
      service.login({
        username: 'admin',
        password: 'wrong password value',
        clientIdentifier: '203.0.113.7',
      }),
    ).rejects.toMatchObject({ code: 'invalid_admin_credentials' })
  })

  it('does not let opportunistic cleanup failures change the login result', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    vi.spyOn(repository, 'cleanupExpired').mockRejectedValue(
      new Error('cleanup unavailable'),
    )
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
      verifyCredential: vi.fn().mockResolvedValue(true),
      generateToken: () => RAW_TOKEN,
    })

    await expect(
      service.login({
        username: 'admin',
        password: 'correct horse battery staple',
        clientIdentifier: '203.0.113.8',
      }),
    ).resolves.toMatchObject({
      token: RAW_TOKEN,
      session: { source: 'application_session' },
    })
  })

  it('maps session-store read failures to dependency_failure', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    vi.spyOn(repository, 'getByTokenHash').mockRejectedValue(new Error('D1 read failed'))
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
    })

    await expect(service.resolve(RAW_TOKEN)).rejects.toMatchObject({
      code: 'dependency_failure',
    })
  })

  it('maps session-store write failures to dependency_failure', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    vi.spyOn(repository, 'create').mockRejectedValue(new Error('D1 write failed'))
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
      verifyCredential: vi.fn().mockResolvedValue(true),
      generateToken: () => RAW_TOKEN,
    })

    await expect(
      service.login({
        username: 'admin',
        password: 'correct horse battery staple',
        clientIdentifier: '203.0.113.9',
      }),
    ).rejects.toMatchObject({ code: 'dependency_failure' })
  })

  it('maps temporary logout-store failures to dependency_failure', async () => {
    const config = await createConfig()
    const repository = createInMemoryAdminSessionRepository()
    const service = createAdminSessionService({
      sessionRepository: repository,
      rateLimitRepository: repository,
      config,
      now: () => NOW,
      generateToken: () => RAW_TOKEN,
    })
    await service.login({
      username: 'admin',
      password: 'correct horse battery staple',
      clientIdentifier: '203.0.113.10',
    })
    vi.spyOn(repository, 'revokeById').mockRejectedValue(new Error('D1 write failed'))

    await expect(service.logout(RAW_TOKEN)).rejects.toMatchObject({
      code: 'dependency_failure',
    })
  })
})
