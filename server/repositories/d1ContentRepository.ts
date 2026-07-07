import type {
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

type SourceRow = {
  id: string
  name: string
  created_at: string
}

type SourceVersionRow = {
  id: string
  source_id: string
  version_no: number
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
}

export const createD1ContentRepository = (db: D1Database): ContentRepository => ({
  async createSourceVersion(input: CreateSourceVersionInput) {
    await db.batch([
      db
        .prepare('INSERT INTO word_sources (id, name, created_at) VALUES (?, ?, ?)')
        .bind(input.source.id, input.source.name, input.source.createdAt),
      db
        .prepare(
          'INSERT INTO source_versions (id, source_id, version_no, status, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          input.version.id,
          input.version.sourceId,
          input.version.versionNo,
          input.version.status,
          input.version.createdAt,
        ),
      ...input.words.map((word) =>
        db
          .prepare(
            'INSERT INTO words (id, source_version_id, order_index, word, meaning, example_sentence, part_of_speech, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            word.id,
            word.sourceVersionId,
            word.orderIndex,
            word.word,
            word.meaning,
            word.exampleSentence,
            word.partOfSpeech ?? null,
            word.createdAt,
          ),
      ),
      ...input.groups.map((group) =>
        db
          .prepare(
            'INSERT INTO word_groups (id, source_version_id, group_index, start_order_index, end_order_index, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(
            group.id,
            group.sourceVersionId,
            group.groupIndex,
            group.startOrderIndex,
            group.endOrderIndex,
            group.createdAt,
          ),
      ),
    ])

    const snapshot = await getSourceVersionSnapshot(db, input.version.id)

    if (!snapshot) {
      throw new Error(`Source version ${input.version.id} was not created`)
    }

    return snapshot
  },

  async getSourceVersion(versionId: string) {
    return getSourceVersionSnapshot(db, versionId)
  },

  async replaceExerciseItems(versionId: string, items: ExerciseItemRecord[]) {
    const wordIds = Array.from(new Set(items.map((item) => item.wordId)))
    const packCreatedAt = items[0]?.createdAt ?? new Date().toISOString()

    await db.batch([
      db.prepare('DELETE FROM exercise_items WHERE source_version_id = ?').bind(versionId),
      db.prepare('DELETE FROM exercise_packs WHERE source_version_id = ?').bind(versionId),
      ...wordIds.map((wordId) =>
        db
          .prepare(
            'INSERT INTO exercise_packs (id, source_version_id, word_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(crypto.randomUUID(), versionId, wordId, 'approved', packCreatedAt),
      ),
      ...items.map((item) =>
        db
          .prepare(
            'INSERT INTO exercise_items (id, source_version_id, word_id, stage, task_type, prompt_json, answer_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            item.id,
            item.sourceVersionId,
            item.wordId,
            item.stage,
            item.taskType,
            JSON.stringify(item.prompt),
            JSON.stringify(item.answer),
            item.status,
            item.createdAt,
          ),
      ),
    ])
  },

  async publishSourceVersion(versionId: string, publishedAt: string) {
    await db
      .prepare('UPDATE source_versions SET status = ?, published_at = ? WHERE id = ?')
      .bind('published', publishedAt, versionId)
      .run()

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

  return {
    source: mapSource(source),
    version: mapSourceVersion(version),
    words: words.results.map(mapWord),
    groups: groups.results.map(mapWordGroup),
    exerciseItems: exerciseItems.results.map(mapExerciseItem),
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
  status: row.status,
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

const mapExerciseItem = (row: ExerciseItemRow): ExerciseItemRecord => ({
  id: row.id,
  sourceVersionId: row.source_version_id,
  wordId: row.word_id,
  stage: row.stage,
  taskType: row.task_type,
  prompt: JSON.parse(row.prompt_json) as unknown,
  answer: JSON.parse(row.answer_json) as unknown,
  status: row.status,
  createdAt: row.created_at,
})
