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
  '../../migrations/0011_add_progressive_context_model.sql',
]
const reviewMigrationPath = '../../migrations/0012_add_exercise_review_feedback.sql'

const applyMigration = (database: DatabaseSync, path: string): void => {
  database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of migrationPaths) applyMigration(database, path)
  database.exec(`
    INSERT INTO word_sources (id, name, created_at)
    VALUES ('source-1', 'Review source', '2026-07-17T00:00:00.000Z');
    INSERT INTO source_versions (
      id, source_id, version_no, content_revision, content_model, status, created_at
    ) VALUES (
      'version-1', 'source-1', 1, 4, 'v2_progressive_context', 'draft',
      '2026-07-17T00:00:00.000Z'
    );
    INSERT INTO words (
      id, source_version_id, order_index, word, meaning, example_phrase,
      example_sentence, example_sentence_extended, created_at
    ) VALUES (
      'word-1', 'version-1', 1, 'apple', '苹果', 'an apple',
      'I eat an apple.', 'I eat an apple every day.', '2026-07-17T00:00:00.000Z'
    );
    INSERT INTO exercise_packs (id, source_version_id, word_id, status, created_at)
    VALUES ('pack-1', 'version-1', 'word-1', 'draft', '2026-07-17T00:00:00.000Z');
    INSERT INTO exercise_items (
      id, source_version_id, word_id, stage, task_type,
      prompt_json, answer_json, status, created_at
    ) VALUES (
      'item-1', 'version-1', 'word-1', 'S2', 'recall_word',
      '{"meaning":"苹果"}', '{"word":"apple"}', 'draft',
      '2026-07-17T00:00:00.000Z'
    );
  `)

  return database
}

describe('exercise review feedback migration', () => {
  it('is additive and leaves every existing exercise field and revision unchanged', () => {
    const database = createDatabase()
    const before = database.prepare('SELECT * FROM exercise_items WHERE id = ?').get('item-1')

    applyMigration(database, reviewMigrationPath)

    expect(database.prepare('SELECT * FROM exercise_items WHERE id = ?').get('item-1')).toEqual(before)
    expect(
      database.prepare('SELECT content_revision FROM source_versions WHERE id = ?').get('version-1'),
    ).toEqual({ content_revision: 4 })
    expect(database.prepare('SELECT * FROM exercise_item_review_feedback').all()).toEqual([])
  })

  it('enforces feedback length, ownership, draft state, and status compatibility', () => {
    const database = createDatabase()
    applyMigration(database, reviewMigrationPath)
    const insert = database.prepare(`
      INSERT INTO exercise_item_review_feedback (
        exercise_item_id, feedback_text, requested_at
      ) VALUES (?, ?, ?)
    `)

    expect(() => insert.run('item-1', '   ', '2026-07-17T00:00:00.000Z')).toThrow()
    expect(() => insert.run('item-1', 'x'.repeat(2_001), '2026-07-17T00:00:00.000Z')).toThrow()
    expect(() => insert.run('missing-item', '问题', '2026-07-17T00:00:00.000Z')).toThrow()

    insert.run('item-1', '例句与词义不匹配', '2026-07-17T00:00:00.000Z')
    expect(() => {
      database.exec("UPDATE exercise_items SET status = 'approved' WHERE id = 'item-1'")
    }).toThrow(/exercise_item_review_feedback_open/u)
    expect(() => {
      database.exec("UPDATE exercise_items SET status = 'disabled' WHERE id = 'item-1'")
    }).toThrow(/exercise_item_review_feedback_open/u)

    database.exec("DELETE FROM exercise_item_review_feedback WHERE exercise_item_id = 'item-1'")
    database.exec("UPDATE exercise_items SET status = 'approved' WHERE id = 'item-1'")
    expect(() => insert.run('item-1', '问题', '2026-07-17T00:00:00.000Z')).toThrow(
      /exercise_item_review_feedback_requires_draft/u,
    )
  })

  it('clears feedback only when prompt or answer actually changes', () => {
    const database = createDatabase()
    applyMigration(database, reviewMigrationPath)
    database.exec(`
      INSERT INTO exercise_item_review_feedback (
        exercise_item_id, feedback_text, requested_at
      ) VALUES ('item-1', '需要更正', '2026-07-17T00:00:00.000Z');
    `)

    database.exec("UPDATE exercise_items SET prompt_json = prompt_json WHERE id = 'item-1'")
    expect(
      database.prepare('SELECT feedback_text FROM exercise_item_review_feedback').get(),
    ).toEqual({ feedback_text: '需要更正' })

    database.exec(`
      UPDATE exercise_items
      SET prompt_json = '{"meaning":"一种水果"}'
      WHERE id = 'item-1'
    `)
    expect(database.prepare('SELECT * FROM exercise_item_review_feedback').all()).toEqual([])
  })
})
