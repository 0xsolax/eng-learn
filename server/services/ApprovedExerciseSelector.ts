import type { WordStage } from '../../shared/domain/content'
import type {
  ExerciseItemRecord,
  SourceVersionSnapshot,
} from '../repositories/contentRepository'

export const selectApprovedExerciseItem = (
  sourceVersion: SourceVersionSnapshot,
  wordId: string,
  stage: WordStage,
): ExerciseItemRecord | undefined => {
  const expectedTaskType = expectedTaskTypeForStage(
    sourceVersion.version.contentModel,
    stage,
  )

  return sourceVersion.exerciseItems
    .filter(
      (item) =>
        item.wordId === wordId &&
        item.stage === stage &&
        item.taskType === expectedTaskType &&
        item.status === 'approved',
    )
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )[0]
}

const expectedTaskTypeForStage = (
  contentModel: SourceVersionSnapshot['version']['contentModel'],
  stage: WordStage,
): ExerciseItemRecord['taskType'] => {
  if (stage === 'S0') return 'recognize_meaning'
  if (stage === 'S1') {
    return contentModel === 'v2_progressive_context'
      ? 'multiple_choice'
      : 'recall_word'
  }
  if (stage === 'S2') {
    return contentModel === 'v2_progressive_context'
      ? 'recall_word'
      : 'multiple_choice'
  }
  if (stage === 'S3') return 'fill_blank'
  if (stage === 'S4') return 'sentence_build'

  return 'sentence_output'
}
