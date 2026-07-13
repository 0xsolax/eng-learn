import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const migrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
]

const createMigratedDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const migrationPath of migrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }

  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-13T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES
      ('learner-a', 'Alice', 'CODE-A', '2026-07-13T00:00:00.000Z'),
      ('learner-b', 'Bob', 'CODE-B', '2026-07-13T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES
      ('course-a', 'learner-a', 'version-1', 1, 'active', '2026-07-13T00:00:00.000Z'),
      ('course-b', 'learner-b', 'version-1', 1, 'active', '2026-07-13T00:00:00.000Z');
  `)

  return database
}

describe('learner session hardening migration', () => {
  it('rejects cross-learner course ownership on session insert and update', () => {
    const database = createMigratedDatabase()
    const insert = database.prepare(`
      INSERT INTO learner_sessions (
        id, token_hash, learner_id, course_id, created_at, expires_at, revoked_at,
        credential_version
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `)

    expect(() =>
      insert.run(
        'session-cross',
        'sha256:cross',
        'learner-a',
        'course-b',
        '2026-07-13T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z',
        1,
      ),
    ).toThrow()

    insert.run(
      'session-valid',
      'sha256:valid',
      'learner-a',
      'course-a',
      '2026-07-13T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z',
      1,
    )

    expect(() =>
      database
        .prepare('UPDATE learner_sessions SET course_id = ? WHERE id = ?')
        .run('course-b', 'session-valid'),
    ).toThrow()

    database.close()
  })

  it('rejects session credential versions that do not match the learner', () => {
    const database = createMigratedDatabase()
    const insert = database.prepare(`
      INSERT INTO learner_sessions (
        id, token_hash, learner_id, course_id, created_at, expires_at, revoked_at,
        credential_version
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `)

    expect(() =>
      insert.run(
        'session-stale',
        'sha256:stale',
        'learner-a',
        'course-a',
        '2026-07-13T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z',
        2,
      ),
    ).toThrow()

    insert.run(
      'session-valid',
      'sha256:valid-version',
      'learner-a',
      'course-a',
      '2026-07-13T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z',
      1,
    )

    expect(() =>
      database
        .prepare('UPDATE learner_sessions SET credential_version = ? WHERE id = ?')
        .run(2, 'session-valid'),
    ).toThrow()

    database.close()
  })
})
