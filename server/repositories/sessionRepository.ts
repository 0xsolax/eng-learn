import type { AccessCodeHash, SessionTokenHash } from '../security/credentialCrypto'
import type { LearnerPinHash } from '../security/learnerPinCrypto'
import type {
  RotateAccessCodeAdminOperation,
  UpdateLearnerLoginAdminOperation,
} from './adminOperationLedger'

export type LearnerSessionRecord = {
  id: string
  tokenHash: SessionTokenHash
  learnerId: string
  courseId: string
  createdAt: string
  expiresAt: string
  credentialVersion: number
  revokedAt?: string
}

export type LearnerSessionLookup = LearnerSessionRecord & {
  currentCredentialVersion: number
}

export type SessionRepository = {
  create(session: LearnerSessionRecord): Promise<LearnerSessionRecord | undefined>
  getByTokenHash(tokenHash: SessionTokenHash): Promise<LearnerSessionLookup | undefined>
  revokeById(sessionId: string, revokedAt: string): Promise<boolean>
  revokeAllForLearner(learnerId: string, revokedAt: string): Promise<number>
  rotateLearnerCredential(input: {
    learnerId: string
    accessCodeHash: AccessCodeHash
    revokedAt: string
  }): Promise<number | undefined>
  rotateLearnerCredentialIdempotently(input: {
    learnerId: string
    accessCodeHash: AccessCodeHash
    expectedCredentialVersion: number
    revokedAt: string
    adminOperation: Omit<RotateAccessCodeAdminOperation, 'revokedSessionCount'>
  }): Promise<
    | {
        credentialVersion: number
        revokedSessionCount: number
      }
    | undefined
  >
  updateLearnerLoginCredentialIdempotently(input: {
    learnerId: string
    loginAccount: string
    loginPinHash: LearnerPinHash
    accessCodeHash: AccessCodeHash
    expectedCredentialVersion: number
    revokedAt: string
    adminOperation: Omit<UpdateLearnerLoginAdminOperation, 'revokedSessionCount'>
  }): Promise<
    | {
        credentialVersion: number
        revokedSessionCount: number
      }
    | undefined
  >
}
