import { describe, expect, it } from 'vitest'
import { createD1ContentRepository } from '../../server/repositories/d1ContentRepository'
import type { ExerciseItemRecord } from '../../server/repositories/contentRepository'

type CapturedStatement = {
  sql: string
  bindings: unknown[]
}

type RecordingOptions = {
  runChanges?: number
  batchChanges?: number | number[]
}

const createRecordingD1 = (
  firstResults: unknown[] = [],
  options: RecordingOptions = {},
) => {
  const statements: CapturedStatement[] = []
  const db = {
    prepare(sql: string) {
      const captured: CapturedStatement = { sql, bindings: [] }
      statements.push(captured)
      const statement = {
        bind(...bindings: unknown[]) {
          captured.bindings = bindings
          return statement
        },
        run() {
          return Promise.resolve({ meta: { changes: options.runChanges ?? 1 } })
        },
        first() {
          return Promise.resolve(firstResults.shift() ?? null)
        },
      }

      return statement
    },
    batch(statementsToRun: D1PreparedStatement[]) {
      return Promise.resolve(
        statementsToRun.map((_, index) => ({
          meta: {
            changes: Array.isArray(options.batchChanges)
              ? (options.batchChanges[index] ?? 1)
              : (options.batchChanges ?? 1),
          },
        })),
      )
    },
  } as unknown as D1Database

  return { db, statements }
}

const createExerciseItem = (): ExerciseItemRecord => ({
  id: 'item-1',
  sourceVersionId: 'version-1',
  wordId: 'word-1',
  stage: 'S0',
  taskType: 'recognize_meaning',
  prompt: { word: "bound'value" },
  answer: { word: 'answer-1' },
  status: 'draft',
  createdAt: '2026-07-13T00:00:00.000Z',
})

describe('D1 content repository lifecycle writes', () => {
  it('rejects malformed exercise JSON when reading from D1', async () => {
    const { db } = createRecordingD1([
      {
        id: 'item-1',
        source_version_id: 'version-1',
        word_id: 'word-1',
        stage: 'S2',
        task_type: 'multiple_choice',
        prompt_json: JSON.stringify({
          meaning: 'meaning-1',
          options: ['word-2', 'word-3', 'word-4'],
        }),
        answer_json: JSON.stringify({ word: 'word-1' }),
        status: 'approved',
        created_at: '2026-07-13T00:00:00.000Z',
      },
    ])
    const repository = createD1ContentRepository(db)

    await expect(repository.getExerciseItem('item-1')).rejects.toThrow(
      'Multiple-choice answer must be one of the options',
    )
  })

  it('adds missing generated items without deleting reviewed content and binds values', async () => {
    const { db, statements } = createRecordingD1()
    const repository = createD1ContentRepository(db)

    await repository.addExerciseItems('version-1', [createExerciseItem()], 0)

    expect(statements.some((statement) => statement.sql.includes('DELETE'))).toBe(false)

    const itemInsert = statements.find((statement) =>
      statement.sql.includes('INSERT INTO exercise_items'),
    )

    expect(itemInsert?.sql).not.toContain("bound'value")
    expect(itemInsert?.sql).toContain('expected_version')
    expect(itemInsert?.sql).toContain("status = 'draft' AND content_revision = ?")
    expect(itemInsert).toBeDefined()

    const [boundItem] = JSON.parse(itemInsert?.bindings[0] as string) as Array<{
      promptJson: string
    }>

    expect(JSON.parse(boundItem.promptJson)).toEqual({ word: "bound'value" })
    expect(itemInsert?.bindings.slice(1)).toEqual(['version-1', 0])
  })

  it('allows item updates and publishing only while the source version is draft', async () => {
    const { db, statements } = createRecordingD1([
      {
        id: 'version-1',
        source_id: 'source-1',
        version_no: 1,
        content_revision: 0,
        status: 'published',
        created_at: '2026-07-13T00:00:00.000Z',
        published_at: '2026-07-13T01:00:00.000Z',
      },
    ])
    const repository = createD1ContentRepository(db)

    await repository.updateExerciseItems('version-1', [createExerciseItem()], 0)
    await repository.publishSourceVersion('version-1', '2026-07-13T01:00:00.000Z', 1)

    const itemUpdate = statements.find((statement) =>
      statement.sql.includes('UPDATE exercise_items'),
    )
    const versionUpdate = statements.find((statement) =>
      statement.sql.includes('published_at'),
    )

    expect(itemUpdate?.sql).toContain('source_versions')
    expect(itemUpdate?.sql).toContain(
      "WHERE id = ?2 AND status = 'draft' AND content_revision = ?3",
    )
    expect(itemUpdate?.bindings.slice(1, 3)).toEqual(['version-1', 0])
    expect(versionUpdate?.sql).toContain(
      'WHERE id = ? AND status = ? AND content_revision = ?',
    )
    expect(versionUpdate?.bindings).toEqual([
      'published',
      '2026-07-13T01:00:00.000Z',
      'version-1',
      'draft',
      1,
    ])
  })

  it('rejects zero-row CAS updates instead of reporting a successful content write', async () => {
    const { db } = createRecordingD1(
      [{ status: 'draft' }],
      { batchChanges: 0 },
    )
    const repository = createD1ContentRepository(db)

    await expect(
      repository.updateExerciseItems('version-1', [createExerciseItem()], 4),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Source version changed concurrently',
    })
  })

  it.each(['published', 'archived'] as const)(
    'classifies a zero-row CAS write against a %s version as immutable',
    async (status) => {
      const { db } = createRecordingD1(
        [{ status }],
        { batchChanges: 0 },
      )
      const repository = createD1ContentRepository(db)

      await expect(
        repository.updateExerciseItems('version-1', [createExerciseItem()], 4),
      ).rejects.toMatchObject({
        code: 'source_version_immutable',
        message: 'Published source versions are immutable',
      })
    },
  )

  it('does not classify an actually missing version as a CAS business conflict', async () => {
    const { db } = createRecordingD1([], { batchChanges: 0 })
    const repository = createD1ContentRepository(db)
    const failure = await repository
      .updateExerciseItems(
        'missing-version',
        [{ ...createExerciseItem(), sourceVersionId: 'missing-version' }],
        4,
      )
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ message: 'Source version missing-version is missing' })
    expect(failure).not.toHaveProperty('code')
  })

  it('archives only the expected draft revision', async () => {
    const { db, statements } = createRecordingD1([
      {
        id: 'version-1',
        source_id: 'source-1',
        version_no: 1,
        content_revision: 3,
        status: 'archived',
        created_at: '2026-07-13T00:00:00.000Z',
        published_at: null,
      },
    ])
    const repository = createD1ContentRepository(db)

    await expect(repository.archiveDraftVersion('version-1', 3)).resolves.toMatchObject({
      id: 'version-1',
      status: 'archived',
      contentRevision: 3,
    })

    const archiveUpdate = statements.find((statement) =>
      statement.sql.startsWith('UPDATE source_versions SET status = ?'),
    )

    expect(archiveUpdate?.bindings).toEqual(['archived', 'version-1', 'draft', 3])
  })
})
