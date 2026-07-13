import { z } from 'zod'
import {
  exerciseItemContentSchema,
  fillBlankPromptSchema,
  multipleChoicePromptSchema,
  recallWordPromptSchema,
  recognizeMeaningPromptSchema,
  type ExerciseItemContent,
} from '../../shared/api/taskSchemas'
import { canonicalizeLearningText } from '../../shared/api/taskContentSafety'
import { PersistedContentCompatibilityError } from '../errors/PersistedContentCompatibilityError'

const legacyText = z.string().trim().min(1).max(2_000)
const legacyUntrimmedText = z.string().max(2_000)
const legacyAnswerSchema = z
  .object({
    word: legacyText,
    meaning: legacyText,
  })
  .strict()

const legacyExerciseItemContentSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      stage: z.literal('S0'),
      taskType: z.literal('recognize_meaning'),
      prompt: recognizeMeaningPromptSchema,
      answer: legacyAnswerSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('S1'),
      taskType: z.literal('recall_word'),
      prompt: recallWordPromptSchema,
      answer: legacyAnswerSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('S2'),
      taskType: z.literal('multiple_choice'),
      prompt: multipleChoicePromptSchema,
      answer: legacyAnswerSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('S3'),
      taskType: z.literal('fill_blank'),
      prompt: z.object({ sentence: legacyUntrimmedText }).strict(),
      answer: legacyAnswerSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('S4'),
      taskType: z.literal('sentence_build'),
      prompt: z
        .object({ pieces: z.array(legacyUntrimmedText).min(1).max(100) })
        .strict(),
      answer: legacyAnswerSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal('S5'),
      taskType: z.literal('sentence_output'),
      prompt: recallWordPromptSchema,
      answer: legacyAnswerSchema,
    })
    .strict(),
])

export type PersistedWordContext = {
  word: string
  exampleSentence: string
}

export const parsePersistedExerciseItemContent = (
  input: unknown,
  wordContext?: PersistedWordContext,
): ExerciseItemContent => {
  const current = exerciseItemContentSchema.safeParse(input)

  if (current.success) {
    return current.data
  }

  const legacy = legacyExerciseItemContentSchema.safeParse(input)

  if (!legacy.success) {
    throw current.error
  }

  if (
    wordContext === undefined ||
    normalizeText(legacy.data.answer.word) !== normalizeText(wordContext.word)
  ) {
    throw new PersistedContentCompatibilityError('answer_word_mismatch')
  }

  const legacyContent = legacy.data

  switch (legacyContent.taskType) {
    case 'recognize_meaning':
      return exerciseItemContentSchema.parse({
        stage: legacyContent.stage,
        taskType: legacyContent.taskType,
        prompt: legacyContent.prompt,
        answer: {
          word: legacyContent.answer.word,
          expectedResponse: 'known',
        },
      })
    case 'recall_word':
    case 'multiple_choice':
      return exerciseItemContentSchema.parse({
        stage: legacyContent.stage,
        taskType: legacyContent.taskType,
        prompt: legacyContent.prompt,
        answer: { word: legacyContent.answer.word },
      })
    case 'fill_blank': {
      const sentence = blankWholeWordOccurrences(
        legacyContent.prompt.sentence,
        wordContext.word,
      )
      const recoverableSentence = sentence.includes('____')
        ? sentence
        : blankWholeWordOccurrences(wordContext.exampleSentence, wordContext.word)

      if (!recoverableSentence.includes('____')) {
        throw new PersistedContentCompatibilityError('fill_blank_not_recoverable')
      }

      const prompt = fillBlankPromptSchema.parse({ sentence: recoverableSentence })

      return exerciseItemContentSchema.parse({
        stage: legacyContent.stage,
        taskType: legacyContent.taskType,
        prompt,
        answer: { word: legacyContent.answer.word },
      })
    }
    case 'sentence_build': {
      if (legacyContent.prompt.pieces.some((piece) => piece.trim().length === 0)) {
        throw new PersistedContentCompatibilityError('sentence_build_empty_piece')
      }

      const answerTexts = legacyContent.prompt.pieces
      const visibleTexts = [...answerTexts].reverse()

      if (
        answerTexts.length < 2 ||
        visibleTexts.every((text, index) => text === answerTexts[index])
      ) {
        throw new PersistedContentCompatibilityError('sentence_build_not_shufflable')
      }

      const referenceSentence = wordContext.exampleSentence.trim()

      if (normalizeSentence(answerTexts.join(' ')) !== normalizeSentence(referenceSentence)) {
        throw new PersistedContentCompatibilityError('sentence_build_reference_mismatch')
      }

      const answerPieces = answerTexts.map((text, index) => ({
        id: createStableOpaquePieceId(wordContext.word, text, index),
        text,
      }))

      return exerciseItemContentSchema.parse({
        stage: legacyContent.stage,
        taskType: legacyContent.taskType,
        prompt: { pieces: [...answerPieces].reverse() },
        answer: {
          pieceIds: answerPieces.map((piece) => piece.id),
          referenceSentence,
        },
      })
    }
    case 'sentence_output': {
      const referenceSentence = wordContext.exampleSentence.trim()

      if (!referenceSentence) {
        throw new PersistedContentCompatibilityError('sentence_output_reference_missing')
      }

      return exerciseItemContentSchema.parse({
        stage: legacyContent.stage,
        taskType: legacyContent.taskType,
        prompt: {
          meaning: legacyContent.prompt.meaning,
          instruction: 'Write one complete English sentence.',
        },
        answer: { referenceSentence },
      })
    }
  }
}

const normalizeText = canonicalizeLearningText

const normalizeSentence = canonicalizeLearningText

const blankWholeWordOccurrences = (sentence: string, word: string): string => {
  const target = word.trim()

  if (!target) return sentence

  return sentence.replace(
    new RegExp(
      `(^|[^\\p{L}\\p{M}\\p{N}_])${escapeRegularExpression(target)}(?=$|[^\\p{L}\\p{M}\\p{N}_])`,
      'giu',
    ),
    (_match, leadingBoundary: string) => `${leadingBoundary}____`,
  )
}

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const createStableOpaquePieceId = (word: string, text: string, index: number): string => {
  const seed = `${word}\u0000${String(index)}\u0000${text}`
  let first = 2_166_136_261
  let second = 2_654_435_761

  for (const character of seed) {
    const codePoint = character.codePointAt(0) ?? 0
    first = Math.imul(first ^ codePoint, 16_777_619)
    second = Math.imul(second ^ codePoint, 2_246_822_519)
  }

  return `legacy-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}
