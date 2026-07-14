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
  '../../migrations/0008_add_admin_operation_ledger.sql',
]
const policyMigrationPath = '../../migrations/0009_add_lesson_queue_policy_v2.sql'

const applyMigration = (database: DatabaseSync, path: string): void => {
  database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

const createLegacyDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const path of baseMigrationPaths) applyMigration(database, path)

  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Source', '2026-07-14T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, status, created_at, published_at
    ) VALUES (
      'version-1', 'source-1', 1, 'published',
      '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_sentence, created_at
    ) VALUES (
      'word-1', 'version-1', 1, 'hello', '你好', '', '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO learners (id, name, access_code, created_at)
    VALUES ('learner-1', 'Alice', 'CODE-1', '2026-07-14T00:00:00.000Z');
    INSERT INTO courses (
      id, learner_id, source_version_id, current_lesson_no, status, created_at
    ) VALUES (
      'course-1', 'learner-1', 'version-1', 1, 'active',
      '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO lesson_sessions (
      id, course_id, lesson_no, status, task_count, completed_task_count,
      correct_count, wrong_count, started_at
    ) VALUES (
      'session-1', 'course-1', 1, 'started', 1, 1, 0, 1,
      '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO lesson_tasks (
      id, session_id, course_id, word_id, stage, task_type, prompt_json,
      answer_json, order_index, status, role, required, created_at
    ) VALUES (
      'task-1', 'session-1', 'course-1', 'word-1', 'S0', 'recognize_meaning',
      '{}', '{}', 1, 'completed', 'primary', 0, '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO review_logs (
      id, session_id, task_id, course_id, word_id, stage, task_type,
      correct_answer, score, lesson_no, created_at
    ) VALUES (
      'review-1', 'session-1', 'task-1', 'course-1', 'word-1', 'S0',
      'recognize_meaning', 'known', 0, 1, '2026-07-14T00:00:00.000Z'
    );
  `)

  return database
}

const insertReviewCase = (
  database: DatabaseSync,
  input: {
    id: string
    lessonNo: number
    policy: 'v1_5_8_unbounded' | 'v2_3_6_cap3'
    score: number
    disposition: 'scheduled' | 'deferred_cap' | 'deferred_capacity' | null
  },
): void => {
  database
    .prepare(`
      INSERT INTO lesson_sessions (
        id, course_id, lesson_no, status, task_count, completed_task_count,
        correct_count, wrong_count, started_at, queue_policy_version
      ) VALUES (?, 'course-1', ?, 'started', 1, 1, 0, 0, ?, ?)
    `)
    .run(
      `session-${input.id}`,
      input.lessonNo,
      '2026-07-14T00:00:00.000Z',
      input.policy,
    )
  database
    .prepare(`
      INSERT INTO lesson_tasks (
        id, session_id, course_id, word_id, stage, task_type, prompt_json,
        answer_json, order_index, status, role, required, created_at
      ) VALUES (?, ?, 'course-1', 'word-1', 'S0', 'recognize_meaning',
        '{}', '{}', 1, 'completed', 'primary', 0, ?)
    `)
    .run(
      `task-${input.id}`,
      `session-${input.id}`,
      '2026-07-14T00:00:00.000Z',
    )
  database
    .prepare(`
      INSERT INTO review_logs (
        id, session_id, task_id, course_id, word_id, stage, task_type,
        correct_answer, score, lesson_no, created_at, queue_disposition
      ) VALUES (?, ?, ?, 'course-1', 'word-1', 'S0', 'recognize_meaning',
        'known', ?, ?, ?, ?)
    `)
    .run(
      `review-${input.id}`,
      `session-${input.id}`,
      `task-${input.id}`,
      input.score,
      input.lessonNo,
      '2026-07-14T00:00:00.000Z',
      input.disposition,
    )
}

describe('lesson queue policy migration', () => {
  it('backfills legacy sessions to v1 while preserving an unknown disposition', () => {
    const database = createLegacyDatabase()

    applyMigration(database, policyMigrationPath)

    expect(
      database
        .prepare(`
          SELECT queue_policy_version AS queuePolicyVersion
          FROM lesson_sessions
          WHERE id = 'session-1'
        `)
        .get(),
    ).toEqual({ queuePolicyVersion: 'v1_5_8_unbounded' })
    expect(
      database
        .prepare(`
          SELECT queue_disposition AS queueDisposition
          FROM review_logs
          WHERE id = 'review-1'
        `)
        .get(),
    ).toEqual({ queueDisposition: null })

    database.close()
  })

  it('keeps a persisted session queue policy immutable', () => {
    const database = createLegacyDatabase()
    applyMigration(database, policyMigrationPath)

    expect(() =>
      database
        .prepare(`
          UPDATE lesson_sessions
          SET queue_policy_version = 'v2_3_6_cap3'
          WHERE id = 'session-1'
        `)
        .run(),
    ).toThrow('lesson_session_queue_policy_immutable')

    expect(
      database
        .prepare(`
          SELECT queue_policy_version AS queuePolicyVersion
          FROM lesson_sessions
          WHERE id = 'session-1'
        `)
        .get(),
    ).toEqual({ queuePolicyVersion: 'v1_5_8_unbounded' })

    database.close()
  })

  it('accepts only dispositions that match the persisted session policy and score', () => {
    const database = createLegacyDatabase()
    applyMigration(database, policyMigrationPath)

    expect(() =>
      { insertReviewCase(database, {
        id: 'v1-wrong-scheduled',
        lessonNo: 2,
        policy: 'v1_5_8_unbounded',
        score: 0,
        disposition: 'scheduled',
      }); },
    ).toThrow('review_log_queue_policy_mismatch')
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-wrong-empty',
        lessonNo: 3,
        policy: 'v2_3_6_cap3',
        score: 1,
        disposition: null,
      }); },
    ).toThrow('review_log_queue_policy_mismatch')
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-correct-scheduled',
        lessonNo: 4,
        policy: 'v2_3_6_cap3',
        score: 2,
        disposition: 'scheduled',
      }); },
    ).toThrow('review_log_queue_policy_mismatch')

    expect(() =>
      { insertReviewCase(database, {
        id: 'v1-wrong-empty',
        lessonNo: 5,
        policy: 'v1_5_8_unbounded',
        score: 0,
        disposition: null,
      }); },
    ).not.toThrow()
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-wrong-scheduled',
        lessonNo: 6,
        policy: 'v2_3_6_cap3',
        score: 0,
        disposition: 'scheduled',
      }); },
    ).not.toThrow()
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-wrong-cap',
        lessonNo: 7,
        policy: 'v2_3_6_cap3',
        score: 1,
        disposition: 'deferred_cap',
      }); },
    ).not.toThrow()
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-wrong-capacity',
        lessonNo: 8,
        policy: 'v2_3_6_cap3',
        score: 0,
        disposition: 'deferred_capacity',
      }); },
    ).not.toThrow()
    expect(() =>
      { insertReviewCase(database, {
        id: 'v2-correct-empty',
        lessonNo: 9,
        policy: 'v2_3_6_cap3',
        score: 3,
        disposition: null,
      }); },
    ).not.toThrow()

    database.close()
  })

  it('does not allow an existing review outcome to violate its queue policy', () => {
    const database = createLegacyDatabase()
    applyMigration(database, policyMigrationPath)
    insertReviewCase(database, {
      id: 'v2-existing-wrong',
      lessonNo: 2,
      policy: 'v2_3_6_cap3',
      score: 0,
      disposition: 'scheduled',
    })

    expect(() =>
      database
        .prepare(`
          UPDATE review_logs
          SET queue_disposition = NULL
          WHERE id = 'review-v2-existing-wrong'
        `)
        .run(),
    ).toThrow()
    expect(() =>
      database
        .prepare(`
          UPDATE review_logs
          SET score = 3
          WHERE id = 'review-v2-existing-wrong'
        `)
        .run(),
    ).toThrow('review_log_queue_policy_mismatch')

    database.close()
  })

  it('keeps the winning queue disposition immutable after it is recorded', () => {
    const database = createLegacyDatabase()
    applyMigration(database, policyMigrationPath)
    insertReviewCase(database, {
      id: 'v2-immutable-outcome',
      lessonNo: 2,
      policy: 'v2_3_6_cap3',
      score: 0,
      disposition: 'scheduled',
    })

    expect(() =>
      database
        .prepare(`
          UPDATE review_logs
          SET queue_disposition = 'deferred_cap'
          WHERE id = 'review-v2-immutable-outcome'
        `)
        .run(),
    ).toThrow('review_log_queue_disposition_immutable')
    expect(
      database
        .prepare(`
          SELECT queue_disposition AS queueDisposition
          FROM review_logs
          WHERE id = 'review-v2-immutable-outcome'
        `)
        .get(),
    ).toEqual({ queueDisposition: 'scheduled' })

    database.close()
  })
})
