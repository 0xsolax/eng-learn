import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MIGRATION = '0015_add_learner_account_login.sql'
const PIN_HASH = `pbkdf2-sha256:100000:${'a'.repeat(32)}:${'b'.repeat(64)}`
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

describe('migration 0015 learner account login', () => {
  it('upgrades 0014 data without changing learning history and matches a clean schema', () => {
    const database = createDatabaseThrough('0013_add_lesson_flow_policy_v2.sql')
    seedLearningHistory(database)
    database.exec(readMigration('0014_add_lesson_replay_and_learning_runs.sql'))
    const beforeMigration = snapshotLearningHistory(database)

    database.exec(readMigration(MIGRATION))

    expect(
      database.prepare(
        'SELECT id, login_account, login_pin_hash, legacy_access_enabled, credential_version FROM learners',
      ).get(),
    ).toEqual({
      id: 'learner-1',
      login_account: null,
      login_pin_hash: null,
      legacy_access_enabled: 1,
      credential_version: 1,
    })
    expect(snapshotLearningHistory(database)).toEqual(beforeMigration)

    const cleanDatabase = createDatabaseThrough(MIGRATION)
    expect(snapshotSchema(database)).toEqual(snapshotSchema(cleanDatabase))
    cleanDatabase.close()

    database.close()
  })

  it('enforces paired normalized credentials, legacy shutdown, and account uniqueness', () => {
    const database = createDatabaseThrough(MIGRATION)

    database.prepare(
      'INSERT INTO learners (id, name, access_code, created_at) VALUES (?, ?, ?, ?)',
    ).run('learner-1', 'Alice', 'code-1', '2026-07-21T00:00:00.000Z')
    expect(() =>
      database.prepare(
        "UPDATE learners SET login_account = 'alice01' WHERE id = 'learner-1'",
      ).run(),
    ).toThrow(/learner_login_credential_invalid/u)
    expect(() =>
      database.prepare(
        "UPDATE learners SET login_account = 'Alice01', login_pin_hash = ?, legacy_access_enabled = 0 WHERE id = 'learner-1'",
      ).run(PIN_HASH),
    ).toThrow(/learner_login_credential_invalid/u)
    expect(() =>
      database.prepare(
        "UPDATE learners SET login_account = 'alice01', login_pin_hash = ?, legacy_access_enabled = 1 WHERE id = 'learner-1'",
      ).run(PIN_HASH),
    ).toThrow(/learner_login_credential_invalid/u)

    database.prepare(
      "UPDATE learners SET login_account = 'alice01', login_pin_hash = ?, legacy_access_enabled = 0 WHERE id = 'learner-1'",
    ).run(PIN_HASH)
    expect(() =>
      database.prepare(
        'INSERT INTO learners (id, name, access_code, login_account, login_pin_hash, legacy_access_enabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      ).run(
        'learner-2',
        'Bob',
        'code-2',
        'alice01',
        PIN_HASH,
        '2026-07-21T00:00:00.000Z',
      ),
    ).toThrow(/UNIQUE/u)

    database.close()
  })

  it('keeps credential operations immutable and prevents token reuse across all ledgers', () => {
    const database = createDatabaseThrough(MIGRATION)
    database.prepare(
      'INSERT INTO learners (id, name, access_code, created_at) VALUES (?, ?, ?, ?)',
    ).run('learner-1', 'Alice', 'code-1', '2026-07-21T00:00:00.000Z')
    insertLoginOperation(database, HASH_A)

    expect(() =>
      database.prepare(
        "INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) VALUES (?, 'create_course', 'course-1', ?, NULL, NULL, 'learner-1', 'course-1', 1, NULL, ?)",
      ).run(HASH_A, HASH_B, '2026-07-21T00:00:00.000Z'),
    ).toThrow(/learner_login_operation_hash_reused/u)
    expect(() =>
      database.prepare(
        "UPDATE learner_login_credential_operations SET outcome_login_account = 'other01' WHERE operation_hash = ?",
      ).run(HASH_A),
    ).toThrow(/learner_login_credential_operation_immutable/u)
    expect(() =>
      database.prepare(
        'DELETE FROM learner_login_credential_operations WHERE operation_hash = ?',
      ).run(HASH_A),
    ).toThrow(/learner_login_credential_operation_immutable/u)

    database.close()

    const reverseDatabase = createDatabaseThrough(MIGRATION)
    reverseDatabase.prepare(
      'INSERT INTO learners (id, name, access_code, created_at) VALUES (?, ?, ?, ?)',
    ).run('learner-1', 'Alice', 'code-1', '2026-07-21T00:00:00.000Z')
    reverseDatabase.prepare(
      "INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) VALUES (?, 'create_course', 'course-1', ?, NULL, NULL, 'learner-1', 'course-1', 1, NULL, ?)",
    ).run(HASH_B, HASH_A, '2026-07-21T00:00:00.000Z')
    expect(() => {
      insertLoginOperation(reverseDatabase, HASH_B)
    }).toThrow(/learner_login_operation_hash_reused/u)

    reverseDatabase.close()
  })
})

const createDatabaseThrough = (lastMigration: string): DatabaseSync => {
  const database = new DatabaseSync(':memory:')

  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readMigration(migration))
    if (migration === lastMigration) return database
  }

  throw new Error(`Migration ${lastMigration} is missing`)
}

const readMigration = (name: string): string =>
  readFileSync(`migrations/${name}`, 'utf8')

const seedLearningHistory = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-21T00:00:00.000Z');
    INSERT INTO source_versions (id, source_id, version_no, status, created_at, published_at)
    VALUES ('version-1', 'source-1', 1, 'published', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z');
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'code-1', '2026-07-21T00:00:00.000Z');
    INSERT INTO courses (id, learner_id, source_version_id, current_lesson_no, status, created_at)
    VALUES ('course-1', 'learner-1', 'version-1', 2, 'active', '2026-07-21T00:00:00.000Z');
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence,
      part_of_speech, created_at, example_phrase, example_sentence_extended
    ) VALUES (
      'word-1', 'version-1', 1, 'apple', '苹果', 'This is an apple.',
      'noun', '2026-07-21T00:00:00.000Z', 'an apple', 'I eat an apple every day.'
    );
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES ('group-1', 'version-1', 1, 1, 1, '2026-07-21T00:00:00.000Z');
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, completed_task_count,
      correct_count, wrong_count, started_at, completed_at,
      queue_policy_version, flow_policy_version
    ) VALUES (
      'session-1', 'course-1', 1, 'completed', 1, 1,
      1, 0, '2026-07-21T01:00:00.000Z', '2026-07-21T01:05:00.000Z',
      'v1_5_8_unbounded', 'v1_due_then_new_unbounded'
    );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type,
      prompt_json, answer_json, order_index, status, created_at,
      role, required, reflux_source_task_id, draft_answer,
      reference_revealed_at, reinforcement_source_task_id
    ) VALUES (
      'task-1', 'session-1', 'course-1', 'word-1', 'S0', 'choice',
      '{"question":"apple"}', '{"answer":"苹果"}', 1, 'completed',
      '2026-07-21T01:00:00.000Z', 'primary', 1, NULL, NULL, NULL, NULL
    );
    INSERT INTO review_logs (
      id, session_id, course_id, word_id, stage, task_type,
      user_answer, correct_answer, score, response_time_ms, error_type,
      lesson_no, created_at, task_id, queue_disposition, queue_capacity_reason
    ) VALUES (
      'log-1', 'session-1', 'course-1', 'word-1', 'S0', 'choice',
      '苹果', '苹果', 3, 1200, NULL, 1,
      '2026-07-21T01:01:00.000Z', 'task-1', NULL, NULL
    );
    INSERT INTO user_word_states (
      id, course_id, word_id, group_id, stage, stage_attempt_count,
      stage_correct_count, total_attempt_count, total_correct_count,
      total_wrong_count, current_streak, wrong_streak, lapse_count,
      ease_factor, mastery_score, first_lesson_no, last_seen_lesson_no,
      next_due_lesson_no, status, created_at, updated_at
    ) VALUES (
      'state-1', 'course-1', 'word-1', 'group-1', 'S1', 1,
      1, 1, 1, 0, 1, 0, 0, 1.1, 20, 1, 1, 2, 'learning',
      '2026-07-21T01:00:00.000Z', '2026-07-21T01:01:00.000Z'
    );
  `)
}

const snapshotLearningHistory = (database: DatabaseSync) => ({
  learners: database
    .prepare(
      'SELECT id, name, access_code, created_at, credential_version FROM learners ORDER BY id',
    )
    .all(),
  courses: database.prepare('SELECT * FROM courses ORDER BY id').all(),
  sessions: database.prepare('SELECT * FROM lesson_sessions ORDER BY id').all(),
  tasks: database.prepare('SELECT * FROM lesson_tasks ORDER BY id').all(),
  reviewLogs: database.prepare('SELECT * FROM review_logs ORDER BY id').all(),
  wordStates: database.prepare('SELECT * FROM user_word_states ORDER BY id').all(),
  learningRuns: database
    .prepare('SELECT * FROM course_learning_runs ORDER BY course_id, run_no')
    .all(),
  reportTotals: database
    .prepare(
      'SELECT COUNT(*) AS answer_count, SUM(score) AS score_total FROM review_logs WHERE course_id = ?',
    )
    .get('course-1'),
})

const snapshotSchema = (database: DatabaseSync) =>
  database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()

const insertLoginOperation = (database: DatabaseSync, operationHash: string): void => {
  database.prepare(
    'INSERT INTO learner_login_credential_operations (operation_hash, learner_id, request_fingerprint, outcome_login_account, outcome_credential_version, revoked_session_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    operationHash,
    'learner-1',
    HASH_B,
    'alice01',
    2,
    0,
    '2026-07-21T00:00:00.000Z',
  )
}
