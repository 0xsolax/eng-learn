export type SourceVersionStatus = 'draft' | 'published' | 'archived'

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
  exampleSentence: string
  partOfSpeech?: string
}

export type ImportedSourceVersion = {
  sourceId: string
  versionId: string
  status: SourceVersionStatus
  wordCount: number
  groupCount: number
}

export type BuildCoverage = {
  sourceVersionId: string
  wordCount: number
  readyToPublish: boolean
  missingItems: Array<{
    word: string
    stage: WordStage
    reason: string
  }>
}

export type PublishedSourceVersion = {
  sourceVersionId: string
  status: 'published'
}

