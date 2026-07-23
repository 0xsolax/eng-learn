import type {
  CourseAccessIdentity,
  CourseCredentialMatch,
  CourseRepository,
} from '../repositories/courseRepository'
import type { SessionRepository } from '../repositories/sessionRepository'
import type { LearnerLoginAttemptRepository } from '../repositories/learnerLoginAttemptRepository'
import type {
  AdminOperationLedgerReader,
  RotateAccessCodeAdminOperation,
  UpdateLearnerLoginAdminOperation,
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
import {
  hashLearnerPin,
  parseLearnerPinHash,
  verifyLearnerPin,
} from '../security/learnerPinCrypto'
import {
  learnerLoginAccountSchema,
  learnerPinSchema,
} from '../../shared/api/schemas'
import { findExactAdminOperation, prepareAdminOperation } from './adminOperation'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const LOGIN_BLOCK_MS = 15 * 60 * 1000
const MAXIMUM_LOGIN_ATTEMPTS = 5
const DUMMY_PIN_HASH = (() => {
  const parsed = parseLearnerPinHash(
    `pbkdf2-sha256:100000:${'0'.repeat(32)}:${'0'.repeat(64)}`,
  )

  if (!parsed) throw new Error('Dummy learner PIN hash is invalid')

  return parsed
})()

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
  exchangeAccountLogin(
    loginAccount: string,
    pin: string,
  ): Promise<EstablishedLearnerSession | undefined>
  exchangeAccessCode(accessCode: string): Promise<EstablishedLearnerSession | undefined>
  resolve(token: string): Promise<ResolveLearnerSessionResult>
  revoke(token: string): Promise<boolean>
  revokeAll(learnerId: string): Promise<number>
  updateLoginCredentialIdempotently(
    learnerId: string,
    input: {
      operationToken: string
      expectedCredentialVersion: number
      loginAccount: string
      pin?: string
    },
  ): Promise<
    | {
        loginAccount: string
        credentialVersion: number
        revokedSessionCount: number
      }
    | undefined
  >
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
  verifyPin?: typeof verifyLearnerPin
  loginAttemptRepository: LearnerLoginAttemptRepository
  operationLedger?: AdminOperationLedgerReader
}): LearnerSessionService => {
  const generateToken = input.generateToken ?? generateOpaqueToken
  const createAccessCode = input.generateAccessCode ?? generateAccessCode
  const verifyPin = input.verifyPin ?? verifyLearnerPin
  const establishSession = async (
    credential: CourseCredentialMatch,
  ): Promise<EstablishedLearnerSession | undefined> => {
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
  }

  return {
    async exchangeAccountLogin(loginAccount, pin) {
      const parsedAccount = learnerLoginAccountSchema.safeParse(loginAccount)
      const normalizedAccount = parsedAccount.success ? parsedAccount.data : '__invalid__'
      const now = input.now()
      const keyHash = await hashLoginAccount(normalizedAccount)
      const reservation = await requireLoginAttemptStore(() =>
        input.loginAttemptRepository.reserveAttempt({
          keyHash,
          now: now.toISOString(),
          resetBefore: new Date(now.getTime() - LOGIN_ATTEMPT_WINDOW_MS).toISOString(),
          blockedUntil: new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString(),
          maximumAttempts: MAXIMUM_LOGIN_ATTEMPTS,
        }),
      )

      if (reservation.status === 'blocked') {
        throw createLearnerRateLimitError(now, reservation.blockedUntil)
      }

      const credential = parsedAccount.success
        ? await input.courseRepository.getCourseCredentialByLoginAccount(parsedAccount.data)
        : undefined
      const pinMatches = await verifyPin(pin, credential?.loginPinHash ?? DUMMY_PIN_HASH)

      if (!credential || !pinMatches) {
        if (reservation.blockedUntil) {
          throw createLearnerRateLimitError(now, reservation.blockedUntil)
        }

        return undefined
      }

      await requireLoginAttemptStore(() =>
        input.loginAttemptRepository.clear(keyHash),
      )

      return establishSession(credential)
    },

    async exchangeAccessCode(accessCode) {
      const credential = await input.courseRepository.getCourseCredentialByAccessCode(accessCode)

      if (!credential) {
        return undefined
      }

      return establishSession(credential)
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

    async updateLoginCredentialIdempotently(learnerId, command) {
      if (!input.operationLedger) {
        throw new Error('Admin operation ledger is required')
      }

      const parsedAccount = learnerLoginAccountSchema.safeParse(command.loginAccount)
      const parsedPin =
        command.pin === undefined ? undefined : learnerPinSchema.safeParse(command.pin)

      if (!parsedAccount.success || (parsedPin && !parsedPin.success)) {
        throw new DomainError('bad_request', 'Learner login credential is invalid')
      }

      const request = {
        kind: 'update_learner_login' as const,
        learnerId,
        expectedCredentialVersion: command.expectedCredentialVersion,
        loginAccount: parsedAccount.data,
        ...(parsedPin ? { pin: parsedPin.data } : {}),
      }
      const prepared = await prepareAdminOperation(command.operationToken, request)
      const expected = { kind: 'update_learner_login' as const, targetId: learnerId }
      const existing = await findExactAdminOperation(
        input.operationLedger,
        prepared,
        expected,
      )

      if (existing) {
        if (existing.kind !== 'update_learner_login') {
          throw new Error('Matched learner login operation has an invalid kind')
        }

        return replayLearnerLoginUpdate(input.courseRepository, existing)
      }

      const credential = await input.courseRepository.getAdminLearnerCredential(learnerId)

      if (!credential) return undefined

      if (!parsedPin && !credential.loginPinHash) {
        throw new DomainError(
          'bad_request',
          'PIN is required when setting a learner login account for the first time',
        )
      }

      const loginPinHash = parsedPin
        ? await hashLearnerPin(parsedPin.data)
        : credential.loginPinHash

      if (!loginPinHash) {
        throw new Error('Learner PIN credential is unavailable')
      }

      const replacementAccessCode = parseRawAccessCode(createAccessCode())

      if (!replacementAccessCode) {
        throw new Error('Access code generator returned an invalid code')
      }

      const adminOperation = {
        operationHash: prepared.operationHash,
        kind: 'update_learner_login' as const,
        targetId: learnerId,
        requestFingerprint: prepared.requestFingerprint,
        outcomeLearnerId: learnerId,
        outcomeLoginAccount: parsedAccount.data,
        outcomeCredentialVersion: command.expectedCredentialVersion + 1,
        createdAt: input.now().toISOString(),
      }

      try {
        const updated = await input.sessionRepository.updateLearnerLoginCredentialIdempotently({
          learnerId,
          loginAccount: parsedAccount.data,
          loginPinHash,
          accessCodeHash: await hashAccessCode(replacementAccessCode),
          expectedCredentialVersion: command.expectedCredentialVersion,
          revokedAt: adminOperation.createdAt,
          adminOperation,
        })

        if (updated) {
          return { loginAccount: parsedAccount.data, ...updated }
        }
      } catch (error) {
        const raced = await findExactAdminOperation(
          input.operationLedger,
          prepared,
          expected,
        )

        if (raced?.kind === 'update_learner_login') {
          return replayLearnerLoginUpdate(input.courseRepository, raced)
        }

        throw error
      }

      const raced = await findExactAdminOperation(
        input.operationLedger,
        prepared,
        expected,
      )

      if (raced?.kind === 'update_learner_login') {
        return replayLearnerLoginUpdate(input.courseRepository, raced)
      }

      const current = await input.courseRepository.getAdminLearnerCredential(learnerId)

      if (!current) return undefined

      throw new DomainError(
        'credential_conflict',
        'Learner credential version changed before login update',
      )
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

const replayLearnerLoginUpdate = async (
  repository: CourseRepository,
  operation: UpdateLearnerLoginAdminOperation,
) => {
  const credential = await repository.getAdminLearnerCredential(
    operation.outcomeLearnerId,
  )

  if (!credential) {
    throw new DomainError(
      'dependency_failure',
      'Committed learner login update outcome is unavailable',
    )
  }

  if (
    credential.credentialVersion !== operation.outcomeCredentialVersion ||
    credential.loginAccount !== operation.outcomeLoginAccount
  ) {
    throw new DomainError(
      'operation_superseded',
      'The committed learner login update has been superseded',
    )
  }

  return {
    loginAccount: operation.outcomeLoginAccount,
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

const hashLoginAccount = async (loginAccount: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(loginAccount)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

const createLearnerRateLimitError = (now: Date, blockedUntil: string): DomainError => {
  const remainingMilliseconds = Math.max(1_000, Date.parse(blockedUntil) - now.getTime())

  return new DomainError(
    'learner_login_rate_limited',
    'Learner login is temporarily rate limited',
    { retryAfterSeconds: Math.ceil(remainingMilliseconds / 1_000) },
  )
}

const requireLoginAttemptStore = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DomainError) throw error

    throw new DomainError(
      'dependency_failure',
      'Learner authentication storage is unavailable',
    )
  }
}
