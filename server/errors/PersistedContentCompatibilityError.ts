import { learnerPromptRevealsAnswer } from '../../shared/api/taskContentSafety'
import type { ExerciseItemContent } from '../../shared/api/taskSchemas'
import { DomainError } from './DomainError'

export type LegacyContentIncompatibilityReason =
  | 'answer_word_mismatch'
  | 'meaning_reveals_answer'
  | 'prompt_reveals_reference'
  | 'fill_blank_not_recoverable'
  | 'sentence_build_empty_piece'
  | 'sentence_build_not_shufflable'
  | 'sentence_build_reference_mismatch'
  | 'sentence_output_reference_missing'

export class PersistedContentCompatibilityError extends DomainError {
  constructor(readonly reason: LegacyContentIncompatibilityReason) {
    super('legacy_content_incompatible', 'Course content is temporarily unavailable')
    this.name = 'PersistedContentCompatibilityError'
  }
}

export const requireLearnerSafeExerciseItemContent = (
  content: ExerciseItemContent,
  owningWord: string,
): void => {
  if (learnerPromptRevealsAnswer(content, owningWord)) {
    throw new PersistedContentCompatibilityError(
      content.taskType === 'sentence_output'
        ? 'prompt_reveals_reference'
        : 'meaning_reveals_answer',
    )
  }
}
