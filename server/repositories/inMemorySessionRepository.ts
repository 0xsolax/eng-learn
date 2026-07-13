import type { LearnerSessionRecord, SessionRepository } from './sessionRepository'
import type { InMemoryLearnerCredentialPort } from './inMemoryCourseRepository'
import {
  createInMemoryAdminOperationLedger,
  type InMemoryAdminOperationLedger,
} from './adminOperationLedger'

export const createInMemorySessionRepository = (
  input: {
    credentialPort?: InMemoryLearnerCredentialPort
    ledger?: InMemoryAdminOperationLedger
  } = {},
): SessionRepository => {
  const sessionsByTokenHash = new Map<string, LearnerSessionRecord>()
  const ledger = input.ledger ?? createInMemoryAdminOperationLedger()

  return {
    create(session) {
      if (input.credentialPort) {
        const eligibility = input.credentialPort.getLearnerSessionEligibility({
          learnerId: session.learnerId,
          courseId: session.courseId,
        })

        if (
          eligibility?.credentialVersion !== session.credentialVersion ||
          eligibility.courseStatus !== 'active'
        ) {
          return Promise.resolve(undefined)
        }
      }

      sessionsByTokenHash.set(session.tokenHash, session)
      return Promise.resolve(session)
    },

    async getByTokenHash(tokenHash) {
      const session = sessionsByTokenHash.get(tokenHash)

      if (!session) {
        return undefined
      }

      const currentCredentialVersion = input.credentialPort
        ? await input.credentialPort.getLearnerCredentialVersion(session.learnerId)
        : session.credentialVersion

      return currentCredentialVersion === undefined
        ? undefined
        : { ...session, currentCredentialVersion }
    },

    async revokeById(sessionId, revokedAt) {
      const session = Array.from(sessionsByTokenHash.values()).find(
        (candidate) => candidate.id === sessionId,
      )

      if (!session) {
        return false
      }

      sessionsByTokenHash.set(session.tokenHash, {
        ...session,
        revokedAt: session.revokedAt ?? revokedAt,
      })
      return true
    },

    async revokeAllForLearner(learnerId, revokedAt) {
      let revokedCount = 0

      for (const session of sessionsByTokenHash.values()) {
        if (session.learnerId === learnerId && !session.revokedAt) {
          sessionsByTokenHash.set(session.tokenHash, { ...session, revokedAt })
          revokedCount += 1
        }
      }

      return revokedCount
    },

    async rotateLearnerCredential(rotation) {
      if (!input.credentialPort) {
        return undefined
      }

      const advanced = await input.credentialPort.advanceLearnerCredential({
        learnerId: rotation.learnerId,
        accessCodeHash: rotation.accessCodeHash,
      })

      if (!advanced) {
        return undefined
      }

      let revokedCount = 0

      for (const session of sessionsByTokenHash.values()) {
        if (session.learnerId === rotation.learnerId && !session.revokedAt) {
          sessionsByTokenHash.set(session.tokenHash, {
            ...session,
            revokedAt: rotation.revokedAt,
          })
          revokedCount += 1
        }
      }

      return revokedCount
    },

    async rotateLearnerCredentialIdempotently(rotation) {
      return ledger.runExclusive(async () => {
        if (await ledger.get(rotation.adminOperation.operationHash)) {
          throw new Error('Admin operation already exists')
        }

        if (!input.credentialPort) {
          return undefined
        }

        const advanced = await input.credentialPort.advanceLearnerCredential({
          learnerId: rotation.learnerId,
          accessCodeHash: rotation.accessCodeHash,
          expectedCredentialVersion: rotation.expectedCredentialVersion,
        })

        if (!advanced) {
          return undefined
        }

        let revokedSessionCount = 0

        for (const session of sessionsByTokenHash.values()) {
          if (session.learnerId === rotation.learnerId && !session.revokedAt) {
            sessionsByTokenHash.set(session.tokenHash, {
              ...session,
              revokedAt: rotation.revokedAt,
            })
            revokedSessionCount += 1
          }
        }

        ledger.insert({
          ...rotation.adminOperation,
          revokedSessionCount,
        })

        return {
          credentialVersion: rotation.adminOperation.outcomeCredentialVersion,
          revokedSessionCount,
        }
      })
    },
  }
}
