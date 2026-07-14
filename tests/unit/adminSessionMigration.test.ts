import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
  '../../migrations/0005_content_version_cas.sql',
  '../../migrations/0006_add_lesson_task_queue.sql',
  '../../migrations/0007_backfill_legacy_lesson_runtime.sql',
  '../../migrations/0008_add_admin_operation_ledger.sql',
  '../../migrations/0009_add_lesson_queue_policy_v2.sql',
  '../../migrations/0010_add_admin_sessions.sql',
]

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of migrationPaths) {
    database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
  }
  return database
}

describe('admin session migration', () => {
  it('adds hashed sessions and persistent login-rate state without destructive changes', () => {
    const database = createDatabase()
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_sessions', 'admin_login_rate_limits') ORDER BY name",
      )
      .all()
      .map((row) => row.name)

    expect(tables).toEqual(['admin_login_rate_limits', 'admin_sessions'])
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'courses'").get(),
    ).toBeTruthy()
  })

  it('never accepts duplicate token hashes or raw-token shaped rate keys', () => {
    const database = createDatabase()
    const values = [
      'session-1',
      'a'.repeat(64),
      'credential-1',
      '2026-07-14T00:00:00.000Z',
      '2026-07-14T08:00:00.000Z',
    ] as const

    database
      .prepare(
        'INSERT INTO admin_sessions (id, token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(...values)
    expect(() =>
      database
        .prepare(
          'INSERT INTO admin_sessions (id, token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('session-2', values[1], values[2], values[3], values[4]),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          'INSERT INTO admin_login_rate_limits (key_hash, window_started_at, failure_count, blocked_until, updated_at) VALUES (?, ?, ?, NULL, ?)',
        )
        .run('raw-client-ip', values[3], 1, values[3]),
    ).toThrow()
  })
})
