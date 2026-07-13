import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const baseMigrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
  '../../migrations/0005_content_version_cas.sql',
  '../../migrations/0006_add_lesson_task_queue.sql',
  '../../migrations/0007_backfill_legacy_lesson_runtime.sql',
]
const operationMigrationPath = '../../migrations/0008_add_admin_operation_ledger.sql'

const applyMigration = (database: DatabaseSync, path: string): void => {
  database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

const createLegacyDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of baseMigrationPaths) applyMigration(database, path)
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-legacy', 'Legacy source', '2026-07-13T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-legacy', 'source-legacy', 1, 'published',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-legacy', 'Alice', 'LEGACY-CODE', '2026-07-13T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-legacy', 'learner-legacy', 'version-legacy', 1, 'active',
      '2026-07-13T00:00:00.000Z'
    );
  `)

  return database
}

describe('admin operation ledger migration', () => {
  it('adds an operation-hash-only ledger without rewriting legacy data', () => {
    const database = createLegacyDatabase()

    applyMigration(database, operationMigrationPath)

    expect(
      database
        .prepare('SELECT id, credential_version FROM learners WHERE id = ?')
        .get('learner-legacy'),
    ).toEqual({ id: 'learner-legacy', credential_version: 1 })
    expect(
      database
        .prepare('SELECT id FROM courses WHERE id = ?')
        .get('course-legacy'),
    ).toEqual({ id: 'course-legacy' })

    const ledgerColumns = database
      .prepare('PRAGMA table_info(admin_operations)')
      .all() as Array<{ name: string }>
    expect(ledgerColumns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['raw_operation_token', 'operation_token', 'access_code']),
    )

    database.close()
  })

  it('accepts only complete typed outcomes and enforces one row per operation hash', () => {
    const database = createLegacyDatabase()
    applyMigration(database, operationMigrationPath)
    const insert = database.prepare(`
      INSERT INTO admin_operations (
        operation_hash, kind, target_id, request_fingerprint,
        outcome_source_id, outcome_source_version_id,
        outcome_learner_id, outcome_course_id,
        outcome_credential_version, revoked_session_count, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)
    `)

    insert.run(
      `sha256:${'a'.repeat(64)}`,
      'create_course',
      'version-legacy',
      `sha256:${'b'.repeat(64)}`,
      'learner-legacy',
      'course-legacy',
      1,
      '2026-07-13T00:00:00.000Z',
    )

    expect(() =>
      insert.run(
        `sha256:${'a'.repeat(64)}`,
        'create_course',
        'version-legacy',
        `sha256:${'b'.repeat(64)}`,
        'learner-legacy',
        'course-legacy',
        1,
        '2026-07-13T00:00:00.000Z',
      ),
    ).toThrow()
    expect(() =>
      database
        .prepare(`
          INSERT INTO admin_operations (
            operation_hash, kind, target_id, request_fingerprint,
            outcome_source_id, outcome_source_version_id,
            outcome_learner_id, outcome_course_id,
            outcome_credential_version, revoked_session_count, created_at
          ) VALUES (?, 'rotate_access_code', ?, ?, NULL, NULL, ?, NULL, 2, NULL, ?)
        `)
        .run(
          `sha256:${'c'.repeat(64)}`,
          'learner-legacy',
          `sha256:${'d'.repeat(64)}`,
          'learner-legacy',
          '2026-07-13T00:00:00.000Z',
        ),
    ).toThrow()

    database.close()
  })
})
