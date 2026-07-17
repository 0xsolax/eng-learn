import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const NOW = '2026-07-17T00:00:00.000Z'
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
  '../../migrations/0012_add_exercise_review_feedback.sql',
]

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  execute(): { success: true; meta: { changes: number } }
}

const createSqliteD1 = (database: DatabaseSync) => {
  let failNextBatchAt: number | undefined
  let preparedSql: string[] = []

  const prepare = (sql: string): SqliteD1Statement => {
    let bindings: SQLInputValue[] = []
    const statement = database.prepare(sql)
    preparedSql.push(sql)
    const adapter: SqliteD1Statement = {
      bind(...values) {
        bindings = values as SQLInputValue[]
        return adapter
      },
      run() {
        return Promise.resolve(adapter.execute())
      },
      first() {
        return Promise.resolve(statement.get(...bindings) ?? null)
      },
      all() {
        return Promise.resolve({
          success: true,
          results: statement.all(...bindings),
          meta: {},
        })
      },
      execute() {
        const result = statement.run(...bindings)
        return { success: true, meta: { changes: Number(result.changes) } }
      },
    }

    return adapter
  }

  return {
    db: {
      prepare(sql: string) {
        return prepare(sql) as unknown as D1PreparedStatement
      },
      batch(statements: D1PreparedStatement[]) {
        database.exec('BEGIN IMMEDIATE')
        try {
          const results = statements.map((statement, index) => {
            if (index === failNextBatchAt) throw new Error('Injected review batch failure')
            return (statement as unknown as SqliteD1Statement).execute()
          })
          database.exec('COMMIT')
          failNextBatchAt = undefined
          return Promise.resolve(results as unknown as D1Result[])
        } catch (error) {
          database.exec('ROLLBACK')
          failNextBatchAt = undefined
          return Promise.reject(
            error instanceof Error
              ? error
              : new Error('Review batch failed with a non-Error value', { cause: error }),
          )
        }
      },
    } as unknown as D1Database,
    resetSql() {
      preparedSql = []
    },
    sql() {
      return [...preparedSql]
    },
    failNextBatch(statementIndex: number) {
      failNextBatchAt = statementIndex
    },
  }
}

const createFixture = async () => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of migrationPaths) {
    database.exec(readFileSync(new URL(path, import.meta.url), 'utf8'))
  }
  const adapter = createSqliteD1(database)
  const repository = createD1ContentRepository(adapter.db)
  const builder = createContentBuilder({ repository, now: () => new Date(NOW) })
  const draft = await builder.importNewSourceIdempotently({
    operationToken: generateAdminOperationToken(),
    sourceName: 'D1 review source',
    words: Array.from({ length: 5 }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)}.`,
      exampleSentenceExtended: `I can use word-${String(index + 1)} every day.`,
    })),
  })
  await builder.buildExerciseItems(draft.versionId)

  return { database, adapter, repository, builder, draft }
}

describe('D1 exercise review repository', () => {
  it('reads one ordered prompt without selecting any answer JSON', async () => {
    const { adapter, repository, draft } = await createFixture()
    adapter.resetSql()

    const review = await repository.getExerciseReviewWindow(draft.versionId)

    expect(review).toMatchObject({
      totalCount: 30,
      pendingCount: 30,
      current: { word: 'word-1', position: 1, stage: 'S0' },
    })
    expect(adapter.sql().some((sql) => sql.includes('answer_json'))).toBe(false)
    expect(adapter.sql().some((sql) => sql.includes('words.order_index ASC'))).toBe(true)
  })

  it('persists one rework atomically, blocks old status writes, and clears on real correction', async () => {
    const { database, repository, builder, draft } = await createFixture()
    const item = (await builder.listExerciseItems(draft.versionId)).find(
      (candidate) => candidate.taskType === 'recall_word',
    )
    if (!item) throw new Error('Expected a recall item')
    await builder.approveExerciseItem(item.id)
    const before = await builder.getExerciseReviewWindow(draft.versionId, item.id)

    await builder.decideExerciseReview(item.id, {
      action: 'request_rework',
      expectedContentRevision: before.contentRevision,
      feedback: '需要更清楚的词义',
    })
    expect(
      database.prepare('SELECT status FROM exercise_items WHERE id = ?').get(item.id),
    ).toEqual({ status: 'draft' })
    expect(
      database
        .prepare(`
          SELECT feedback_text AS feedbackText, requested_at AS requestedAt
          FROM exercise_item_review_feedback
          WHERE exercise_item_id = ?
        `)
        .get(item.id),
    ).toEqual({ feedbackText: '需要更清楚的词义', requestedAt: NOW })

    const snapshot = await repository.getSourceVersion(draft.versionId)
    const stored = await repository.getExerciseItem(item.id)
    if (!snapshot || !stored) throw new Error('Expected stored review item')
    await expect(
      repository.updateExerciseItems(
        draft.versionId,
        [{ ...stored, status: 'approved' }],
        snapshot.version.contentRevision,
      ),
    ).rejects.toMatchObject({ code: 'review_feedback_open' })
    expect(
      database.prepare('SELECT content_revision FROM source_versions WHERE id = ?').get(draft.versionId),
    ).toEqual({ content_revision: snapshot.version.contentRevision })

    await builder.decideExerciseReview(item.id, {
      action: 'correct',
      expectedContentRevision: snapshot.version.contentRevision,
      content: {
        stage: item.stage,
        taskType: item.taskType,
        prompt: { meaning: '更清楚的词义' },
        answer: item.answer,
      },
    })
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM exercise_item_review_feedback WHERE exercise_item_id = ?')
        .get(item.id),
    ).toEqual({ count: 0 })
  })

  it.each([0, 1, 2])(
    'rolls back every rework write when D1 batch statement %s fails',
    async (statementIndex) => {
      const { database, adapter, builder, draft } = await createFixture()
      const item = (await builder.listExerciseItems(draft.versionId)).find(
        (candidate) => candidate.taskType === 'recall_word',
      )
      if (!item) throw new Error('Expected a recall item')
      await builder.approveExerciseItem(item.id)
      const before = await builder.getExerciseReviewWindow(draft.versionId, item.id)
      adapter.failNextBatch(statementIndex)

      await expect(
        builder.decideExerciseReview(item.id, {
          action: 'request_rework',
          expectedContentRevision: before.contentRevision,
          feedback: '不能部分写入',
        }),
      ).rejects.toThrow('Injected review batch failure')
      expect(
        database.prepare('SELECT status FROM exercise_items WHERE id = ?').get(item.id),
      ).toEqual({ status: 'approved' })
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM exercise_item_review_feedback WHERE exercise_item_id = ?')
          .get(item.id),
      ).toEqual({ count: 0 })
      expect(
        database.prepare('SELECT content_revision FROM source_versions WHERE id = ?').get(draft.versionId),
      ).toEqual({ content_revision: before.contentRevision })
    },
  )
})
