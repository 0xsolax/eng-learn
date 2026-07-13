import { describe, expect, it } from 'vitest'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import type { SessionRepository } from '../../server/repositories/sessionRepository'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import { hashAccessCode, hashSessionToken } from '../../server/security/credentialCrypto'

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

describe('learner session service', () => {
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
