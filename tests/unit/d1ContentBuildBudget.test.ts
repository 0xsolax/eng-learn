import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { ContentRepository } from '../../server/repositories/contentRepository'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { sourceVersionListSchema } from '../../shared/api/contentSchemas'
import type { ImportWordInput } from '../../shared/domain/content'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'
import { parseAdminCsv } from '../../src/features/admin-content/csvImport'

const NOW = '2026-07-13T00:00:00.000Z'
const D1_FREE_QUERY_LIMIT = 50
const D1_BOUND_PARAMETER_LIMIT = 100
const D1_JSON_BINDING_BYTE_BUDGET = 512 * 1024
const D1_SQL_STATEMENT_BYTE_LIMIT = 100_000
const migrationPaths = [
  '../../migrations/0001_initial.sql',
  '../../migrations/0002_add_review_task_integrity.sql',
  '../../migrations/0003_add_learner_sessions.sql',
  '../../migrations/0004_harden_learner_sessions.sql',
  '../../migrations/0005_content_version_cas.sql',
  '../../migrations/0006_add_lesson_task_queue.sql',
  '../../migrations/0007_backfill_legacy_lesson_runtime.sql',
  '../../migrations/0008_add_admin_operation_ledger.sql',
  '../../migrations/0011_add_progressive_context_model.sql',
]

type SqliteD1Statement = {
  bind(...values: unknown[]): SqliteD1Statement
  run(): Promise<{ success: true; meta: { changes: number } }>
  first(): Promise<unknown>
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>
  execute(): { success: true; meta: { changes: number } }
}

type InvocationMetrics = {
  queryCount: number
  batchSizes: number[]
  maxBindingCount: number
  maxBindingUtf8Bytes: number
  maxSqlUtf8Bytes: number
  preparedSql: string[]
}

const createSqliteD1 = (database: DatabaseSync) => {
  let queryLimit = Number.POSITIVE_INFINITY
  let queryCount = 0
  let batchSizes: number[] = []
  let maxBindingCount = 0
  let maxBindingUtf8Bytes = 0
  let maxSqlUtf8Bytes = 0
  let preparedSql: string[] = []
  let failNextBatchAt: number | undefined
  const encoder = new TextEncoder()

  const reserveQueries = (count: number): void => {
    queryCount += count

    if (queryCount > queryLimit) {
      throw new Error(`D1 query budget exceeded: ${String(queryCount)} > ${String(queryLimit)}`)
    }
  }

  const prepare = (sql: string): SqliteD1Statement => {
    let bindings: SQLInputValue[] = []
    const sqlUtf8Bytes = encoder.encode(sql).byteLength

    maxSqlUtf8Bytes = Math.max(maxSqlUtf8Bytes, sqlUtf8Bytes)
    preparedSql.push(sql)

    if (sqlUtf8Bytes > D1_SQL_STATEMENT_BYTE_LIMIT) {
      throw new Error(
        `D1 SQL statement budget exceeded: ${String(sqlUtf8Bytes)} > ${String(D1_SQL_STATEMENT_BYTE_LIMIT)}`,
      )
    }

    const statement = database.prepare(sql)
    const adapter: SqliteD1Statement = {
      bind(...values) {
        bindings = values as SQLInputValue[]
        maxBindingCount = Math.max(maxBindingCount, bindings.length)
        const bindingUtf8Bytes = values.reduce(
          (largest, value) =>
            typeof value === 'string'
              ? Math.max(largest, encoder.encode(value).byteLength)
              : largest,
          0,
        )
        maxBindingUtf8Bytes = Math.max(maxBindingUtf8Bytes, bindingUtf8Bytes)

        if (bindings.length > D1_BOUND_PARAMETER_LIMIT) {
          throw new Error(
            `D1 bound parameter budget exceeded: ${String(bindings.length)} > ${String(D1_BOUND_PARAMETER_LIMIT)}`,
          )
        }

        if (bindingUtf8Bytes > D1_JSON_BINDING_BYTE_BUDGET) {
          throw new Error(
            `D1 binding byte budget exceeded: ${String(bindingUtf8Bytes)} > ${String(D1_JSON_BINDING_BYTE_BUDGET)}`,
          )
        }

        return adapter
      },
      run() {
        reserveQueries(1)
        return Promise.resolve(adapter.execute())
      },
      first() {
        reserveQueries(1)
        return Promise.resolve(statement.get(...bindings) ?? null)
      },
      all() {
        reserveQueries(1)
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

  const db = {
    prepare(sql: string) {
      return prepare(sql) as unknown as D1PreparedStatement
    },
    batch(statements: D1PreparedStatement[]) {
      reserveQueries(statements.length)
      batchSizes.push(statements.length)
      database.exec('BEGIN IMMEDIATE')

      try {
        const results = statements.map((statement, index) => {
          if (index === failNextBatchAt) {
            throw new Error('Injected D1 batch failure')
          }

          return (statement as unknown as SqliteD1Statement).execute()
        })

        database.exec('COMMIT')
        failNextBatchAt = undefined

        return Promise.resolve(results as unknown as D1Result[])
      } catch (error) {
        database.exec('ROLLBACK')
        failNextBatchAt = undefined

        return Promise.reject(error instanceof Error ? error : new Error('SQLite D1 batch failed'))
      }
    },
  } as unknown as D1Database

  return {
    db,
    beginInvocation(limit: number = Number.POSITIVE_INFINITY) {
      queryLimit = limit
      queryCount = 0
      batchSizes = []
      maxBindingCount = 0
      maxBindingUtf8Bytes = 0
      maxSqlUtf8Bytes = 0
      preparedSql = []
    },
    failNextBatch(statementIndex: number) {
      failNextBatchAt = statementIndex
    },
    metrics(): InvocationMetrics {
      return {
        queryCount,
        batchSizes,
        maxBindingCount,
        maxBindingUtf8Bytes,
        maxSqlUtf8Bytes,
        preparedSql,
      }
    },
  }
}

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')

  for (const migrationPath of migrationPaths) {
    database.exec(readFileSync(new URL(migrationPath, import.meta.url), 'utf8'))
  }

  return database
}

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const label = String(index + 1)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      examplePhrase: `word-${label}`,
      exampleSentence: `I use word-${label}.`,
      exampleSentenceExtended: `I can use word-${label} every day.`,
      partOfSpeech: 'noun',
    }
  })

const createNearTwoMiBWords = (): ImportWordInput[] =>
  Array.from({ length: 500 }, (_, index) => {
    const word = `word-${String(index + 1)}`

    return {
      word,
      meaning: '义'.repeat(80),
      examplePhrase: word,
      exampleSentence: `I use ${word}.`,
      exampleSentenceExtended: `${word} ${'例'.repeat(1_200)} is ready.`,
      partOfSpeech: 'noun',
    }
  })

const createCsvAtByteLimit = (): File => {
  const header =
    'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech'
  let paddingBytes = 256 * 1024 - new TextEncoder().encode([
    header,
    ...Array.from(
      { length: 500 },
      (_, index) => `word-${String(index + 1)},${'m'.repeat(500)},p,s,e,noun`,
    ),
  ].join('\n')).byteLength
  const rows = Array.from({ length: 500 }, (_, index) => {
    const padding = Math.min(paddingBytes, 1_999)

    paddingBytes -= padding
    return `word-${String(index + 1)},${'m'.repeat(500)},p,s,${'e'.repeat(padding + 1)},noun`
  })

  if (paddingBytes !== 0) throw new Error('Could not construct an exact CSV byte fixture')

  return new File(
    [new TextEncoder().encode([header, ...rows].join('\n'))],
    'words.csv',
    { type: 'text/csv' },
  )
}

const createBuilderFixture = () => {
  const database = createDatabase()
  const adapter = createSqliteD1(database)
  const repository = createD1ContentRepository(adapter.db)
  const builder = createContentBuilder({
    repository,
    now: () => new Date(NOW),
  })

  return { database, adapter, repository, builder }
}

describe('D1 content build query budget', () => {
  it('round-trips the v2 content model and all three context levels through D1', async () => {
    const { database, builder, repository } = createBuilderFixture()
    const [word] = createWords(1)

    if (!word) throw new Error('Expected one progressive word')

    const imported = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Progressive D1 source',
      words: [word],
    })
    const snapshot = await repository.getSourceVersion(imported.versionId)

    expect(snapshot?.version.contentModel).toBe('v2_progressive_context')
    expect(snapshot?.words[0]).toMatchObject({
      examplePhrase: word.examplePhrase,
      exampleSentence: word.exampleSentence,
      exampleSentenceExtended: word.exampleSentenceExtended,
    })

    database.close()
  })

  it('imports a 500-row CSV at the 256 KiB boundary within the D1 Free query budget', async () => {
    const file = createCsvAtByteLimit()
    const parsed = await parseAdminCsv(file)

    expect(file.size).toBe(256 * 1024)

    if (!parsed.ok) {
      throw new Error('Expected the 256 KiB CSV fixture to be valid')
    }

    const { database, adapter, builder } = createBuilderFixture()

    adapter.beginInvocation(D1_FREE_QUERY_LIMIT)
    await expect(
      builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(), sourceName: 'CSV boundary source', words: parsed.words }),
    ).resolves.toMatchObject({ wordCount: 500, groupCount: 100 })

    expectD1FreeInvocation(adapter.metrics())
    expect(adapter.metrics().queryCount).toBe(13)

    database.close()
  })

  it('imports a next version whose structured request is near 2 MiB within the Free budget', async () => {
    const { database, adapter, builder } = createBuilderFixture()
    const firstDraft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Large next-version source',
      words: createWords(5),
    })

    await builder.buildExerciseItems(firstDraft.versionId)
    await approveAllDraftItems(builder, firstDraft.versionId)
    await builder.publishVersion(firstDraft.versionId)

    const words = createNearTwoMiBWords()
    const requestBytes = new TextEncoder().encode(
      JSON.stringify({ mode: 'next_version', sourceId: firstDraft.sourceId, words }),
    ).byteLength

    expect(requestBytes).toBeGreaterThan(1.85 * 1024 * 1024)
    expect(requestBytes).toBeLessThanOrEqual(2 * 1024 * 1024)

    adapter.beginInvocation(D1_FREE_QUERY_LIMIT)
    await expect(
      builder.importNextVersionIdempotently({ operationToken: generateAdminOperationToken(), sourceId: firstDraft.sourceId, words }),
    ).resolves.toMatchObject({ versionNo: 2, wordCount: 500, groupCount: 100 })

    expectD1FreeInvocation(adapter.metrics())
    expect(adapter.metrics().queryCount).toBe(16)

    database.close()
  })

  it.each([
    {
      wordCount: 20,
      queryLimit: D1_FREE_QUERY_LIMIT,
      expectedBatchQueryCount: 3,
      expectedQueryCount: 13,
    },
    {
      wordCount: 500,
      queryLimit: D1_FREE_QUERY_LIMIT,
      expectedBatchQueryCount: 5,
      expectedQueryCount: 15,
    },
  ])(
    'builds all six stages for $wordCount words within one D1 invocation budget',
    async ({ wordCount, queryLimit, expectedBatchQueryCount, expectedQueryCount }) => {
      const { database, adapter, builder } = createBuilderFixture()
      const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
        sourceName: `Budget source ${String(wordCount)}`,
        words: createWords(wordCount),
      })

      adapter.beginInvocation(queryLimit)
      const coverage = await builder.buildExerciseItems(draft.versionId)

      expect(coverage.cells).toHaveLength(wordCount * 6)
      expectD1FreeInvocation(adapter.metrics())
      expect(adapter.metrics()).toMatchObject({
        queryCount: expectedQueryCount,
        batchSizes: [expectedBatchQueryCount],
      })

      database.close()
    },
  )

  it(
    'builds and approves a near-2-MiB 500-word version within separate Free invocations',
    async () => {
      const { database, adapter, builder } = createBuilderFixture()
      const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
        sourceName: 'Large build source',
        words: createNearTwoMiBWords(),
      })

      adapter.beginInvocation(D1_FREE_QUERY_LIMIT)
      const coverage = await builder.buildExerciseItems(draft.versionId)

      expect(coverage.cells).toHaveLength(3_000)
      const buildMetrics = adapter.metrics()

      expectD1FreeInvocation(buildMetrics)

      const itemIds = coverage.cells.flatMap((cell) => cell.itemId ?? [])

      expect(itemIds).toHaveLength(3_000)

      adapter.beginInvocation(D1_FREE_QUERY_LIMIT)
      await expect(builder.approveExerciseItems(itemIds)).resolves.toBeUndefined()
      const approveMetrics = adapter.metrics()

      expectD1FreeInvocation(approveMetrics)
      expect({
        buildQueryCount: buildMetrics.queryCount,
        approveQueryCount: approveMetrics.queryCount,
      }).toEqual({ buildQueryCount: 26, approveQueryCount: 21 })

      database.close()
    },
    30_000,
  )

  it('preserves a manually approved item when a D1-backed build is repeated', async () => {
    const { database, builder } = createBuilderFixture()
    const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Stable D1 rebuild',
      words: createWords(5),
    })

    await builder.buildExerciseItems(draft.versionId)

    const item = (await builder.listExerciseItems(draft.versionId)).find(
      (candidate) =>
        candidate.word === 'word-1' && candidate.taskType === 'recognize_meaning',
    )

    if (!item) {
      throw new Error('Expected a generated exercise item')
    }

    await builder.editExerciseItem(item.id, {
      prompt: {
        word: 'word-1',
        meaning: 'manual-meaning',
        exampleSentence: 'I still use word-1 manually.',
      },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })
    await builder.approveExerciseItem(item.id)
    await builder.buildExerciseItems(draft.versionId)

    expect(await builder.getExerciseItem(item.id)).toMatchObject({
      id: item.id,
      status: 'approved',
      prompt: {
        word: 'word-1',
        meaning: 'manual-meaning',
        exampleSentence: 'I still use word-1 manually.',
      },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })
    expect(await builder.listExerciseItems(draft.versionId)).toHaveLength(30)

    database.close()
  })

  it('rolls back every generated row and remains recoverable when a batch statement fails', async () => {
    const { database, adapter, repository, builder } = createBuilderFixture()
    const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Recoverable D1 build',
      words: createWords(20),
    })

    adapter.beginInvocation()
    adapter.failNextBatch(1)
    await expect(builder.buildExerciseItems(draft.versionId)).rejects.toThrow(
      'Injected D1 batch failure',
    )

    const rolledBack = await repository.getSourceVersion(draft.versionId)

    expect(rolledBack).toMatchObject({
      version: { status: 'draft', contentRevision: 0 },
      exerciseItems: [],
    })

    await expect(builder.buildExerciseItems(draft.versionId)).resolves.toMatchObject({
      sourceVersionId: draft.versionId,
      wordCount: 20,
    })

    database.close()
  })

  it('rolls back a partially executed source import and remains recoverable', async () => {
    const { database, adapter, builder } = createBuilderFixture()

    adapter.beginInvocation()
    adapter.failNextBatch(2)
    await expect(
      builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(), sourceName: 'Atomic import source', words: createWords(20) }),
    ).rejects.toThrow('Injected D1 batch failure')

    expect(database.prepare('SELECT COUNT(*) AS count FROM word_sources').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM source_versions').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM words').get()).toEqual({
      count: 0,
    })
    await expect(
      builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(), sourceName: 'Atomic import source', words: createWords(20) }),
    ).resolves.toMatchObject({ wordCount: 20, groupCount: 4 })

    database.close()
  })

  it('rolls back a partially executed approval and remains recoverable', async () => {
    const { database, adapter, repository, builder } = createBuilderFixture()
    const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Atomic approval source',
      words: createWords(20),
    })
    const coverage = await builder.buildExerciseItems(draft.versionId)
    const itemIds = coverage.cells.flatMap((cell) => cell.itemId ?? [])

    adapter.beginInvocation()
    adapter.failNextBatch(1)
    await expect(builder.approveExerciseItems(itemIds)).rejects.toThrow(
      'Injected D1 batch failure',
    )

    const rolledBack = await repository.getSourceVersion(draft.versionId)

    expect(rolledBack?.version.contentRevision).toBe(1)
    expect(rolledBack?.exerciseItems.every((item) => item.status === 'draft')).toBe(true)
    await expect(builder.approveExerciseItems(itemIds)).resolves.toBeUndefined()

    database.close()
  })

  it('allows only one CAS winner when two builders start from the same revision', async () => {
    const { database, repository: storedRepository, builder: setupBuilder } =
      createBuilderFixture()
    const draft = await setupBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Concurrent D1 build',
      words: createWords(20),
    })
    let initialReadCount = 0
    const bothReadsReached = createDeferred()
    const repository: ContentRepository = {
      ...storedRepository,
      async getSourceVersion(versionId) {
        const snapshot = await storedRepository.getSourceVersion(versionId)

        if (initialReadCount < 2) {
          initialReadCount += 1

          if (initialReadCount === 2) {
            bothReadsReached.resolve()
          }

          await bothReadsReached.promise
        }

        return snapshot
      },
    }
    const firstBuilder = createContentBuilder({ repository, now: () => new Date(NOW) })
    const secondBuilder = createContentBuilder({ repository, now: () => new Date(NOW) })

    const results = await Promise.allSettled([
      firstBuilder.buildExerciseItems(draft.versionId),
      secondBuilder.buildExerciseItems(draft.versionId),
    ])
    const finalSnapshot = await storedRepository.getSourceVersion(draft.versionId)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(finalSnapshot?.version.contentRevision).toBe(1)
    expect(finalSnapshot?.exerciseItems).toHaveLength(120)
    expect(
      new Set(
        finalSnapshot?.exerciseItems.map(
          (item) => `${item.wordId}:${item.stage}:${item.taskType}`,
        ),
      ).size,
    ).toBe(120)

    database.close()
  })
})

describe('D1 content list read budget', () => {
  it('lists 10 populated versions without crossing the D1 Free 50-query boundary', async () => {
    const { database, adapter, builder } = createBuilderFixture()

    seedSourceVersionSummaries(database, 10)
    adapter.beginInvocation(D1_FREE_QUERY_LIMIT)

    await expect(builder.listSourceVersions()).resolves.toHaveLength(10)
    expect(adapter.metrics().queryCount).toBe(1)

    database.close()
  })

  it('lists 500 summaries in one query without selecting exercise prompt or answer payloads', async () => {
    const { database, adapter, builder } = createBuilderFixture()

    seedSourceVersionSummaries(database, 500)
    adapter.beginInvocation()

    const summaries = await builder.listSourceVersions()
    const metrics = adapter.metrics()

    expect(metrics.queryCount).toBe(1)
    expect(metrics.preparedSql).toHaveLength(1)
    expect(metrics.preparedSql[0]).not.toMatch(/prompt_json|answer_json/)
    expect(sourceVersionListSchema.parse(summaries)).toEqual(summaries)
    expect(summaries).toHaveLength(500)
    expect(summaries[0]).toMatchObject({
      versionId: 'version-250',
      wordCount: 1,
      groupCount: 1,
      exerciseItemCount: 1,
      approvedItemCount: 1,
    })
    expect(summaries[249]?.versionId).toBe('version-1')
    expect(summaries[250]?.versionId).toBe('version-500')
    expect(summaries.at(-1)?.versionId).toBe('version-251')

    database.close()
  })

  it('returns an empty schema-valid list in one query', async () => {
    const { database, adapter, builder } = createBuilderFixture()

    adapter.beginInvocation(D1_FREE_QUERY_LIMIT)

    const summaries = await builder.listSourceVersions()

    expect(sourceVersionListSchema.parse(summaries)).toEqual([])
    expect(adapter.metrics().queryCount).toBe(1)

    database.close()
  })
})

const createDeferred = () => {
  let resolvePromise: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve: resolvePromise,
  }
}

const approveAllDraftItems = async (
  builder: ReturnType<typeof createContentBuilder>,
  versionId: string,
): Promise<void> => {
  const items = await builder.listExerciseItems(versionId)

  await builder.approveExerciseItems(items.map((item) => item.id))
}

const expectD1FreeInvocation = (metrics: InvocationMetrics): void => {
  expect(metrics.queryCount).toBeLessThanOrEqual(D1_FREE_QUERY_LIMIT)
  expect(metrics.maxBindingCount).toBeLessThanOrEqual(D1_BOUND_PARAMETER_LIMIT)
  expect(metrics.maxBindingUtf8Bytes).toBeLessThanOrEqual(D1_JSON_BINDING_BYTE_BUDGET)
  expect(metrics.maxSqlUtf8Bytes).toBeLessThanOrEqual(D1_SQL_STATEMENT_BYTE_LIMIT)
}

const seedSourceVersionSummaries = (database: DatabaseSync, count: number): void => {
  const sourceId = 'source-list'
  const insertVersion = database.prepare(
    `INSERT INTO source_versions (
      id, source_id, version_no, content_revision, status, created_at, published_at
    ) VALUES (?, ?, ?, 0, 'published', ?, ?)`,
  )
  const insertWord = database.prepare(
    `INSERT INTO words (
      id, source_version_id, order_index, word, meaning,
      example_sentence, part_of_speech, created_at
    ) VALUES (?, ?, 1, ?, 'meaning', ?, 'noun', ?)`,
  )
  const insertGroup = database.prepare(
    `INSERT INTO word_groups (
      id, source_version_id, group_index, start_order_index, end_order_index, created_at
    ) VALUES (?, ?, 1, 1, 1, ?)`,
  )
  const insertItem = database.prepare(
    `INSERT INTO exercise_items (
      id, source_version_id, word_id, stage, task_type,
      prompt_json, answer_json, status, created_at
    ) VALUES (?, ?, ?, 'S0', 'recognize_meaning', ?, ?, ?, ?)`,
  )
  const largeMeaning = 'm'.repeat(1_900)

  database.exec('BEGIN IMMEDIATE')
  database
    .prepare('INSERT INTO word_sources (id, name, created_at) VALUES (?, ?, ?)')
    .run(sourceId, 'List source', NOW)

  for (let index = 1; index <= count; index += 1) {
    const label = String(index)
    const versionId = `version-${label}`
    const wordId = `word-${label}`
    const createdAt = index <= Math.ceil(count / 2)
      ? '2026-07-13T01:00:00.000Z'
      : '2026-07-13T00:00:00.000Z'
    const publishedAt = '2026-07-13T02:00:00.000Z'

    insertVersion.run(versionId, sourceId, index, createdAt, publishedAt)
    insertWord.run(
      wordId,
      versionId,
      `word-${label}`,
      `I can use word-${label}.`,
      createdAt,
    )
    insertGroup.run(`group-${label}`, versionId, createdAt)
    insertItem.run(
      `item-${label}`,
      versionId,
      wordId,
      JSON.stringify({
        word: `word-${label}`,
        meaning: largeMeaning,
        exampleSentence: `I can use word-${label}.`,
      }),
      JSON.stringify({ word: `word-${label}`, expectedResponse: 'known' }),
      index % 2 === 0 ? 'approved' : 'draft',
      createdAt,
    )
  }

  database.exec('COMMIT')
}
