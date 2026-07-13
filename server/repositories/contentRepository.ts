import type {
  ExerciseItemStatus,
  SourceVersionSummary,
  SourceVersionStatus,
  TaskType,
  WordStage,
} from '../../shared/domain/content'
import type { CreateSourceAdminOperation } from './adminOperationLedger'

export type SourceRecord = {
  id: string
  name: string
  createdAt: string
}

export type SourceVersionRecord = {
  id: string
  sourceId: string
  versionNo: number
  contentRevision: number
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
  source?: SourceRecord
  version: SourceVersionRecord
  words: WordRecord[]
  groups: WordGroupRecord[]
  adminOperation?: CreateSourceAdminOperation
}

export type ContentRepository = {
  createSourceVersion(input: CreateSourceVersionInput): Promise<SourceVersionSnapshot>
  getSource(sourceId: string): Promise<SourceRecord | undefined>
  listSourceVersions(): Promise<SourceVersionSummary[]>
  listSourceVersionsBySource(sourceId: string): Promise<SourceVersionRecord[]>
  getSourceVersion(versionId: string): Promise<SourceVersionSnapshot | undefined>
  addExerciseItems(
    versionId: string,
    items: ExerciseItemRecord[],
    expectedRevision: number,
  ): Promise<number>
  getExerciseItem(itemId: string): Promise<ExerciseItemRecord | undefined>
  getExerciseItems(itemIds: string[]): Promise<ExerciseItemRecord[]>
  updateExerciseItems(
    versionId: string,
    items: ExerciseItemRecord[],
    expectedRevision: number,
  ): Promise<number>
  publishSourceVersion(
    versionId: string,
    publishedAt: string,
    expectedRevision: number,
  ): Promise<SourceVersionRecord>
  archiveDraftVersion(versionId: string, expectedRevision: number): Promise<SourceVersionRecord>
}
