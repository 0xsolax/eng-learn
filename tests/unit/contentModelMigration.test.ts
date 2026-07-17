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
  '../../migrations/0009_add_lesson_queue_policy_v2.sql',
  '../../migrations/0010_add_admin_sessions.sql',
]
const contentModelMigrationPath = '../../migrations/0011_add_progressive_context_model.sql'

const applyMigration = (database: DatabaseSync, path: string): void => {
  database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

describe('progressive context content model migration', () => {
  it('keeps historical versions on v1 and adds lossless v2 context storage', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const path of baseMigrationPaths) applyMigration(database, path)

    database.exec(`
      INSERT INTO word_sources (id, name, created_at)
      VALUES ('source-legacy', 'Legacy', '2026-07-01T00:00:00.000Z');
      INSERT INTO source_versions (
        id, source_id, version_no, status, created_at, published_at
      ) VALUES (
        'version-legacy', 'source-legacy', 1, 'published',
        '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z'
      );
      INSERT INTO words (
        id, source_version_id, order_index, word, meaning, example_sentence, created_at
      ) VALUES (
        'word-legacy', 'version-legacy', 1, 'apple', '苹果',
        'I eat an apple.', '2026-07-01T00:00:00.000Z'
      );
    `)

    applyMigration(database, contentModelMigrationPath)

    expect(
      database
        .prepare(`
          SELECT content_model AS contentModel
          FROM source_versions
          WHERE id = 'version-legacy'
        `)
        .get(),
    ).toEqual({ contentModel: 'v1_single_sentence' })
    expect(
      database
        .prepare(`
          SELECT
            example_phrase AS examplePhrase,
            example_sentence AS exampleSentence,
            example_sentence_extended AS exampleSentenceExtended
          FROM words
          WHERE id = 'word-legacy'
        `)
        .get(),
    ).toEqual({
      examplePhrase: '',
      exampleSentence: 'I eat an apple.',
      exampleSentenceExtended: '',
    })

    database.exec(`
      INSERT INTO source_versions (
        id, source_id, version_no, content_revision, content_model, status, created_at
      ) VALUES (
        'version-progressive', 'source-legacy', 2, 0, 'v2_progressive_context',
        'archived', '2026-07-17T00:00:00.000Z'
      );
      INSERT INTO words (
        id, source_version_id, order_index, word, meaning, example_phrase,
        example_sentence, example_sentence_extended, created_at
      ) VALUES (
        'word-progressive', 'version-progressive', 1, 'pear', '梨', 'A pear',
        'I eat a pear', 'I eat a pear every day', '2026-07-17T00:00:00.000Z'
      );
    `)

    expect(
      database
        .prepare(`
          SELECT example_phrase AS examplePhrase,
            example_sentence AS exampleSentence,
            example_sentence_extended AS exampleSentenceExtended
          FROM words
          WHERE id = 'word-progressive'
        `)
        .get(),
    ).toEqual({
      examplePhrase: 'A pear',
      exampleSentence: 'I eat a pear',
      exampleSentenceExtended: 'I eat a pear every day',
    })
    expect(() => {
      database.exec(`
        INSERT INTO source_versions (
          id, source_id, version_no, content_revision, content_model, status, created_at
        ) VALUES (
          'version-invalid', 'source-legacy', 3, 0, 'unknown',
          'archived', '2026-07-17T00:00:00.000Z'
        );
      `)
    }).toThrow()
    expect(() => {
      database.exec(`
        UPDATE source_versions
        SET content_model = 'v1_single_sentence'
        WHERE id = 'version-progressive';
      `)
    }).toThrow(/source_version_content_model_immutable/u)
  })
})
