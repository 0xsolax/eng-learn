import type {
  CourseAccessIdentity,
  CourseRepository,
} from '../repositories/courseRepository'
import type { SessionRepository } from '../repositories/sessionRepository'
import type {
  AdminOperationLedgerReader,
  RotateAccessCodeAdminOperation,
} from '../repositories/adminOperationLedger'
import { DomainError } from '../errors/DomainError'
import {
  generateAccessCode,
  generateOpaqueToken,
  hashAccessCode,
  hashSessionToken,
  parseRawAccessCode,
  parseRawSessionToken,
  type RawAccessCode,
  type RawSessionToken,
} from '../security/credentialCrypto'
import { deriveAdminOperationAccessCode } from '../security/adminOperationCrypto'
import { findExactAdminOperation, prepareAdminOperation } from './adminOperation'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type LearnerSessionPrincipal = {
  sessionId: string
  learnerId: string
  courseId: string
  expiresAt: string
}

export type EstablishedLearnerSession = {
  token: RawSessionToken
  principal: LearnerSessionPrincipal
  identity: CourseAccessIdentity
}

export type ResolveLearnerSessionResult =
  | { status: 'active'; principal: LearnerSessionPrincipal }
  | { status: 'expired' }
  | { status: 'invalid' }
  | { status: 'revoked' }

export type LearnerSessionService = {
  exchangeAccessCode(accessCode: string): Promise<EstablishedLearnerSession | undefined>
  resolve(token: string): Promise<ResolveLearnerSessionResult>
  revoke(token: string): Promise<boolean>
  revokeAll(learnerId: string): Promise<number>
  rotateAccessCode(
    learnerId: string,
  ): Promise<{ accessCode: RawAccessCode; revokedSessionCount: number } | undefined>
  rotateAccessCodeIdempotently(
    learnerId: string,
    input: {
      operationToken: string
      expectedCredentialVersion: number
    },
  ): Promise<
    | {
        accessCode: RawAccessCode
        credentialVersion: number
        revokedSessionCount: number
      }
    | undefined
  >
}

export const createLearnerSessionService = (input: {
  courseRepository: CourseRepository
  sessionRepository: SessionRepository
  now: () => Date
  generateToken?: () => string
  generateAccessCode?: () => string
  operationLedger?: AdminOperationLedgerReader
}): LearnerSessionService => {
  const generateToken = input.generateToken ?? generateOpaqueToken
  const createAccessCode = input.generateAccessCode ?? generateAccessCode

  return {
    async exchangeAccessCode(accessCode) {
      const credential = await input.courseRepository.getCourseCredentialByAccessCode(accessCode)

      if (!credential) {
        return undefined
      }

      if (credential.identity.course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      const token = parseRawSessionToken(generateToken())

      if (!token) {
        throw new Error('Session token generator returned an invalid token')
      }

      const tokenHash = await hashSessionToken(token)
      const createdAt = input.now()
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString()
      const session = await input.sessionRepository.create({
        id: crypto.randomUUID(),
        tokenHash,
        learnerId: credential.identity.learner.id,
        courseId: credential.identity.course.id,
        createdAt: createdAt.toISOString(),
        expiresAt,
        credentialVersion: credential.credentialVersion,
      })

      if (!session) {
        const currentCourse = await input.courseRepository.getCourseForLearner({
          learnerId: credential.identity.learner.id,
          courseId: credential.identity.course.id,
        })

        if (currentCourse && currentCourse.status !== 'active') {
          throw new DomainError('course_unavailable', 'Course is not active')
        }

        return undefined
      }

      return {
        token,
        principal: toPrincipal(session),
        identity: credential.identity,
      }
    },

    async resolve(token) {
      const rawToken = parseRawSessionToken(token)

      if (!rawToken) {
        return { status: 'invalid' }
      }

      const session = await input.sessionRepository.getByTokenHash(await hashSessionToken(rawToken))

      if (!session) {
        return { status: 'invalid' }
      }

      if (session.revokedAt) {
        return { status: 'revoked' }
      }

      if (session.credentialVersion !== session.currentCredentialVersion) {
        return { status: 'revoked' }
      }

      const expiresAt = Date.parse(session.expiresAt)

      if (!Number.isFinite(expiresAt)) {
        return { status: 'invalid' }
      }

      if (expiresAt <= input.now().getTime()) {
        return { status: 'expired' }
      }

      return {
        status: 'active',
        principal: toPrincipal(session),
      }
    },

    async revoke(token) {
      const rawToken = parseRawSessionToken(token)

      if (!rawToken) {
        return false
      }

      const session = await input.sessionRepository.getByTokenHash(await hashSessionToken(rawToken))

      if (!session) {
        return false
      }

      return input.sessionRepository.revokeById(session.id, input.now().toISOString())
    },

    async revokeAll(learnerId) {
      return input.sessionRepository.revokeAllForLearner(learnerId, input.now().toISOString())
    },

    async rotateAccessCode(learnerId) {
      const accessCode = parseRawAccessCode(createAccessCode())

      if (!accessCode) {
        throw new Error('Access code generator returned an invalid code')
      }
      const revokedSessionCount = await input.sessionRepository.rotateLearnerCredential({
        learnerId,
        accessCodeHash: await hashAccessCode(accessCode),
        revokedAt: input.now().toISOString(),
      })

      return revokedSessionCount === undefined ? undefined : { accessCode, revokedSessionCount }
    },

    async rotateAccessCodeIdempotently(learnerId, command) {
      if (!input.operationLedger) {
        throw new Error('Admin operation ledger is required')
      }

      const request = {
        kind: 'rotate_access_code' as const,
        learnerId,
        expectedCredentialVersion: command.expectedCredentialVersion,
      }
      const prepared = await prepareAdminOperation(command.operationToken, request)
      const expected = { kind: 'rotate_access_code' as const, targetId: learnerId }
      const existing = await findExactAdminOperation(
        input.operationLedger,
        prepared,
        expected,
      )

      if (existing) {
        if (existing.kind !== 'rotate_access_code') {
          throw new Error('Matched access-code rotation operation has an invalid kind')
        }

        return replayAccessCodeRotation(input.courseRepository, prepared.token, existing)
      }

      const accessCode = await deriveAdminOperationAccessCode(
        'rotate_access_code',
        prepared.token,
      )
      const adminOperation: Omit<
        RotateAccessCodeAdminOperation,
        'revokedSessionCount'
      > = {
        operationHash: prepared.operationHash,
        kind: 'rotate_access_code',
        targetId: learnerId,
        requestFingerprint: prepared.requestFingerprint,
        outcomeLearnerId: learnerId,
        outcomeCredentialVersion: command.expectedCredentialVersion + 1,
        createdAt: input.now().toISOString(),
      }

      try {
        const rotated = await input.sessionRepository.rotateLearnerCredentialIdempotently({
          learnerId,
          accessCodeHash: await hashAccessCode(accessCode),
          expectedCredentialVersion: command.expectedCredentialVersion,
          revokedAt: adminOperation.createdAt,
          adminOperation,
        })

        if (rotated) {
          return { accessCode, ...rotated }
        }
      } catch (error) {
        const raced = await findExactAdminOperation(
          input.operationLedger,
          prepared,
          expected,
        )

        if (raced?.kind === 'rotate_access_code') {
          return replayAccessCodeRotation(input.courseRepository, prepared.token, raced)
        }

        throw error
      }

      const raced = await findExactAdminOperation(
        input.operationLedger,
        prepared,
        expected,
      )

      if (raced?.kind === 'rotate_access_code') {
        return replayAccessCodeRotation(input.courseRepository, prepared.token, raced)
      }

      const credential = await input.courseRepository.getAdminLearnerCredential(learnerId)

      if (!credential) return undefined

      throw new DomainError(
        'credential_conflict',
        'Learner credential version changed before rotation',
      )
    },
  }
}

const replayAccessCodeRotation = async (
  repository: CourseRepository,
  token: Parameters<typeof deriveAdminOperationAccessCode>[1],
  operation: RotateAccessCodeAdminOperation,
) => {
  const [credential, accessCode] = await Promise.all([
    repository.getAdminLearnerCredential(operation.outcomeLearnerId),
    deriveAdminOperationAccessCode('rotate_access_code', token),
  ])

  if (!credential) {
    throw new DomainError(
      'dependency_failure',
      'Committed access-code rotation outcome is unavailable',
    )
  }

  if (
    credential.credentialVersion !== operation.outcomeCredentialVersion ||
    credential.accessCodeHash !== (await hashAccessCode(accessCode))
  ) {
    throw new DomainError(
      'operation_superseded',
      'The committed one-time code has been superseded',
    )
  }

  return {
    accessCode,
    credentialVersion: operation.outcomeCredentialVersion,
    revokedSessionCount: operation.revokedSessionCount,
  }
}

const toPrincipal = (session: {
  id: string
  learnerId: string
  courseId: string
  expiresAt: string
}): LearnerSessionPrincipal => ({
  sessionId: session.id,
  learnerId: session.learnerId,
  courseId: session.courseId,
  expiresAt: session.expiresAt,
})
