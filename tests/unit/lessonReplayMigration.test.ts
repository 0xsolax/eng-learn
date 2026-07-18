import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

describe('migration 0014 lesson replay and learning runs', () => {
  it('backfills existing runtime rows into learning run one without changing physical lessons', () => {
    const database = createDatabaseThrough('0013_add_lesson_flow_policy_v2.sql')
    seedCourse(database)

    database.exec(readMigration('0014_add_lesson_replay_and_learning_runs.sql'))

    expect(
      database.prepare(
        'SELECT current_lesson_no, current_learning_run_no, current_run_start_lesson_no FROM courses WHERE id = ?',
      ).get('course-1'),
    ).toEqual({
      current_lesson_no: 3,
      current_learning_run_no: 1,
      current_run_start_lesson_no: 1,
    })
    expect(
      database.prepare(
        'SELECT lesson_no, learning_run_no, run_lesson_no FROM lesson_sessions WHERE id = ?',
      ).get('session-completed'),
    ).toEqual({ lesson_no: 1, learning_run_no: 1, run_lesson_no: 1 })
    expect(
      database.prepare(
        'SELECT run_no, start_lesson_no, status FROM course_learning_runs WHERE course_id = ?',
      ).get('course-1'),
    ).toEqual({ run_no: 1, start_lesson_no: 1, status: 'active' })
    expect(
      database.prepare(
        'SELECT learning_run_no FROM user_word_states WHERE id = ?',
      ).get('state-1'),
    ).toEqual({ learning_run_no: 1 })

    database.close()
  })

  it('allows one started replay only for a completed source lesson and rejects answer leakage fields', () => {
    const database = createDatabaseThrough('0014_add_lesson_replay_and_learning_runs.sql')
    seedCourse(database)

    insertReplay(database, 'replay-1', 'session-completed')
    expect(() => {
      insertReplay(database, 'replay-2', 'session-completed')
    }).toThrow(
      /lesson_replay_started_conflict|UNIQUE/u,
    )
    expect(() => {
      insertReplay(database, 'replay-3', 'session-started')
    }).toThrow(
      /lesson_replay_source_mismatch/u,
    )
    expect(() =>
      database.prepare(
        "INSERT INTO lesson_replay_task_states (id, replay_session_id, source_task_id, order_index, status, submission_json, score, draft_answer, reference_revealed_at, answered_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
      ).run(
        'replay-task-invalid',
        'replay-1',
        'task-completed',
        1,
        JSON.stringify({ answer: 'leak' }),
        3,
        'old draft',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      ),
    ).toThrow(/lesson_replay_task_initial_state_mismatch/u)

    database.close()
  })

  it('guards reset CAS and prevents operation-token hash reuse across ledgers', () => {
    const database = createDatabaseThrough('0014_add_lesson_replay_and_learning_runs.sql')
    seedCourse(database)

    expect(() => {
      insertResetOperation(database, {
        operationHash: HASH_A,
        expectedCurrentLessonNo: 2,
      })
    }).toThrow(/course_progress_reset_conflict/u)

    insertResetOperation(database, {
      operationHash: HASH_A,
      expectedCurrentLessonNo: 3,
    })
    expect(() =>
      database.prepare(
        "INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) VALUES (?, 'create_course', 'course-other', ?, NULL, NULL, 'learner-other', 'course-other', 1, NULL, ?)",
      ).run(HASH_A, HASH_B, '2026-07-18T00:00:00.000Z'),
    ).toThrow(/admin_operation_hash_reused_by_progress_reset/u)

    database.close()

    const reverseDatabase = createDatabaseThrough(
      '0014_add_lesson_replay_and_learning_runs.sql',
    )
    seedCourse(reverseDatabase)
    reverseDatabase.prepare(
      "INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) VALUES (?, 'create_course', 'course-other', ?, NULL, NULL, 'learner-other', 'course-other', 1, NULL, ?)",
    ).run(HASH_B, HASH_A, '2026-07-18T00:00:00.000Z')
    expect(() => {
      insertResetOperation(reverseDatabase, {
        operationHash: HASH_B,
        expectedCurrentLessonNo: 3,
      })
    }).toThrow(/course_progress_reset_hash_reused/u)

    reverseDatabase.close()
  })

  it('keeps completed formal lesson snapshots and review logs immutable', () => {
    const database = createDatabaseThrough('0014_add_lesson_replay_and_learning_runs.sql')
    seedCourse(database)

    expect(() =>
      database.prepare(
        "UPDATE lesson_sessions SET correct_count = 0 WHERE id = 'session-completed'",
      ).run(),
    ).toThrow(/lesson_session_final_state_immutable/u)
    expect(() =>
      database.prepare(
        "UPDATE lesson_tasks SET prompt_json = '{}' WHERE id = 'task-completed'",
      ).run(),
    ).toThrow(/lesson_task_snapshot_identity_immutable/u)
    expect(() =>
      database.prepare(
        "UPDATE review_logs SET user_answer = 'changed' WHERE id = 'review-completed'",
      ).run(),
    ).toThrow(/review_log_immutable/u)
    expect(() =>
      database.prepare("DELETE FROM lesson_sessions WHERE id = 'session-completed'").run(),
    ).toThrow(/lesson_session_immutable/u)
    expect(() =>
      database.prepare("DELETE FROM lesson_tasks WHERE id = 'task-completed'").run(),
    ).toThrow(/lesson_task_immutable/u)
    expect(() =>
      database.prepare("DELETE FROM review_logs WHERE id = 'review-completed'").run(),
    ).toThrow(/review_log_immutable/u)

    database.close()
  })
})

const createDatabaseThrough = (lastMigration: string): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  const migrations = readdirSync('migrations').sort()

  for (const migration of migrations) {
    database.exec(readMigration(migration))
    if (migration === lastMigration) return database
  }

  throw new Error(`Migration ${lastMigration} is missing`)
}

const readMigration = (name: string): string =>
  readFileSync(`migrations/${name}`, 'utf8')

const seedCourse = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-18T00:00:00.000Z');
    INSERT INTO source_versions (id, source_id, version_no, status, created_at, published_at)
    VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence,
      part_of_speech, example_phrase, example_sentence_extended, created_at
    ) VALUES (
      'word-1', 'version-1', 1, 'apple', '苹果', 'I eat an apple.',
      'noun', 'an apple', 'I eat an apple every day.', '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES (
      'group-1', 'version-1', 1, 1, 1, '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'CODE000001', '2026-07-18T00:00:00.000Z');
    INSERT INTO courses (id, learner_id, source_version_id, current_lesson_no, status, created_at)
    VALUES ('course-1', 'learner-1', 'version-1', 3, 'active', '2026-07-18T00:00:00.000Z');
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, completed_task_count,
      correct_count, wrong_count, queue_policy_version, flow_policy_version,
      started_at, completed_at
    ) VALUES (
      'session-completed', 'course-1', 1, 'started', 1, 0, 0, 0,
      'v2_3_6_cap3', 'v1_due_then_new_unbounded',
      '2026-07-18T00:00:00.000Z', NULL
    );
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, completed_task_count,
      correct_count, wrong_count, queue_policy_version, flow_policy_version,
      started_at
    ) VALUES (
      'session-started', 'course-1', 3, 'started', 1, 0, 0, 0,
      'v2_3_6_cap3', 'v1_due_then_new_unbounded',
      '2026-07-18T00:20:00.000Z'
    );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      'task-completed', 'session-completed', 'course-1', 'word-1', 'S0',
      'recognize_meaning', '{"word":"apple","meaning":"苹果","exampleSentence":"apple"}',
      '{"word":"apple","expectedResponse":"known"}', 1, 'completed', 'primary', 1,
      '2026-07-18T00:00:00.000Z'
    );
    INSERT INTO review_logs (
      id, session_id, task_id, course_id, word_id, stage, task_type,
      user_answer, correct_answer, score, lesson_no, created_at,
      queue_disposition
    ) VALUES (
      'review-completed', 'session-completed', 'task-completed', 'course-1',
      'word-1', 'S0', 'recognize_meaning', 'known', 'known', 3, 1,
      '2026-07-18T00:05:00.000Z', NULL
    );
    UPDATE lesson_sessions
    SET
      status = 'completed',
      completed_task_count = 1,
      correct_count = 1,
      completed_at = '2026-07-18T00:10:00.000Z'
    WHERE id = 'session-completed';
    INSERT INTO user_word_states (
      id, course_id, word_id, group_id, stage, stage_attempt_count,
      stage_correct_count, total_attempt_count, total_correct_count,
      total_wrong_count, current_streak, wrong_streak, lapse_count,
      ease_factor, mastery_score, first_lesson_no, last_seen_lesson_no,
      next_due_lesson_no, status, created_at, updated_at
    ) VALUES (
      'state-1', 'course-1', 'word-1', 'group-1', 'S1', 1, 1, 1, 1, 0,
      1, 0, 0, 1.0, 10, 1, 1, 3, 'learning',
      '2026-07-18T00:00:00.000Z', '2026-07-18T00:10:00.000Z'
    );
  `)
}

const insertReplay = (
  database: DatabaseSync,
  replayId: string,
  sourceSessionId: string,
): void => {
  database.prepare(
    "INSERT INTO lesson_replay_sessions (id, course_id, source_session_id, source_learning_run_no, source_run_lesson_no, status, task_count, completed_task_count, correct_count, wrong_count, started_at) VALUES (?, 'course-1', ?, 1, 1, 'started', 1, 0, 0, 0, '2026-07-18T01:00:00.000Z')",
  ).run(replayId, sourceSessionId)
}

const insertResetOperation = (
  database: DatabaseSync,
  input: { operationHash: string; expectedCurrentLessonNo: number },
): void => {
  database.prepare(
    `INSERT INTO course_progress_reset_operations (
      operation_hash, course_id, request_fingerprint, from_learning_run_no,
      expected_current_run_lesson_no, from_physical_lesson_no,
      to_learning_run_no, to_physical_lesson_no, abandoned_session_count,
      actor_source, actor_subject, created_at
    ) VALUES (?, 'course-1', ?, 1, ?, 3, 2, 4, 1, 'service_token', 'admin-1', ?)`,
  ).run(
    input.operationHash,
    HASH_B,
    input.expectedCurrentLessonNo,
    '2026-07-18T01:00:00.000Z',
  )
}
