import type {
  SourceVersionSummary,
  SourceVersionStatus,
  TaskType,
  WordStage,
} from '../../shared/domain/content'
import type {
  ContentRepository,
  CreateSourceVersionInput,
  ExerciseItemRecord,
  SourceRecord,
  SourceVersionRecord,
  SourceVersionSnapshot,
  WordGroupRecord,
  WordRecord,
} from './contentRepository'
import { parsePersistedExerciseItemContent } from './persistedExerciseContent'
import { createD1AdminOperationInsert } from './adminOperationLedger'
import { DomainError } from '../errors/DomainError'

type SourceRow = {
  id: string
  name: string
  created_at: string
}

type SourceVersionRow = {
  id: string
  source_id: string
  version_no: number
  content_revision: number
  status: SourceVersionStatus
  created_at: string
  published_at: string | null
}

type WordRow = {
  id: string
  source_version_id: string
  order_index: number
  word: string
  meaning: string
  example_sentence: string
  part_of_speech: string | null
  created_at: string
}

type WordGroupRow = {
  id: string
  source_version_id: string
  group_index: number
  start_order_index: number
  end_order_index: number
  created_at: string
}

type ExerciseItemRow = {
  id: string
  source_version_id: string
  word_id: string
  stage: WordStage
  task_type: TaskType
  prompt_json: string
  answer_json: string
  status: 'draft' | 'approved' | 'disabled'
  created_at: string
  linked_word?: string
  linked_example_sentence?: string
}

type SourceVersionSummaryRow = {
  source_id: string
  source_name: string
  version_id: string
  version_no: number
  status: SourceVersionStatus
  word_count: number
  group_count: number
  exercise_item_count: number
  approved_item_count: number
  created_at: string
  published_at: string | null
}

export const D1_BULK_JSON_MAX_BYTES = 512 * 1024

export const createD1ContentRepository = (db: D1Database): ContentRepository => ({
  async createSourceVersion(input: CreateSourceVersionInput) {
    const existingDraft = await db
      .prepare('SELECT id FROM source_versions WHERE source_id = ? AND status = ? LIMIT 1')
      .bind(input.version.sourceId, 'draft')
      .first<{ id: string }>()

    if (existingDraft) {
      throw new Error('Source already has a draft version')
    }

    const mismatchedWord = input.words.find(
      (word) => word.sourceVersionId !== input.version.id,
    )
    const mismatchedGroup = input.groups.find(
      (group) => group.sourceVersionId !== input.version.id,
    )

    if (mismatchedWord) {
      throw new Error(`Word ${mismatchedWord.id} belongs to another source version`)
    }

    if (mismatchedGroup) {
      throw new Error(`Word group ${mismatchedGroup.id} belongs to another source version`)
    }

    const wordChunks = serializeJsonChunks(
      input.words.map((word) => ({
        id: word.id,
        orderIndex: word.orderIndex,
        word: word.word,
        meaning: word.meaning,
        exampleSentence: word.exampleSentence,
        partOfSpeech: word.partOfSpeech ?? null,
        createdAt: word.createdAt,
      })),
    )
    const groupChunks = serializeJsonChunks(
      input.groups.map((group) => ({
        id: group.id,
        groupIndex: group.groupIndex,
        startOrderIndex: group.startOrderIndex,
        endOrderIndex: group.endOrderIndex,
        createdAt: group.createdAt,
      })),
    )

    await db.batch([
      ...(input.adminOperation
        ? [createD1AdminOperationInsert(db, input.adminOperation)]
        : []),
      ...(input.source
        ? [
            db
              .prepare('INSERT INTO word_sources (id, name, created_at) VALUES (?, ?, ?)')
              .bind(input.source.id, input.source.name, input.source.createdAt),
          ]
        : []),
      db
        .prepare(
          'INSERT INTO source_versions (id, source_id, version_no, content_revision, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          input.version.id,
          input.version.sourceId,
          input.version.versionNo,
          input.version.contentRevision,
          input.version.status,
          input.version.createdAt,
        ),
      ...wordChunks.map((chunk) => createWordInsert(db, input.version.id, chunk)),
      ...groupChunks.map((chunk) => createWordGroupInsert(db, input.version.id, chunk)),
    ])

    const snapshot = await getSourceVersionSnapshot(db, input.version.id)

    if (!snapshot) {
      throw new Error(`Source version ${input.version.id} was not created`)
    }

    return snapshot
  },

  async getSource(sourceId: string) {
    const row = await db
      .prepare('SELECT * FROM word_sources WHERE id = ?')
      .bind(sourceId)
      .first<SourceRow>()

    return row ? mapSource(row) : undefined
  },

  async listSourceVersions() {
    const rows = await db
      .prepare(
        `WITH word_counts AS (
          SELECT source_version_id, COUNT(*) AS word_count
          FROM words
          GROUP BY source_version_id
        ), group_counts AS (
          SELECT source_version_id, COUNT(*) AS group_count
          FROM word_groups
          GROUP BY source_version_id
        ), exercise_counts AS (
          SELECT
            source_version_id,
            COUNT(*) AS exercise_item_count,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_item_count
          FROM exercise_items
          GROUP BY source_version_id
        )
        SELECT
          sources.id AS source_id,
          sources.name AS source_name,
          versions.id AS version_id,
          versions.version_no,
          versions.status,
          COALESCE(word_counts.word_count, 0) AS word_count,
          COALESCE(group_counts.group_count, 0) AS group_count,
          COALESCE(exercise_counts.exercise_item_count, 0) AS exercise_item_count,
          COALESCE(exercise_counts.approved_item_count, 0) AS approved_item_count,
          versions.created_at,
          versions.published_at
        FROM source_versions AS versions
        INNER JOIN word_sources AS sources ON sources.id = versions.source_id
        LEFT JOIN word_counts ON word_counts.source_version_id = versions.id
        LEFT JOIN group_counts ON group_counts.source_version_id = versions.id
        LEFT JOIN exercise_counts ON exercise_counts.source_version_id = versions.id
        ORDER BY versions.created_at DESC, versions.version_no DESC`,
      )
      .all<SourceVersionSummaryRow>()

    return rows.results.map(mapSourceVersionSummary)
  },

  async listSourceVersionsBySource(sourceId: string) {
    const rows = await db
      .prepare('SELECT * FROM source_versions WHERE source_id = ? ORDER BY version_no ASC')
      .bind(sourceId)
      .all<SourceVersionRow>()

    return rows.results.map(mapSourceVersion)
  },

  async getSourceVersion(versionId: string) {
    return getSourceVersionSnapshot(db, versionId)
  },

  async addExerciseItems(
    versionId: string,
    items: ExerciseItemRecord[],
    expectedRevision: number,
  ) {
    if (items.length === 0) {
      await requireDraftRevision(db, versionId, expectedRevision)

      return expectedRevision
    }

    const mismatchedItem = items.find((item) => item.sourceVersionId !== versionId)

    if (mismatchedItem) {
      throw new Error(`Exercise item ${mismatchedItem.id} belongs to another source version`)
    }

    const wordIds = Array.from(new Set(items.map((item) => item.wordId)))
    const packCreatedAt = items[0]?.createdAt ?? new Date().toISOString()

    const packChunks = serializeJsonChunks(
      wordIds.map((wordId) => ({
        id: crypto.randomUUID(),
        wordId,
        createdAt: packCreatedAt,
      })),
    )
    const packStatements = packChunks.map((chunk) =>
      createExercisePackInsert(db, versionId, chunk, expectedRevision),
    )
    const itemChunks = serializeExerciseItems(items)
    const itemStatements = itemChunks.map((chunk) =>
      createExerciseItemInsert(db, versionId, chunk, expectedRevision),
    )

    const results = await db.batch([
      ...packStatements,
      ...itemStatements,
      db
        .prepare(
          'UPDATE source_versions SET content_revision = content_revision + 1 WHERE id = ? AND status = ? AND content_revision = ?',
        )
        .bind(versionId, 'draft', expectedRevision),
    ])

    const itemResults = results.slice(
      packStatements.length,
      packStatements.length + itemStatements.length,
    )
    const revisionResult = results.at(-1)

    if (
      revisionResult?.meta.changes !== 1 ||
      itemResults.some(
        (result, index) => result.meta.changes !== itemChunks[index]?.rowCount,
      )
    ) {
      await throwWriteConflict(db, versionId)
    }

    return expectedRevision + 1
  },

  async getExerciseItem(itemId: string) {
    const row = await db
      .prepare(
        'SELECT exercise_items.*, words.word AS linked_word, words.example_sentence AS linked_example_sentence FROM exercise_items INNER JOIN words ON words.id = exercise_items.word_id WHERE exercise_items.id = ?',
      )
      .bind(itemId)
      .first<ExerciseItemRow>()

    return row ? mapExerciseItem(row) : undefined
  },

  async getExerciseItems(itemIds: string[]) {
    const uniqueItemIds = Array.from(new Set(itemIds))

    if (uniqueItemIds.length === 0) {
      return []
    }

    const rowsById = new Map<string, ExerciseItemRow>()

    for (const chunk of serializeJsonChunks(uniqueItemIds)) {
      const rows = await db
        .prepare(
          'SELECT exercise_items.*, words.word AS linked_word, words.example_sentence AS linked_example_sentence FROM exercise_items INNER JOIN words ON words.id = exercise_items.word_id WHERE exercise_items.id IN (SELECT value FROM json_each(?))',
        )
        .bind(chunk.json)
        .all<ExerciseItemRow>()

      for (const row of rows.results) {
        rowsById.set(row.id, row)
      }
    }

    return uniqueItemIds.flatMap((itemId) => {
      const row = rowsById.get(itemId)

      return row ? [mapExerciseItem(row)] : []
    })
  },

  async updateExerciseItems(
    versionId: string,
    items: ExerciseItemRecord[],
    expectedRevision: number,
  ) {
    if (items.length === 0) {
      await requireDraftRevision(db, versionId, expectedRevision)

      return expectedRevision
    }

    const mismatchedItem = items.find((item) => item.sourceVersionId !== versionId)
    const uniqueItemIds = Array.from(new Set(items.map((item) => item.id)))

    if (mismatchedItem) {
      throw new Error(`Exercise item ${mismatchedItem.id} belongs to another source version`)
    }

    if (uniqueItemIds.length !== items.length) {
      throw new Error('Exercise item update contains duplicate ids')
    }

    const allItemIdsJson = serializeJsonValue(uniqueItemIds)
    const itemChunks = serializeExerciseItems(items)
    const itemStatements = itemChunks.map((chunk) =>
      createExerciseItemUpdate(
        db,
        versionId,
        chunk,
        expectedRevision,
        allItemIdsJson,
      ),
    )

    const results = await db.batch([
      ...itemStatements,
      db
        .prepare(
          `UPDATE source_versions
          SET content_revision = content_revision + 1
          WHERE id = ?1 AND status = 'draft' AND content_revision = ?2
            AND (
              SELECT COUNT(*) FROM exercise_items
              WHERE source_version_id = ?1
                AND id IN (SELECT value FROM json_each(?3))
            ) = json_array_length(?3)`,
        )
        .bind(versionId, expectedRevision, allItemIdsJson),
    ])

    const itemResults = results.slice(0, itemStatements.length)
    const revisionResult = results.at(-1)

    if (
      revisionResult?.meta.changes !== 1 ||
      itemResults.some(
        (result, index) => result.meta.changes !== itemChunks[index]?.rowCount,
      )
    ) {
      await throwWriteConflict(db, versionId)
    }

    return expectedRevision + 1
  },

  async publishSourceVersion(
    versionId: string,
    publishedAt: string,
    expectedRevision: number,
  ) {
    const result = await db
      .prepare(
        'UPDATE source_versions SET status = ?, published_at = ? WHERE id = ? AND status = ? AND content_revision = ?',
      )
      .bind('published', publishedAt, versionId, 'draft', expectedRevision)
      .run()

    if (result.meta.changes !== 1) {
      await throwWriteConflict(db, versionId)
    }

    const row = await db
      .prepare('SELECT * FROM source_versions WHERE id = ?')
      .bind(versionId)
      .first<SourceVersionRow>()

    if (!row) {
      throw new Error(`Source version ${versionId} is missing`)
    }

    return mapSourceVersion(row)
  },

  async archiveDraftVersion(versionId: string, expectedRevision: number) {
    const result = await db
      .prepare(
        'UPDATE source_versions SET status = ? WHERE id = ? AND status = ? AND content_revision = ?',
      )
      .bind('archived', versionId, 'draft', expectedRevision)
      .run()

    if (result.meta.changes !== 1) {
      await throwWriteConflict(db, versionId)
    }

    const row = await db
      .prepare('SELECT * FROM source_versions WHERE id = ?')
      .bind(versionId)
      .first<SourceVersionRow>()

    if (!row) {
      throw new Error(`Source version ${versionId} is missing`)
    }

    return mapSourceVersion(row)
  },
})

type JsonChunk = {
  json: string
  rowCount: number
}

const UTF8_ENCODER = new TextEncoder()

const createWordInsert = (
  db: D1Database,
  versionId: string,
  chunk: JsonChunk,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO words (
        id, source_version_id, order_index, word, meaning,
        example_sentence, part_of_speech, created_at
      )
      SELECT
        json_extract(json_row.value, '$.id'),
        ?2,
        CAST(json_extract(json_row.value, '$.orderIndex') AS INTEGER),
        json_extract(json_row.value, '$.word'),
        json_extract(json_row.value, '$.meaning'),
        json_extract(json_row.value, '$.exampleSentence'),
        json_extract(json_row.value, '$.partOfSpeech'),
        json_extract(json_row.value, '$.createdAt')
      FROM json_each(?1) AS json_row`,
    )
    .bind(chunk.json, versionId)

const createWordGroupInsert = (
  db: D1Database,
  versionId: string,
  chunk: JsonChunk,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO word_groups (
        id, source_version_id, group_index, start_order_index, end_order_index, created_at
      )
      SELECT
        json_extract(json_row.value, '$.id'),
        ?2,
        CAST(json_extract(json_row.value, '$.groupIndex') AS INTEGER),
        CAST(json_extract(json_row.value, '$.startOrderIndex') AS INTEGER),
        CAST(json_extract(json_row.value, '$.endOrderIndex') AS INTEGER),
        json_extract(json_row.value, '$.createdAt')
      FROM json_each(?1) AS json_row`,
    )
    .bind(chunk.json, versionId)

const createExercisePackInsert = (
  db: D1Database,
  versionId: string,
  chunk: JsonChunk,
  expectedRevision: number,
): D1PreparedStatement =>
  db
    .prepare(
      `WITH expected_version(id) AS (
        SELECT id FROM source_versions
        WHERE id = ?2 AND status = 'draft' AND content_revision = ?3
      ), pack_rows(id, word_id, created_at) AS (
        SELECT
          json_extract(json_row.value, '$.id'),
          json_extract(json_row.value, '$.wordId'),
          json_extract(json_row.value, '$.createdAt')
        FROM json_each(?1) AS json_row
      )
      INSERT INTO exercise_packs (id, source_version_id, word_id, status, created_at)
      SELECT pack_rows.id, expected_version.id, pack_rows.word_id, 'draft', pack_rows.created_at
      FROM pack_rows CROSS JOIN expected_version
      WHERE NOT EXISTS (
        SELECT 1 FROM exercise_packs existing_pack
        WHERE existing_pack.source_version_id = expected_version.id
          AND existing_pack.word_id = pack_rows.word_id
      )`,
    )
    .bind(chunk.json, versionId, expectedRevision)

const createExerciseItemInsert = (
  db: D1Database,
  versionId: string,
  chunk: JsonChunk,
  expectedRevision: number,
): D1PreparedStatement =>
  db
    .prepare(
      `WITH expected_version(id) AS (
        SELECT id FROM source_versions
        WHERE id = ?2 AND status = 'draft' AND content_revision = ?3
      ), item_rows(
        id, word_id, stage, task_type, prompt_json, answer_json, status, created_at
      ) AS (
        SELECT
          json_extract(json_row.value, '$.id'),
          json_extract(json_row.value, '$.wordId'),
          json_extract(json_row.value, '$.stage'),
          json_extract(json_row.value, '$.taskType'),
          json_extract(json_row.value, '$.promptJson'),
          json_extract(json_row.value, '$.answerJson'),
          json_extract(json_row.value, '$.status'),
          json_extract(json_row.value, '$.createdAt')
        FROM json_each(?1) AS json_row
      )
      INSERT INTO exercise_items (
        id, source_version_id, word_id, stage, task_type,
        prompt_json, answer_json, status, created_at
      )
      SELECT
        item_rows.id, expected_version.id, item_rows.word_id, item_rows.stage,
        item_rows.task_type, item_rows.prompt_json, item_rows.answer_json,
        item_rows.status, item_rows.created_at
      FROM item_rows CROSS JOIN expected_version`,
    )
    .bind(chunk.json, versionId, expectedRevision)

const createExerciseItemUpdate = (
  db: D1Database,
  versionId: string,
  chunk: JsonChunk,
  expectedRevision: number,
  allItemIdsJson: string,
): D1PreparedStatement =>
  db
    .prepare(
      `WITH item_rows(
        id, task_type, prompt_json, answer_json, status
      ) AS (
        SELECT
          json_extract(json_row.value, '$.id'),
          json_extract(json_row.value, '$.taskType'),
          json_extract(json_row.value, '$.promptJson'),
          json_extract(json_row.value, '$.answerJson'),
          json_extract(json_row.value, '$.status')
        FROM json_each(?1) AS json_row
      )
      UPDATE exercise_items
      SET
        task_type = item_rows.task_type,
        prompt_json = item_rows.prompt_json,
        answer_json = item_rows.answer_json,
        status = item_rows.status
      FROM item_rows
      WHERE exercise_items.id = item_rows.id
        AND exercise_items.source_version_id = ?2
        AND EXISTS (
          SELECT 1 FROM source_versions
          WHERE id = ?2 AND status = 'draft' AND content_revision = ?3
        )
        AND (
          SELECT COUNT(*) FROM exercise_items all_items
          WHERE all_items.source_version_id = ?2
            AND all_items.id IN (SELECT value FROM json_each(?4))
        ) = json_array_length(?4)`,
    )
    .bind(chunk.json, versionId, expectedRevision, allItemIdsJson)

const serializeExerciseItems = (items: ExerciseItemRecord[]): JsonChunk[] =>
  serializeJsonChunks(
    items.map((item) => ({
      id: item.id,
      wordId: item.wordId,
      stage: item.stage,
      taskType: item.taskType,
      promptJson: JSON.stringify(item.prompt),
      answerJson: JSON.stringify(item.answer),
      status: item.status,
      createdAt: item.createdAt,
    })),
  )

const serializeJsonChunks = (rows: readonly unknown[]): JsonChunk[] => {
  const chunks: JsonChunk[] = []
  let currentRows: string[] = []
  let currentBytes = 2

  const flush = (): void => {
    if (currentRows.length === 0) return

    chunks.push({
      json: `[${currentRows.join(',')}]`,
      rowCount: currentRows.length,
    })
    currentRows = []
    currentBytes = 2
  }

  for (const row of rows) {
    const serializedRow = stringifyJson(row, 'D1 bulk row is not JSON serializable')

    const rowBytes = UTF8_ENCODER.encode(serializedRow).byteLength
    const delimiterBytes = currentRows.length === 0 ? 0 : 1

    if (rowBytes + 2 > D1_BULK_JSON_MAX_BYTES) {
      throw new Error('D1 bulk row exceeds the JSON binding byte budget')
    }

    if (currentBytes + delimiterBytes + rowBytes > D1_BULK_JSON_MAX_BYTES) {
      flush()
    }

    currentRows.push(serializedRow)
    currentBytes += (currentRows.length === 1 ? 0 : 1) + rowBytes
  }

  flush()

  return chunks
}

const serializeJsonValue = (value: unknown): string => {
  const json = stringifyJson(value, 'D1 bulk value is not JSON serializable')

  if (UTF8_ENCODER.encode(json).byteLength > D1_BULK_JSON_MAX_BYTES) {
    throw new Error('D1 bulk value exceeds the JSON binding byte budget')
  }

  return json
}

const stringifyJson = (value: unknown, errorMessage: string): string => {
  const json: unknown = JSON.stringify(value)

  if (typeof json !== 'string') {
    throw new Error(errorMessage)
  }

  return json
}

const getSourceVersionSnapshot = async (
  db: D1Database,
  versionId: string,
): Promise<SourceVersionSnapshot | undefined> => {
  const version = await db
    .prepare('SELECT * FROM source_versions WHERE id = ?')
    .bind(versionId)
    .first<SourceVersionRow>()

  if (!version) {
    return undefined
  }

  const source = await db
    .prepare('SELECT * FROM word_sources WHERE id = ?')
    .bind(version.source_id)
    .first<SourceRow>()

  if (!source) {
    throw new Error(`Source ${version.source_id} is missing`)
  }

  const words = await db
    .prepare('SELECT * FROM words WHERE source_version_id = ? ORDER BY order_index ASC')
    .bind(versionId)
    .all<WordRow>()
  const groups = await db
    .prepare('SELECT * FROM word_groups WHERE source_version_id = ? ORDER BY group_index ASC')
    .bind(versionId)
    .all<WordGroupRow>()
  const exerciseItems = await db
    .prepare('SELECT * FROM exercise_items WHERE source_version_id = ? ORDER BY word_id ASC, stage ASC')
    .bind(versionId)
    .all<ExerciseItemRow>()

  const mappedWords = words.results.map(mapWord)
  const wordsById = new Map(mappedWords.map((word) => [word.id, word]))

  return {
    source: mapSource(source),
    version: mapSourceVersion(version),
    words: mappedWords,
    groups: groups.results.map(mapWordGroup),
    exerciseItems: exerciseItems.results.map((row) =>
      mapExerciseItem(row, wordsById.get(row.word_id)),
    ),
  }
}

const mapSource = (row: SourceRow): SourceRecord => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
})

const mapSourceVersion = (row: SourceVersionRow): SourceVersionRecord => ({
  id: row.id,
  sourceId: row.source_id,
  versionNo: row.version_no,
  contentRevision: row.content_revision,
  status: row.status,
  createdAt: row.created_at,
  ...(row.published_at ? { publishedAt: row.published_at } : {}),
})

const mapSourceVersionSummary = (
  row: SourceVersionSummaryRow,
): SourceVersionSummary => ({
  sourceId: row.source_id,
  sourceName: row.source_name,
  versionId: row.version_id,
  versionNo: row.version_no,
  status: row.status,
  wordCount: row.word_count,
  groupCount: row.group_count,
  exerciseItemCount: row.exercise_item_count,
  approvedItemCount: row.approved_item_count,
  createdAt: row.created_at,
  ...(row.published_at ? { publishedAt: row.published_at } : {}),
})

const mapWord = (row: WordRow): WordRecord => ({
  id: row.id,
  sourceVersionId: row.source_version_id,
  orderIndex: row.order_index,
  word: row.word,
  meaning: row.meaning,
  exampleSentence: row.example_sentence,
  ...(row.part_of_speech ? { partOfSpeech: row.part_of_speech } : {}),
  createdAt: row.created_at,
})

const mapWordGroup = (row: WordGroupRow): WordGroupRecord => ({
  id: row.id,
  sourceVersionId: row.source_version_id,
  groupIndex: row.group_index,
  startOrderIndex: row.start_order_index,
  endOrderIndex: row.end_order_index,
  createdAt: row.created_at,
})

const mapExerciseItem = (
  row: ExerciseItemRow,
  linkedWord?: Pick<WordRecord, 'word' | 'exampleSentence'>,
): ExerciseItemRecord => {
  const content = parsePersistedExerciseItemContent(
    {
      stage: row.stage,
      taskType: row.task_type,
      prompt: JSON.parse(row.prompt_json) as unknown,
      answer: JSON.parse(row.answer_json) as unknown,
    },
    linkedWord ??
      (row.linked_word === undefined || row.linked_example_sentence === undefined
        ? undefined
        : {
            word: row.linked_word,
            exampleSentence: row.linked_example_sentence,
          }),
  )

  return {
    id: row.id,
    sourceVersionId: row.source_version_id,
    wordId: row.word_id,
    stage: content.stage,
    taskType: content.taskType,
    prompt: content.prompt,
    answer: content.answer,
    status: row.status,
    createdAt: row.created_at,
  }
}

const requireDraftRevision = async (
  db: D1Database,
  versionId: string,
  expectedRevision: number,
): Promise<void> => {
  const row = await db
    .prepare('SELECT status, content_revision FROM source_versions WHERE id = ?')
    .bind(versionId)
    .first<Pick<SourceVersionRow, 'status' | 'content_revision'>>()

  if (!row) {
    throw new Error(`Source version ${versionId} is missing`)
  }

  if (row.status !== 'draft') {
    throw new DomainError(
      'source_version_immutable',
      'Published source versions are immutable',
    )
  }

  if (row.content_revision !== expectedRevision) {
    throw new DomainError('conflict', 'Source version changed concurrently')
  }
}

const throwWriteConflict = async (db: D1Database, versionId: string): Promise<never> => {
  const row = await db
    .prepare('SELECT status FROM source_versions WHERE id = ?')
    .bind(versionId)
    .first<Pick<SourceVersionRow, 'status'>>()

  if (!row) {
    throw new Error(`Source version ${versionId} is missing`)
  }

  if (row.status !== 'draft') {
    throw new DomainError(
      'source_version_immutable',
      'Published source versions are immutable',
    )
  }

  throw new DomainError('conflict', 'Source version changed concurrently')
}
