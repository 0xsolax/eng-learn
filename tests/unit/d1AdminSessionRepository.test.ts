import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1AdminSessionRepository } from '../../server/repositories/d1AdminSessionRepository'

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first<T>(): Promise<T | null>
}

const createSqliteD1 = (database: DatabaseSync): D1Database => {
  const prepare = (sql: string): SqliteD1Statement => {
    const statement = database.prepare(sql)
    let bindings: SQLInputValue[] = []
    const adapter: SqliteD1Statement = {
      bind(...values) {
        bindings = values as SQLInputValue[]
        return adapter
      },
      run() {
        const result = statement.run(...bindings)
        return Promise.resolve({ success: true, meta: { changes: Number(result.changes) } })
      },
      first<T>() {
        return Promise.resolve((statement.get(...bindings) as T | undefined) ?? null)
      },
    }
    return adapter
  }
  return { prepare } as unknown as D1Database
}

const createFixture = () => {
  const database = new DatabaseSync(':memory:')
  database.exec(readFileSync(new URL('../../migrations/0010_add_admin_sessions.sql', import.meta.url), 'utf8'))
  return { database, repository: createD1AdminSessionRepository(createSqliteD1(database)) }
}

describe('D1 admin session repository', () => {
  it('creates, resolves, and idempotently revokes only hashed sessions', async () => {
    const { database, repository } = createFixture()
    const session = {
      id: 'session-1',
      tokenHash: 'a'.repeat(64),
      credentialId: 'credential-1',
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T08:00:00.000Z',
    }

    await expect(repository.create(session)).resolves.toEqual(session)
    await expect(repository.getByTokenHash(session.tokenHash)).resolves.toEqual(session)
    expect(
      database.prepare('SELECT token_hash FROM admin_sessions WHERE id = ?').get(session.id),
    ).toEqual({ token_hash: session.tokenHash })
    await expect(
      repository.revokeById(session.id, '2026-07-14T01:00:00.000Z'),
    ).resolves.toBe(true)
    await expect(
      repository.revokeById(session.id, '2026-07-14T02:00:00.000Z'),
    ).resolves.toBe(true)
    await expect(repository.getByTokenHash(session.tokenHash)).resolves.toMatchObject({
      revokedAt: '2026-07-14T01:00:00.000Z',
    })
  })

  it('atomically reserves at most five verifier slots for concurrent requests', async () => {
    const { database, repository } = createFixture()
    const input = {
      keyHash: 'b'.repeat(64),
      now: '2026-07-14T00:00:00.000Z',
      resetBefore: '2026-07-13T23:45:00.000Z',
      blockedUntil: '2026-07-14T00:15:00.000Z',
      maximumAttempts: 5,
    }
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => repository.reserveAttempt(input)),
    )

    expect(outcomes.filter((outcome) => outcome.status === 'reserved')).toHaveLength(5)
    expect(outcomes.filter((outcome) => outcome.status === 'blocked')).toHaveLength(15)
    expect(
      database
        .prepare(
          'SELECT failure_count, blocked_until FROM admin_login_rate_limits WHERE key_hash = ?',
        )
        .get(input.keyHash),
    ).toEqual({ failure_count: 5, blocked_until: input.blockedUntil })
  })

  it('clears successful clients and resets expired windows', async () => {
    const { database, repository } = createFixture()
    const keyHash = 'c'.repeat(64)
    await repository.reserveAttempt({
      keyHash,
      now: '2026-07-14T00:00:00.000Z',
      resetBefore: '2026-07-13T23:45:00.000Z',
      blockedUntil: '2026-07-14T00:15:00.000Z',
      maximumAttempts: 5,
    })
    await repository.clear(keyHash)
    expect(
      database.prepare('SELECT key_hash FROM admin_login_rate_limits WHERE key_hash = ?').get(keyHash),
    ).toBeUndefined()

    for (let index = 0; index < 5; index += 1) {
      await repository.reserveAttempt({
        keyHash,
        now: '2026-07-14T00:00:00.000Z',
        resetBefore: '2026-07-13T23:45:00.000Z',
        blockedUntil: '2026-07-14T00:15:00.000Z',
        maximumAttempts: 5,
      })
    }
    await expect(
      repository.reserveAttempt({
        keyHash,
        now: '2026-07-14T00:15:00.000Z',
        resetBefore: '2026-07-14T00:00:00.000Z',
        blockedUntil: '2026-07-14T00:30:00.000Z',
        maximumAttempts: 5,
      }),
    ).resolves.toEqual({ status: 'reserved', attemptNumber: 1 })
  })

  it('opportunistically removes only expired sessions and stale rate limits', async () => {
    const { database, repository } = createFixture()
    const insertSession = database.prepare(
      'INSERT INTO admin_sessions (id, token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    insertSession.run(
      'expired-session',
      'd'.repeat(64),
      'credential-1',
      '2026-07-13T00:00:00.000Z',
      '2026-07-14T00:00:00.000Z',
    )
    insertSession.run(
      'active-session',
      'e'.repeat(64),
      'credential-1',
      '2026-07-14T00:00:00.000Z',
      '2026-07-14T08:00:00.000Z',
    )
    const insertRateLimit = database.prepare(
      'INSERT INTO admin_login_rate_limits (key_hash, window_started_at, failure_count, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    insertRateLimit.run(
      'f'.repeat(64),
      '2026-07-13T23:30:00.000Z',
      5,
      '2026-07-13T23:45:00.000Z',
      '2026-07-13T23:30:00.000Z',
    )
    insertRateLimit.run(
      '1'.repeat(64),
      '2026-07-14T00:05:00.000Z',
      1,
      null,
      '2026-07-14T00:05:00.000Z',
    )

    await repository.cleanupExpired({
      sessionsExpiredBefore: '2026-07-14T00:15:00.000Z',
      rateLimitsUpdatedBefore: '2026-07-14T00:00:00.000Z',
      rateLimitsUnblockedBefore: '2026-07-14T00:15:00.000Z',
    })

    expect(
      database.prepare('SELECT id FROM admin_sessions ORDER BY id').all(),
    ).toEqual([{ id: 'active-session' }])
    expect(
      database.prepare('SELECT key_hash FROM admin_login_rate_limits ORDER BY key_hash').all(),
    ).toEqual([{ key_hash: '1'.repeat(64) }])
  })
})
