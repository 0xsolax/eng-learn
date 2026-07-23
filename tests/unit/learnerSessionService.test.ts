import { describe, expect, it } from 'vitest'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import { createInMemoryLearnerLoginAttemptRepository } from '../../server/repositories/inMemoryLearnerLoginAttemptRepository'
import type { SessionRepository } from '../../server/repositories/sessionRepository'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import { hashAccessCode, hashSessionToken } from '../../server/security/credentialCrypto'
import { hashLearnerPin } from '../../server/security/learnerPinCrypto'
import { createInMemoryAdminOperationLedger } from '../../server/repositories/adminOperationLedger'

const RAW_ACCESS_CODE = 'ABCDEFGH23'
const RAW_SESSION_TOKEN = 'a'.repeat(64)
const NOW = new Date('2026-07-13T00:00:00.000Z')

const createCourse = async (repository: ReturnType<typeof createInMemoryCourseRepository>) => {
  await repository.createCourse({
    learner: {
      id: 'learner-1',
      name: 'Alice',
      accessCode: RAW_ACCESS_CODE,
      createdAt: NOW.toISOString(),
    },
    course: {
      id: 'course-1',
      learnerId: 'learner-1',
      sourceVersionId: 'version-1',
      currentLessonNo: 1,
      status: 'active',
      createdAt: NOW.toISOString(),
    },
  })
}

const createAccountCourse = async (
  repository: ReturnType<typeof createInMemoryCourseRepository>,
) => {
  await repository.createCourse({
    learner: {
      id: 'learner-account-1',
      name: 'Alice',
      accessCode: RAW_ACCESS_CODE,
      loginAccount: 'alice01',
      loginPinHash: await hashLearnerPin('123456'),
      legacyAccessEnabled: false,
      createdAt: NOW.toISOString(),
    },
    course: {
      id: 'course-account-1',
      learnerId: 'learner-account-1',
      sourceVersionId: 'version-1',
      currentLessonNo: 1,
      status: 'active',
      createdAt: NOW.toISOString(),
    },
  })
}

describe('learner session service', () => {
  it('exchanges the normalized assigned account and PIN while leaving the legacy code disabled', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository({ credentialPort: courseRepository })
    await createAccountCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository: createInMemoryLearnerLoginAttemptRepository(),
      now: () => NOW,
      generateToken: () => RAW_SESSION_TOKEN,
    })

    await expect(service.exchangeAccountLogin(' Alice01 ', '123456')).resolves.toMatchObject({
      token: RAW_SESSION_TOKEN,
      principal: { learnerId: 'learner-account-1', courseId: 'course-account-1' },
    })
    await expect(service.exchangeAccountLogin('alice01', '654321')).resolves.toBeUndefined()
    await expect(service.exchangeAccountLogin('missing01', '123456')).resolves.toBeUndefined()
    await expect(service.exchangeAccessCode(RAW_ACCESS_CODE)).resolves.toBeUndefined()
  })

  it('locks an account after five failed attempts and clears failures after a valid login', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository({ credentialPort: courseRepository })
    const loginAttemptRepository = createInMemoryLearnerLoginAttemptRepository()
    let currentTime = NOW
    await createAccountCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository,
      now: () => currentTime,
      generateToken: () => RAW_SESSION_TOKEN,
      verifyPin: (pin) => Promise.resolve(pin === '123456'),
    })

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(service.exchangeAccountLogin('alice01', '654321')).resolves.toBeUndefined()
    }
    await expect(service.exchangeAccountLogin('alice01', '654321')).rejects.toMatchObject({
      code: 'learner_login_rate_limited',
      details: { retryAfterSeconds: 900 },
    })
    await expect(service.exchangeAccountLogin('alice01', '123456')).rejects.toMatchObject({
      code: 'learner_login_rate_limited',
    })

    currentTime = new Date('2026-07-13T00:15:00.001Z')
    await expect(service.exchangeAccountLogin('alice01', '123456')).resolves.toBeDefined()
    await expect(service.exchangeAccountLogin('alice01', '654321')).resolves.toBeUndefined()
  })

  it('migrates a legacy learner to account login atomically and replays the same operation', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const courseRepository = createInMemoryCourseRepository({ ledger })
    const sessionRepository = createInMemorySessionRepository({
      credentialPort: courseRepository,
      ledger,
    })
    const loginAttemptRepository = createInMemoryLearnerLoginAttemptRepository()
    const tokens = ['a'.repeat(64), 'b'.repeat(64)]
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository,
      operationLedger: ledger,
      now: () => NOW,
      generateToken: () => tokens.shift() ?? 'unexpected-token',
      generateAccessCode: () => 'JKLMNPQR45',
    })
    const legacySession = await service.exchangeAccessCode(RAW_ACCESS_CODE)
    const command = {
      operationToken: '1'.repeat(64),
      expectedCredentialVersion: 1,
      loginAccount: ' Alice01 ',
      pin: '123456',
    }

    await expect(
      service.updateLoginCredentialIdempotently('learner-1', command),
    ).resolves.toEqual({
      loginAccount: 'alice01',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })
    await expect(service.resolve(legacySession?.token ?? '')).resolves.toEqual({
      status: 'revoked',
    })
    await expect(service.exchangeAccessCode(RAW_ACCESS_CODE)).resolves.toBeUndefined()
    await expect(service.exchangeAccountLogin('alice01', '123456')).resolves.toBeDefined()
    await expect(
      service.updateLoginCredentialIdempotently('learner-1', command),
    ).resolves.toEqual({
      loginAccount: 'alice01',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })
    await expect(
      service.updateLoginCredentialIdempotently('learner-1', {
        ...command,
        loginAccount: 'other01',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('renames an account without changing its PIN and revokes the previous session', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const courseRepository = createInMemoryCourseRepository({ ledger })
    const sessionRepository = createInMemorySessionRepository({
      credentialPort: courseRepository,
      ledger,
    })
    const tokens = ['a'.repeat(64), 'b'.repeat(64)]
    await createAccountCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository: createInMemoryLearnerLoginAttemptRepository(),
      operationLedger: ledger,
      now: () => NOW,
      generateToken: () => tokens.shift() ?? 'unexpected-token',
      generateAccessCode: () => 'JKLMNPQR45',
    })
    const oldSession = await service.exchangeAccountLogin('alice01', '123456')

    await expect(
      service.updateLoginCredentialIdempotently('learner-account-1', {
        operationToken: '2'.repeat(64),
        expectedCredentialVersion: 1,
        loginAccount: 'alice02',
      }),
    ).resolves.toEqual({
      loginAccount: 'alice02',
      credentialVersion: 2,
      revokedSessionCount: 1,
    })
    await expect(service.resolve(oldSession?.token ?? '')).resolves.toEqual({
      status: 'revoked',
    })
    await expect(service.exchangeAccountLogin('alice01', '123456')).resolves.toBeUndefined()
    await expect(service.exchangeAccountLogin('alice02', '123456')).resolves.toBeDefined()
  })

  it('allows only one concurrent credential update for the expected version', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const courseRepository = createInMemoryCourseRepository({ ledger })
    const sessionRepository = createInMemorySessionRepository({
      credentialPort: courseRepository,
      ledger,
    })
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository: createInMemoryLearnerLoginAttemptRepository(),
      operationLedger: ledger,
      now: () => NOW,
      generateAccessCode: () => 'JKLMNPQR45',
    })

    const results = await Promise.allSettled([
      service.updateLoginCredentialIdempotently('learner-1', {
        operationToken: '3'.repeat(64),
        expectedCredentialVersion: 1,
        loginAccount: 'alice01',
        pin: '123456',
      }),
      service.updateLoginCredentialIdempotently('learner-1', {
        operationToken: '4'.repeat(64),
        expectedCredentialVersion: 1,
        loginAccount: 'alice02',
        pin: '654321',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'credential_conflict' },
    })
  })

  it('rejects an account already assigned to another learner without changing either credential', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const courseRepository = createInMemoryCourseRepository({ ledger })
    const sessionRepository = createInMemorySessionRepository({
      credentialPort: courseRepository,
      ledger,
    })
    await createAccountCourse(courseRepository)
    await courseRepository.createCourse({
      learner: {
        id: 'learner-2',
        name: 'Bob',
        accessCode: 'BCDEFGHJ34',
        createdAt: NOW.toISOString(),
      },
      course: {
        id: 'course-2',
        learnerId: 'learner-2',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
        status: 'active',
        createdAt: NOW.toISOString(),
      },
    })
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      loginAttemptRepository: createInMemoryLearnerLoginAttemptRepository(),
      operationLedger: ledger,
      now: () => NOW,
      generateAccessCode: () => 'JKLMNPQR45',
    })

    await expect(
      service.updateLoginCredentialIdempotently('learner-2', {
        operationToken: '5'.repeat(64),
        expectedCredentialVersion: 1,
        loginAccount: 'alice01',
        pin: '123456',
      }),
    ).rejects.toMatchObject({ code: 'login_account_unavailable' })
    await expect(courseRepository.getAdminLearnerCredential('learner-2')).resolves.toMatchObject({
      credentialVersion: 1,
      legacyAccessEnabled: true,
    })
  })

  it('exchanges an access code for a 30-day opaque session stored only by token hash', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository()
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
      generateToken: () => RAW_SESSION_TOKEN,
    })

    const established = await service.exchangeAccessCode('abcdefgh23')

    expect(established).toMatchObject({
      token: RAW_SESSION_TOKEN,
      principal: {
        learnerId: 'learner-1',
        courseId: 'course-1',
        expiresAt: '2026-08-12T00:00:00.000Z',
      },
      identity: {
        learner: { id: 'learner-1', name: 'Alice' },
        course: { id: 'course-1', learnerId: 'learner-1' },
      },
    })

    const resolved = await service.resolve(RAW_SESSION_TOKEN)
    expect(resolved).toEqual({
      status: 'active',
      principal: established?.principal,
    })

    const tokenHash = await hashSessionToken(RAW_SESSION_TOKEN)
    const stored = await sessionRepository.getByTokenHash(tokenHash)
    expect(stored?.tokenHash).toBe(tokenHash)
    expect(stored?.tokenHash).not.toContain(RAW_SESSION_TOKEN)
  })

  it('distinguishes forged and expired tokens without accepting either principal', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository()
    let currentTime = NOW
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => currentTime,
      generateToken: () => RAW_SESSION_TOKEN,
    })
    await service.exchangeAccessCode(RAW_ACCESS_CODE)

    await expect(service.resolve('forged-token')).resolves.toEqual({ status: 'invalid' })

    currentTime = new Date('2026-08-12T00:00:00.001Z')
    await expect(service.resolve(RAW_SESSION_TOKEN)).resolves.toEqual({ status: 'expired' })
  })

  it('fails closed when a stored session expiry is malformed', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository()
    await sessionRepository.create({
      id: 'session-malformed-expiry',
      tokenHash: await hashSessionToken(RAW_SESSION_TOKEN),
      learnerId: 'learner-1',
      courseId: 'course-1',
      createdAt: NOW.toISOString(),
      expiresAt: 'not-a-date',
      credentialVersion: 1,
    })
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
    })

    await expect(service.resolve(RAW_SESSION_TOKEN)).resolves.toEqual({ status: 'invalid' })
  })

  it('treats a credential-version mismatch as a revoked session', async () => {
    const tokenHash = await hashSessionToken(RAW_SESSION_TOKEN)
    const sessionRepository = {
      create(session) {
        return Promise.resolve(session)
      },
      getByTokenHash(candidateHash) {
        return Promise.resolve(
          candidateHash === tokenHash
            ? {
                id: 'session-stale-version',
                tokenHash,
                learnerId: 'learner-1',
                courseId: 'course-1',
                createdAt: NOW.toISOString(),
                expiresAt: '2026-08-12T00:00:00.000Z',
                credentialVersion: 1,
                currentCredentialVersion: 2,
              }
            : undefined,
        )
      },
      revokeById() {
        return Promise.resolve(false)
      },
      revokeAllForLearner() {
        return Promise.resolve(0)
      },
      rotateLearnerCredential() {
        return Promise.resolve(undefined)
      },
    } satisfies SessionRepository
    const service = createLearnerSessionService({
      courseRepository: createInMemoryCourseRepository(),
      sessionRepository,
      now: () => NOW,
    })

    await expect(service.resolve(RAW_SESSION_TOKEN)).resolves.toEqual({ status: 'revoked' })
  })

  it('revokes one browser session idempotently for logout', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository()
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
      generateToken: () => RAW_SESSION_TOKEN,
    })
    await service.exchangeAccessCode(RAW_ACCESS_CODE)

    await expect(service.revoke('forged-token')).resolves.toBe(false)
    await expect(service.revoke(RAW_SESSION_TOKEN)).resolves.toBe(true)
    await expect(service.revoke(RAW_SESSION_TOKEN)).resolves.toBe(true)
    await expect(service.resolve(RAW_SESSION_TOKEN)).resolves.toEqual({ status: 'revoked' })
  })

  it('allows multiple devices and can revoke every session for one learner', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository()
    const tokens = ['a'.repeat(64), 'b'.repeat(64)]
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
      generateToken: () => tokens.shift() ?? 'unexpected-token',
    })

    const first = await service.exchangeAccessCode(RAW_ACCESS_CODE)
    const second = await service.exchangeAccessCode(RAW_ACCESS_CODE)

    expect(first?.token).not.toBe(second?.token)
    await expect(service.resolve(first?.token ?? '')).resolves.toMatchObject({ status: 'active' })
    await expect(service.resolve(second?.token ?? '')).resolves.toMatchObject({ status: 'active' })
    await expect(service.revokeAll('learner-1')).resolves.toBe(2)
    await expect(service.resolve(first?.token ?? '')).resolves.toEqual({ status: 'revoked' })
    await expect(service.resolve(second?.token ?? '')).resolves.toEqual({ status: 'revoked' })
  })

  it('rotates the access code and revokes every existing device session', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository({ credentialPort: courseRepository })
    const tokens = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
    await createCourse(courseRepository)
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
      generateToken: () => tokens.shift() ?? 'unexpected-token',
      generateAccessCode: () => 'JKLMNPQR45',
    })
    const first = await service.exchangeAccessCode(RAW_ACCESS_CODE)
    const second = await service.exchangeAccessCode(RAW_ACCESS_CODE)

    await expect(service.rotateAccessCode('learner-1')).resolves.toEqual({
      accessCode: 'JKLMNPQR45',
      revokedSessionCount: 2,
    })
    await expect(service.resolve(first?.token ?? '')).resolves.toEqual({ status: 'revoked' })
    await expect(service.resolve(second?.token ?? '')).resolves.toEqual({ status: 'revoked' })
    await expect(service.exchangeAccessCode(RAW_ACCESS_CODE)).resolves.toBeUndefined()
    await expect(service.exchangeAccessCode('jklmnpqr45')).resolves.toMatchObject({
      token: 'c'.repeat(64),
      principal: { learnerId: 'learner-1', courseId: 'course-1' },
    })
  })

  it('rejects an old-code exchange that loses a credential-rotation race', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const sessionRepository = createInMemorySessionRepository({ credentialPort: courseRepository })
    await createCourse(courseRepository)
    const racingSessionRepository: SessionRepository = {
      ...sessionRepository,
      async create(session) {
        await sessionRepository.rotateLearnerCredential({
          learnerId: session.learnerId,
          accessCodeHash: await hashAccessCode('JKLMNPQR45'),
          revokedAt: NOW.toISOString(),
        })

        return sessionRepository.create(session)
      },
    }
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository: racingSessionRepository,
      now: () => NOW,
      generateToken: () => RAW_SESSION_TOKEN,
    })

    await expect(service.exchangeAccessCode(RAW_ACCESS_CODE)).resolves.toBeUndefined()
  })

  it('makes access-code replacement and session revocation one rotation boundary', async () => {
    const courseRepository = createInMemoryCourseRepository()
    const baseSessionRepository = createInMemorySessionRepository({
      credentialPort: courseRepository,
    })
    await createCourse(courseRepository)
    const serviceHolder: { current?: ReturnType<typeof createLearnerSessionService> } = {}
    let exchangeDuringRotation: Awaited<ReturnType<typeof service.exchangeAccessCode>>
    const sessionRepository: SessionRepository = {
      ...baseSessionRepository,
      async revokeAllForLearner(learnerId, revokedAt) {
        const revokedCount = await baseSessionRepository.revokeAllForLearner(learnerId, revokedAt)
        const service = serviceHolder.current

        if (!service) {
          throw new Error('Test service is not initialized')
        }

        exchangeDuringRotation = await service.exchangeAccessCode(RAW_ACCESS_CODE)
        return revokedCount
      },
      async rotateLearnerCredential(rotation) {
        const revokedCount = await baseSessionRepository.rotateLearnerCredential(rotation)
        const service = serviceHolder.current

        if (!service) {
          throw new Error('Test service is not initialized')
        }

        exchangeDuringRotation = await service.exchangeAccessCode(RAW_ACCESS_CODE)
        return revokedCount
      },
    }
    const service = createLearnerSessionService({
      courseRepository,
      sessionRepository,
      now: () => NOW,
      generateToken: () => RAW_SESSION_TOKEN,
      generateAccessCode: () => 'JKLMNPQR45',
    })
    serviceHolder.current = service
    await service.exchangeAccessCode(RAW_ACCESS_CODE)

    await expect(service.rotateAccessCode('learner-1')).resolves.toEqual({
      accessCode: 'JKLMNPQR45',
      revokedSessionCount: 1,
    })
    expect(exchangeDuringRotation).toBeUndefined()
  })
})
