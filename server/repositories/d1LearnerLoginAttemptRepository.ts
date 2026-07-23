import type { LearnerLoginAttemptRepository } from './learnerLoginAttemptRepository'

type LearnerLoginAttemptRow = {
  failure_count: number
  blocked_until: string | null
}

export const createD1LearnerLoginAttemptRepository = (
  db: D1Database,
): LearnerLoginAttemptRepository => ({
  async reserveAttempt(input) {
    const row = await db
      .prepare(
        `INSERT INTO learner_login_attempts
          (account_hash, window_started_at, failure_count, blocked_until, updated_at)
        VALUES (?, ?, 1, NULL, ?)
        ON CONFLICT(account_hash) DO UPDATE SET
          window_started_at = CASE
            WHEN learner_login_attempts.window_started_at <= ?
              OR (learner_login_attempts.blocked_until IS NOT NULL
                AND learner_login_attempts.blocked_until <= ?)
            THEN ?
            ELSE learner_login_attempts.window_started_at
          END,
          failure_count = CASE
            WHEN learner_login_attempts.window_started_at <= ?
              OR (learner_login_attempts.blocked_until IS NOT NULL
                AND learner_login_attempts.blocked_until <= ?)
            THEN 1
            ELSE learner_login_attempts.failure_count + 1
          END,
          blocked_until = CASE
            WHEN learner_login_attempts.window_started_at <= ?
              OR (learner_login_attempts.blocked_until IS NOT NULL
                AND learner_login_attempts.blocked_until <= ?)
            THEN NULL
            WHEN learner_login_attempts.failure_count + 1 >= ? THEN ?
            ELSE learner_login_attempts.blocked_until
          END,
          updated_at = ?
        WHERE
          (learner_login_attempts.blocked_until IS NULL
            OR learner_login_attempts.blocked_until <= ?)
          AND (
            learner_login_attempts.window_started_at <= ?
            OR learner_login_attempts.failure_count < ?
          )
        RETURNING failure_count, blocked_until`,
      )
      .bind(
        input.keyHash,
        input.now,
        input.now,
        input.resetBefore,
        input.now,
        input.now,
        input.resetBefore,
        input.now,
        input.resetBefore,
        input.now,
        input.maximumAttempts,
        input.blockedUntil,
        input.now,
        input.now,
        input.resetBefore,
        input.maximumAttempts,
      )
      .first<LearnerLoginAttemptRow>()

    if (row) {
      return {
        status: 'reserved',
        attemptNumber: row.failure_count,
        ...(row.blocked_until ? { blockedUntil: row.blocked_until } : {}),
      }
    }

    const blocked = await db
      .prepare(
        'SELECT failure_count, blocked_until FROM learner_login_attempts WHERE account_hash = ?',
      )
      .bind(input.keyHash)
      .first<LearnerLoginAttemptRow>()

    if (!blocked?.blocked_until) {
      throw new Error('Learner login reservation failed without a persisted cooldown')
    }

    return { status: 'blocked', blockedUntil: blocked.blocked_until }
  },

  async clear(keyHash) {
    await db
      .prepare('DELETE FROM learner_login_attempts WHERE account_hash = ?')
      .bind(keyHash)
      .run()
  },
})
