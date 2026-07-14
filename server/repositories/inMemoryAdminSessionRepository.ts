import type {
  AdminLoginRateLimitRepository,
  AdminSessionRecord,
  AdminSessionRepository,
} from './adminSessionRepository'

type LoginRateLimitRecord = {
  windowStartedAt: string
  failureCount: number
  blockedUntil?: string
  updatedAt: string
}

export const createInMemoryAdminSessionRepository = (): AdminSessionRepository &
  AdminLoginRateLimitRepository => {
  const sessionsByHash = new Map<string, AdminSessionRecord>()
  const rateLimitsByHash = new Map<string, LoginRateLimitRecord>()
  let exclusiveQueue = Promise.resolve()

  const runExclusive = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = exclusiveQueue.then(operation, operation)
    exclusiveQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    create(session) {
      if (sessionsByHash.has(session.tokenHash)) {
        return Promise.reject(new Error('Admin session token hash already exists'))
      }
      const stored = { ...session }
      sessionsByHash.set(stored.tokenHash, stored)
      return Promise.resolve({ ...stored })
    },

    getByTokenHash(tokenHash) {
      const session = sessionsByHash.get(tokenHash)
      return Promise.resolve(session ? { ...session } : undefined)
    },

    async revokeById(sessionId, revokedAt) {
      const session = Array.from(sessionsByHash.values()).find(
        (candidate) => candidate.id === sessionId,
      )
      if (!session) return false
      sessionsByHash.set(session.tokenHash, {
        ...session,
        revokedAt: session.revokedAt ?? revokedAt,
      })
      return true
    },

    reserveAttempt(input) {
      return runExclusive(() => {
        const existing = rateLimitsByHash.get(input.keyHash)
        if (
          existing?.blockedUntil &&
          Date.parse(existing.blockedUntil) > Date.parse(input.now)
        ) {
          return { status: 'blocked' as const, blockedUntil: existing.blockedUntil }
        }

        const shouldReset =
          !existing ||
          existing.windowStartedAt <= input.resetBefore ||
          (existing.blockedUntil !== undefined && existing.blockedUntil <= input.now)
        const attemptNumber = shouldReset ? 1 : existing.failureCount + 1
        if (attemptNumber > input.maximumAttempts) {
          return {
            status: 'blocked' as const,
            blockedUntil: existing?.blockedUntil ?? input.blockedUntil,
          }
        }

        const blockedUntil =
          attemptNumber === input.maximumAttempts ? input.blockedUntil : undefined
        rateLimitsByHash.set(input.keyHash, {
          windowStartedAt: shouldReset ? input.now : existing.windowStartedAt,
          failureCount: attemptNumber,
          ...(blockedUntil ? { blockedUntil } : {}),
          updatedAt: input.now,
        })
        return {
          status: 'reserved' as const,
          attemptNumber,
          ...(blockedUntil ? { blockedUntil } : {}),
        }
      })
    },

    clear(keyHash) {
      rateLimitsByHash.delete(keyHash)
      return Promise.resolve()
    },
  }
}
