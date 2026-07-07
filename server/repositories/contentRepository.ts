import type {
  ExerciseItemStatus,
  SourceVersionStatus,
  TaskType,
  WordStage,
} from '../../shared/domain/content'

export type SourceRecord = {
  id: string
  name: string
  createdAt: string
}

export type SourceVersionRecord = {
  id: string
  sourceId: string
  versionNo: number
  status: SourceVersionStatus
  createdAt: string
  publishedAt?: string
}

export type WordRecord = {
  id: string
  sourceVersionId: string
  orderIndex: number
  word: string
  meaning: string
  exampleSentence: string
  partOfSpeech?: string
  createdAt: string
}

export type WordGroupRecord = {
  id: string
  sourceVersionId: string
  groupIndex: number
  startOrderIndex: number
  endOrderIndex: number
  createdAt: string
}

export type ExercisePackRecord = {
  id: string
  sourceVersionId: string
  wordId: string
  status: ExerciseItemStatus
  createdAt: string
}

export type ExerciseItemRecord = {
  id: string
  sourceVersionId: string
  wordId: string
  stage: WordStage
  taskType: TaskType
  prompt: unknown
  answer: unknown
  status: ExerciseItemStatus
  createdAt: string
}

export type SourceVersionSnapshot = {
  source: SourceRecord
  version: SourceVersionRecord
  words: WordRecord[]
  groups: WordGroupRecord[]
  exerciseItems: ExerciseItemRecord[]
}

export type CreateSourceVersionInput = {
  source: SourceRecord
  version: SourceVersionRecord
  words: WordRecord[]
  groups: WordGroupRecord[]
}

export type ContentRepository = {
  createSourceVersion(input: CreateSourceVersionInput): Promise<SourceVersionSnapshot>
  getSourceVersion(versionId: string): Promise<SourceVersionSnapshot | undefined>
  replaceExerciseItems(versionId: string, items: ExerciseItemRecord[]): Promise<void>
  publishSourceVersion(versionId: string, publishedAt: string): Promise<SourceVersionRecord>
}

