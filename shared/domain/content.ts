export type SourceVersionStatus = 'draft' | 'published' | 'archived'

export type ContentModel = 'v1_single_sentence' | 'v2_progressive_context'

export type ExerciseItemStatus = 'draft' | 'approved' | 'disabled'

export type WordStage = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

export type TaskType =
  | 'recognize_meaning'
  | 'recall_word'
  | 'multiple_choice'
  | 'fill_blank'
  | 'sentence_build'
  | 'sentence_output'

export type ImportWordInput = {
  word: string
  meaning: string
  examplePhrase: string
  exampleSentence: string
  exampleSentenceExtended: string
  partOfSpeech?: string
}

export type ImportedSourceVersion = {
  sourceId: string
  versionId: string
  versionNo: number
  status: SourceVersionStatus
  wordCount: number
  groupCount: number
}

export type CoverageBlockReason =
  | 'exercise_item_required'
  | 'exercise_item_draft'
  | 'exercise_item_disabled'
  | 'exercise_item_invalid'
  | 'example_sentence_required'
  | 'distractors_required'
  | 'sentence_pieces_required'

export type CoverageCell = {
  wordId: string
  word: string
  stage: WordStage
  taskType: TaskType
  status: ExerciseItemStatus | 'missing'
  itemId?: string
  reason?: CoverageBlockReason
}

export type BuildCoverage = {
  sourceVersionId: string
  wordCount: number
  readyToPublish: boolean
  cells: CoverageCell[]
  missingItems: Array<{
    word: string
    stage: WordStage
    taskType: TaskType
    reason: CoverageBlockReason
  }>
}

export type ExerciseItemView = {
  id: string
  sourceVersionId: string
  wordId: string
  word: string
  stage: WordStage
  taskType: TaskType
  prompt: unknown
  answer: unknown
  status: ExerciseItemStatus
}

export type SourceVersionSummary = {
  sourceId: string
  sourceName: string
  versionId: string
  versionNo: number
  status: SourceVersionStatus
  wordCount: number
  groupCount: number
  exerciseItemCount: number
  approvedItemCount: number
  createdAt: string
  publishedAt?: string
}

export type SourceVersionDetail = SourceVersionSummary & {
  readyToPublish: boolean
  missingItems: BuildCoverage['missingItems']
}

export type PublishedSourceVersion = {
  sourceVersionId: string
  status: 'published'
}

export type ArchivedSourceVersion = {
  sourceVersionId: string
  sourceId: string
  status: 'archived'
}
