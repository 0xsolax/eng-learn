import type {
  LearnerLoginAttemptRepository,
  LearnerLoginAttemptReservation,
} from './learnerLoginAttemptRepository'

type LearnerLoginAttemptRecord = {
  windowStartedAt: string
  failureCount: number
  blockedUntil?: string
}

export const createInMemoryLearnerLoginAttemptRepository =
  (): LearnerLoginAttemptRepository => {
    const attemptsByKeyHash = new Map<string, LearnerLoginAttemptRecord>()
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
      reserveAttempt(input): Promise<LearnerLoginAttemptReservation> {
        return runExclusive(() => {
          const existing = attemptsByKeyHash.get(input.keyHash)

          if (
            existing?.blockedUntil &&
            Date.parse(existing.blockedUntil) > Date.parse(input.now)
          ) {
            return { status: 'blocked', blockedUntil: existing.blockedUntil }
          }

          const shouldReset =
            !existing ||
            existing.windowStartedAt <= input.resetBefore ||
            (existing.blockedUntil !== undefined && existing.blockedUntil <= input.now)
          const attemptNumber = shouldReset ? 1 : existing.failureCount + 1

          if (attemptNumber > input.maximumAttempts) {
            return {
              status: 'blocked',
              blockedUntil: existing?.blockedUntil ?? input.blockedUntil,
            }
          }

          const blockedUntil =
            attemptNumber === input.maximumAttempts ? input.blockedUntil : undefined
          attemptsByKeyHash.set(input.keyHash, {
            windowStartedAt: shouldReset ? input.now : existing.windowStartedAt,
            failureCount: attemptNumber,
            ...(blockedUntil ? { blockedUntil } : {}),
          })

          return {
            status: 'reserved',
            attemptNumber,
            ...(blockedUntil ? { blockedUntil } : {}),
          }
        })
      },

      clear(keyHash) {
        attemptsByKeyHash.delete(keyHash)
        return Promise.resolve()
      },
    }
  }
