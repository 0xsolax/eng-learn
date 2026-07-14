import type {
  AdminLoginRateLimitRepository,
  AdminSessionRecord,
  AdminSessionRepository,
} from './adminSessionRepository'

type AdminSessionRow = {
  id: string
  token_hash: string
  credential_id: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

type RateLimitRow = {
  failure_count: number
  blocked_until: string | null
}

export const createD1AdminSessionRepository = (
  db: D1Database,
): AdminSessionRepository & AdminLoginRateLimitRepository => ({
  async create(session) {
    await db
      .prepare(
        'INSERT INTO admin_sessions (id, token_hash, credential_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        session.id,
        session.tokenHash,
        session.credentialId,
        session.createdAt,
        session.expiresAt,
        session.revokedAt ?? null,
      )
      .run()
    return session
  },

  async getByTokenHash(tokenHash) {
    const row = await db
      .prepare('SELECT * FROM admin_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .first<AdminSessionRow>()
    return row ? mapAdminSession(row) : undefined
  },

  async revokeById(sessionId, revokedAt) {
    const result = await db
      .prepare(
        'UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?',
      )
      .bind(revokedAt, sessionId)
      .run()
    return result.meta.changes > 0
  },

  async cleanupExpired(input) {
    await db
      .prepare(
        `DELETE FROM admin_sessions
        WHERE id IN (
          SELECT id FROM admin_sessions
          WHERE expires_at <= ?
          ORDER BY expires_at
          LIMIT 100
        )`,
      )
      .bind(input.sessionsExpiredBefore)
      .run()
    await db
      .prepare(
        `DELETE FROM admin_login_rate_limits
        WHERE key_hash IN (
          SELECT key_hash FROM admin_login_rate_limits
          WHERE updated_at <= ?
            AND (blocked_until IS NULL OR blocked_until <= ?)
          ORDER BY updated_at
          LIMIT 100
        )`,
      )
      .bind(input.rateLimitsUpdatedBefore, input.rateLimitsUnblockedBefore)
      .run()
  },

  async reserveAttempt(input) {
    const row = await db
      .prepare(
        `INSERT INTO admin_login_rate_limits
          (key_hash, window_started_at, failure_count, blocked_until, updated_at)
        VALUES (?, ?, 1, NULL, ?)
        ON CONFLICT(key_hash) DO UPDATE SET
          window_started_at = CASE
            WHEN admin_login_rate_limits.window_started_at <= ?
              OR (admin_login_rate_limits.blocked_until IS NOT NULL
                AND admin_login_rate_limits.blocked_until <= ?)
            THEN ?
            ELSE admin_login_rate_limits.window_started_at
          END,
          failure_count = CASE
            WHEN admin_login_rate_limits.window_started_at <= ?
              OR (admin_login_rate_limits.blocked_until IS NOT NULL
                AND admin_login_rate_limits.blocked_until <= ?)
            THEN 1
            ELSE admin_login_rate_limits.failure_count + 1
          END,
          blocked_until = CASE
            WHEN admin_login_rate_limits.window_started_at <= ?
              OR (admin_login_rate_limits.blocked_until IS NOT NULL
                AND admin_login_rate_limits.blocked_until <= ?)
            THEN NULL
            WHEN admin_login_rate_limits.failure_count + 1 >= ? THEN ?
            ELSE admin_login_rate_limits.blocked_until
          END,
          updated_at = ?
        WHERE
          (admin_login_rate_limits.blocked_until IS NULL
            OR admin_login_rate_limits.blocked_until <= ?)
          AND (
            admin_login_rate_limits.window_started_at <= ?
            OR admin_login_rate_limits.failure_count < ?
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
      .first<RateLimitRow>()

    if (row) {
      return {
        status: 'reserved',
        attemptNumber: row.failure_count,
        ...(row.blocked_until ? { blockedUntil: row.blocked_until } : {}),
      }
    }

    const blocked = await db
      .prepare(
        'SELECT failure_count, blocked_until FROM admin_login_rate_limits WHERE key_hash = ?',
      )
      .bind(input.keyHash)
      .first<RateLimitRow>()
    if (!blocked?.blocked_until) {
      throw new Error('Admin login reservation failed without a persisted cooldown')
    }
    return { status: 'blocked', blockedUntil: blocked.blocked_until }
  },

  async clear(keyHash) {
    await db
      .prepare('DELETE FROM admin_login_rate_limits WHERE key_hash = ?')
      .bind(keyHash)
      .run()
  },
})

const mapAdminSession = (row: AdminSessionRow): AdminSessionRecord => ({
  id: row.id,
  tokenHash: row.token_hash,
  credentialId: row.credential_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
})
