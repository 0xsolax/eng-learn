import { z } from 'zod'

export type ApiSuccess<T> = {
  ok: true
  data: T
}

export type ApiFailure = {
  ok: false
  error: {
    code: string
    message: string
  }
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export const importWordRequestSchema = z.object({
  word: z.string().trim().min(1),
  meaning: z.string().trim().min(1),
  exampleSentence: z.string(),
  partOfSpeech: z.string().trim().min(1).optional(),
})

export const importSourceVersionRequestSchema = z.object({
  sourceName: z.string().trim().min(1),
  words: z.array(importWordRequestSchema).min(1),
})

export const createCourseRequestSchema = z.object({
  learnerName: z.string().trim().min(1),
  sourceVersionId: z.string().trim().min(1),
})

export const enterCourseByAccessCodeRequestSchema = z.object({
  accessCode: z.string().trim().min(1),
})

export const submitAnswerRequestSchema = z.object({
  userAnswer: z.string().trim().min(1),
})
