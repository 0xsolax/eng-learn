import type { ExerciseItemContent } from './taskSchemas'

export const containsUnicodeWholeToken = (value: string, target: string): boolean => {
  const normalizedValue = canonicalizeTaskSafetyInspectionText(value)
  const normalizedTarget = canonicalizeTaskSafetyInspectionText(target)

  if (!normalizedTarget) return false

  return new RegExp(
    `(^|[^\\p{L}\\p{M}\\p{N}_])${escapeRegularExpression(normalizedTarget)}(?=$|[^\\p{L}\\p{M}\\p{N}_])`,
    'iu',
  ).test(normalizedValue)
}

export const normalizeTaskSafetyText = (value: string): string =>
  value.normalize('NFC').replace(/\s+/gu, ' ').trim()

export const canonicalizeLearningText = (value: string): string =>
  normalizeTaskSafetyText(value).toLowerCase()

export const containsNormalizedTaskText = (value: string, target: string): boolean => {
  const normalizedValue = canonicalizeTaskSafetyInspectionText(value)
  const normalizedTarget = canonicalizeTaskSafetyInspectionText(target)

  return normalizedTarget.length > 0 && normalizedValue.includes(normalizedTarget)
}

export const learnerPromptRevealsAnswer = (
  content: ExerciseItemContent,
  owningWord: string,
): boolean => {
  if (content.taskType === 'recall_word' || content.taskType === 'multiple_choice') {
    return containsUnicodeWholeToken(content.prompt.meaning, owningWord)
  }

  if (content.taskType === 'sentence_output') {
    const referenceSentence = content.answer.referenceSentence

    return (
      containsUnicodeWholeToken(content.prompt.meaning, owningWord) ||
      containsUnicodeWholeToken(content.prompt.instruction, owningWord) ||
      containsNormalizedTaskText(content.prompt.meaning, referenceSentence) ||
      containsNormalizedTaskText(content.prompt.instruction, referenceSentence)
    )
  }

  return false
}

const canonicalizeTaskSafetyInspectionText = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
