import { z } from 'zod'
import { canonicalizeLearningText } from './taskContentSafety'

export const wordStageSchema = z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5'])
export const taskTypeSchema = z.enum([
  'recognize_meaning',
  'recall_word',
  'multiple_choice',
  'fill_blank',
  'sentence_build',
  'sentence_output',
])
export const lessonTaskRoleSchema = z.enum(['primary', 'bridge', 'reflux'])
export const lessonTaskStatusSchema = z.enum(['pending', 'completed', 'skipped'])

const nonEmptyText = z.string().trim().min(1).max(2_000)

export const recognizeMeaningPromptSchema = z
  .object({
    word: nonEmptyText,
    meaning: nonEmptyText,
    exampleSentence: z.string(),
  })
  .strict()

export const recallWordPromptSchema = z
  .object({
    meaning: nonEmptyText,
  })
  .strict()

export const multipleChoicePromptSchema = z
  .object({
    meaning: nonEmptyText,
    options: z
      .array(nonEmptyText)
      .min(3)
      .max(10)
      .refine(
        (options) => new Set(options.map(canonicalizeLearningText)).size === options.length,
        {
        message: 'Multiple-choice options must be unique',
        },
      ),
  })
  .strict()

export const fillBlankPromptSchema = z
  .object({
    sentence: nonEmptyText.refine((sentence) => sentence.includes('____'), {
      message: 'Fill-blank sentence must contain a blank marker',
    }),
  })
  .strict()

export const sentencePieceSchema = z
  .object({
    id: nonEmptyText,
    text: nonEmptyText,
  })
  .strict()

export const sentenceBuildPromptSchema = z
  .object({
    pieces: z
      .array(sentencePieceSchema)
      .min(2)
      .max(100)
      .refine((pieces) => new Set(pieces.map((piece) => piece.id)).size === pieces.length, {
        message: 'Sentence piece ids must be unique',
      }),
  })
  .strict()

export const sentenceOutputPromptSchema = z
  .object({
    meaning: nonEmptyText,
    instruction: nonEmptyText,
  })
  .strict()

export const sentenceOutputPreviewStateSchema = z
  .object({
    draft: nonEmptyText,
    referenceSentence: nonEmptyText,
    revealedAt: z.iso.datetime(),
  })
  .strict()

const taskRenderBase = {
  id: nonEmptyText,
}

export const taskRenderSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      ...taskRenderBase,
      stage: z.literal('S0'),
      taskType: z.literal('recognize_meaning'),
      prompt: recognizeMeaningPromptSchema,
    })
    .strict(),
  z
    .object({
      ...taskRenderBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('recall_word'),
      prompt: recallWordPromptSchema,
    })
    .strict(),
  z
    .object({
      ...taskRenderBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('multiple_choice'),
      prompt: multipleChoicePromptSchema,
    })
    .strict(),
  z
    .object({
      ...taskRenderBase,
      stage: z.literal('S3'),
      taskType: z.literal('fill_blank'),
      prompt: fillBlankPromptSchema,
    })
    .strict(),
  z
    .object({
      ...taskRenderBase,
      stage: z.literal('S4'),
      taskType: z.literal('sentence_build'),
      prompt: sentenceBuildPromptSchema,
    })
    .strict(),
  z
    .object({
      ...taskRenderBase,
      stage: z.literal('S5'),
      taskType: z.literal('sentence_output'),
      prompt: sentenceOutputPromptSchema,
      preview: sentenceOutputPreviewStateSchema.optional(),
    })
    .strict(),
])

const lessonTaskBase = {
  id: nonEmptyText,
  sessionId: nonEmptyText,
  courseId: nonEmptyText,
  wordId: nonEmptyText,
  orderIndex: z.number().int().positive(),
  status: lessonTaskStatusSchema,
  role: lessonTaskRoleSchema,
  required: z.boolean(),
  refluxSourceTaskId: nonEmptyText.optional(),
}

export const lessonTaskSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      ...lessonTaskBase,
      stage: z.literal('S0'),
      taskType: z.literal('recognize_meaning'),
      prompt: recognizeMeaningPromptSchema,
    })
    .strict(),
  z
    .object({
      ...lessonTaskBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('recall_word'),
      prompt: recallWordPromptSchema,
    })
    .strict(),
  z
    .object({
      ...lessonTaskBase,
      stage: z.union([z.literal('S1'), z.literal('S2')]),
      taskType: z.literal('multiple_choice'),
      prompt: multipleChoicePromptSchema,
    })
    .strict(),
  z
    .object({
      ...lessonTaskBase,
      stage: z.literal('S3'),
      taskType: z.literal('fill_blank'),
      prompt: fillBlankPromptSchema,
    })
    .strict(),
  z
    .object({
      ...lessonTaskBase,
      stage: z.literal('S4'),
      taskType: z.literal('sentence_build'),
      prompt: sentenceBuildPromptSchema,
    })
    .strict(),
  z
    .object({
      ...lessonTaskBase,
      stage: z.literal('S5'),
      taskType: z.literal('sentence_output'),
      prompt: sentenceOutputPromptSchema,
      preview: sentenceOutputPreviewStateSchema.optional(),
    })
    .strict(),
])

export const submitTaskAnswerRequestSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      taskType: z.literal('recognize_meaning'),
      response: z.enum(['known', 'learning']),
    })
    .strict(),
  z.object({ taskType: z.literal('recall_word'), answer: nonEmptyText }).strict(),
  z.object({ taskType: z.literal('multiple_choice'), answer: nonEmptyText }).strict(),
  z.object({ taskType: z.literal('fill_blank'), answer: nonEmptyText }).strict(),
  z
    .object({
      taskType: z.literal('sentence_build'),
      pieceIds: z
        .array(nonEmptyText)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: 'Submitted sentence piece ids must be unique',
        }),
    })
    .strict(),
  z
    .object({
      taskType: z.literal('sentence_output'),
      draft: nonEmptyText,
      selfScore: z.number().int().min(0).max(3),
    })
    .strict(),
])

export const previewSentenceOutputRequestSchema = z
  .object({
    taskType: z.literal('sentence_output'),
    draft: nonEmptyText,
  })
  .strict()

export const sentenceOutputPreviewSchema = sentenceOutputPreviewStateSchema.extend({
  taskId: nonEmptyText,
})

export const taskAnswerFeedbackSchema = z.discriminatedUnion('taskType', [
  z
    .object({
      taskType: z.literal('recognize_meaning'),
      response: z.enum(['known', 'learning']),
    })
    .strict(),
  z
    .object({
      taskType: z.enum(['recall_word', 'multiple_choice', 'fill_blank']),
      correctAnswer: nonEmptyText,
    })
    .strict(),
  z
    .object({
      taskType: z.literal('sentence_build'),
      correctPieceIds: z.array(nonEmptyText).min(1),
      referenceSentence: nonEmptyText,
    })
    .strict(),
  z
    .object({
      taskType: z.literal('sentence_output'),
      referenceSentence: nonEmptyText,
      selfScore: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    })
    .strict(),
])

export const reviewScoreSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
])

export const taskAnswerResultSchema = z
  .object({
    taskId: nonEmptyText,
    score: reviewScoreSchema,
    correct: z.boolean(),
    feedback: taskAnswerFeedbackSchema,
  })
  .strict()

const exerciseItemContentBase = {
  stage: wordStageSchema,
  taskType: taskTypeSchema,
}

export const exerciseItemContentSchema = z
  .discriminatedUnion('taskType', [
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.literal('S0'),
        taskType: z.literal('recognize_meaning'),
        prompt: recognizeMeaningPromptSchema,
        answer: z
          .object({
            word: nonEmptyText,
            expectedResponse: z.literal('known'),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.union([z.literal('S1'), z.literal('S2')]),
        taskType: z.literal('recall_word'),
        prompt: recallWordPromptSchema,
        answer: z.object({ word: nonEmptyText }).strict(),
      })
      .strict(),
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.union([z.literal('S1'), z.literal('S2')]),
        taskType: z.literal('multiple_choice'),
        prompt: multipleChoicePromptSchema,
        answer: z.object({ word: nonEmptyText }).strict(),
      })
      .strict(),
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.literal('S3'),
        taskType: z.literal('fill_blank'),
        prompt: fillBlankPromptSchema,
        answer: z.object({ word: nonEmptyText }).strict(),
      })
      .strict(),
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.literal('S4'),
        taskType: z.literal('sentence_build'),
        prompt: sentenceBuildPromptSchema,
        answer: z
          .object({
            pieceIds: z.array(nonEmptyText).min(2),
            referenceSentence: nonEmptyText,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...exerciseItemContentBase,
        stage: z.literal('S5'),
        taskType: z.literal('sentence_output'),
        prompt: sentenceOutputPromptSchema,
        answer: z.object({ referenceSentence: nonEmptyText }).strict(),
      })
      .strict(),
  ])
  .superRefine((content, context) => {
    if (content.taskType === 'multiple_choice') {
      const normalizedAnswer = canonicalizeLearningText(content.answer.word)

      if (
        !content.prompt.options.some(
          (option) => canonicalizeLearningText(option) === normalizedAnswer,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answer', 'word'],
          message: 'Multiple-choice answer must be one of the options',
        })
      }
    }

    if (content.taskType === 'sentence_build') {
      const promptPieceIds = new Set(content.prompt.pieces.map((piece) => piece.id))
      const answerPieceIds = content.answer.pieceIds

      if (
        new Set(answerPieceIds).size !== answerPieceIds.length ||
        answerPieceIds.length !== promptPieceIds.size ||
        answerPieceIds.some((pieceId) => !promptPieceIds.has(pieceId))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answer', 'pieceIds'],
          message: 'Sentence-build answer must use every prompt piece exactly once',
        })

        return
      }

      const piecesById = new Map(
        content.prompt.pieces.map((piece) => [piece.id, piece.text] as const),
      )
      const answerTexts = answerPieceIds.map((pieceId) => piecesById.get(pieceId))
      const visibleOrderIsUnchanged = content.prompt.pieces.every(
        (piece, index) => piece.text === answerTexts[index],
      )

      if (visibleOrderIsUnchanged) {
        context.addIssue({
          code: 'custom',
          path: ['prompt', 'pieces'],
          message: 'Sentence-build prompt must visibly differ from the answer order',
        })
      }
    }
  })

export type LessonTaskDto = z.infer<typeof lessonTaskSchema>
export type TaskRenderDto = z.infer<typeof taskRenderSchema>
export type LessonTaskRole = z.infer<typeof lessonTaskRoleSchema>
export type SubmitTaskAnswerRequest = z.infer<typeof submitTaskAnswerRequestSchema>
export type ExerciseItemContent = z.infer<typeof exerciseItemContentSchema>
export type SentenceOutputPreviewRequest = z.infer<typeof previewSentenceOutputRequestSchema>
export type SentenceOutputPreview = z.infer<typeof sentenceOutputPreviewSchema>
export type TaskAnswerFeedback = z.infer<typeof taskAnswerFeedbackSchema>
export type TaskAnswerResult = z.infer<typeof taskAnswerResultSchema>
