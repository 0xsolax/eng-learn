import { describe, expect, it } from 'vitest'
import {
  exerciseItemContentSchema,
  lessonTaskSchema,
  submitTaskAnswerRequestSchema,
  taskAnswerResultSchema,
} from '../../shared/api/taskSchemas'

const baseTask = {
  id: 'task-1',
  sessionId: 'session-1',
  courseId: 'course-1',
  wordId: 'word-1',
  orderIndex: 1,
  status: 'pending' as const,
  role: 'primary' as const,
  required: false,
}

describe('shared task schemas', () => {
  it('accepts all six legal lesson task variants without an answer field', () => {
    const tasks = [
      {
        ...baseTask,
        stage: 'S0',
        taskType: 'recognize_meaning',
        prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I ate an apple.' },
      },
      {
        ...baseTask,
        stage: 'S1',
        taskType: 'recall_word',
        prompt: { meaning: '苹果' },
      },
      {
        ...baseTask,
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: '苹果', options: ['apple', 'pear', 'peach'] },
      },
      {
        ...baseTask,
        stage: 'S3',
        taskType: 'fill_blank',
        prompt: { sentence: 'I ate an ____.' },
      },
      {
        ...baseTask,
        stage: 'S4',
        taskType: 'sentence_build',
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p1', text: 'I' },
          ],
        },
      },
      {
        ...baseTask,
        stage: 'S5',
        taskType: 'sentence_output',
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
      },
    ]

    for (const task of tasks) {
      const parsed = lessonTaskSchema.parse(task)

      expect(parsed).not.toHaveProperty('answer')
    }
  })

  it('rejects a mismatched stage, malformed distractors, and duplicate piece ids', () => {
    expect(() =>
      lessonTaskSchema.parse({
        ...baseTask,
        stage: 'S1',
        taskType: 'recognize_meaning',
        prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
      }),
    ).toThrow()

    expect(() =>
      lessonTaskSchema.parse({
        ...baseTask,
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: '苹果', options: ['apple', 'apple', 'pear'] },
      }),
    ).toThrow()

    expect(() =>
      lessonTaskSchema.parse({
        ...baseTask,
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: '咖啡', options: ['café', 'cafe\u0301', 'tea'] },
      }),
    ).toThrow()

    expect(() =>
      lessonTaskSchema.parse({
        ...baseTask,
        stage: 'S4',
        taskType: 'sentence_build',
        prompt: {
          pieces: [
            { id: 'p1', text: 'I' },
            { id: 'p1', text: 'ate' },
          ],
        },
      }),
    ).toThrow()
  })

  it('accepts only the submission shape belonging to each task type', () => {
    expect(
      submitTaskAnswerRequestSchema.parse({
        taskType: 'recognize_meaning',
        response: 'known',
      }),
    ).toEqual({ taskType: 'recognize_meaning', response: 'known' })
    expect(
      submitTaskAnswerRequestSchema.parse({
        taskType: 'sentence_build',
        pieceIds: ['p1', 'p2'],
      }),
    ).toEqual({ taskType: 'sentence_build', pieceIds: ['p1', 'p2'] })
    expect(
      submitTaskAnswerRequestSchema.parse({
        taskType: 'sentence_output',
        draft: 'I ate an apple.',
        selfScore: 3,
      }),
    ).toEqual({
      taskType: 'sentence_output',
      draft: 'I ate an apple.',
      selfScore: 3,
    })

    expect(() =>
      submitTaskAnswerRequestSchema.parse({
        taskType: 'recognize_meaning',
        answer: 'apple',
      }),
    ).toThrow()
    expect(() =>
      submitTaskAnswerRequestSchema.parse({
        taskType: 'sentence_output',
        draft: 'I ate an apple.',
        selfScore: 4,
      }),
    ).toThrow()
  })

  it('bounds free-text answers and submitted piece counts', () => {
    expect(() =>
      submitTaskAnswerRequestSchema.parse({
        taskType: 'sentence_output',
        draft: 'a'.repeat(2_001),
        selfScore: 1,
      }),
    ).toThrow()
    expect(() =>
      submitTaskAnswerRequestSchema.parse({
        taskType: 'sentence_build',
        pieceIds: Array.from({ length: 101 }, (_, index) => `piece-${String(index)}`),
      }),
    ).toThrow()
  })

  it('validates answer consistency for built and edited exercise content', () => {
    expect(
      exerciseItemContentSchema.parse({
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
        answer: { word: 'apple' },
      }),
    ).toBeTruthy()

    expect(() =>
      exerciseItemContentSchema.parse({
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: '苹果', options: ['pear', 'plum', 'peach'] },
        answer: { word: 'apple' },
      }),
    ).toThrow()

    expect(() =>
      exerciseItemContentSchema.parse({
        stage: 'S4',
        taskType: 'sentence_build',
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p1', text: 'I' },
          ],
        },
        answer: { pieceIds: ['p1', 'missing'], referenceSentence: 'I ate' },
      }),
    ).toThrow()

    expect(() =>
      exerciseItemContentSchema.parse({
        stage: 'S4',
        taskType: 'sentence_build',
        prompt: {
          pieces: [
            { id: 'p2', text: 'go' },
            { id: 'p1', text: 'go' },
          ],
        },
        answer: { pieceIds: ['p1', 'p2'], referenceSentence: 'go go' },
      }),
    ).toThrow('Sentence-build prompt must visibly differ from the answer order')
  })

  it('exposes only task score and feedback in the strict answer result DTO', () => {
    const result = {
      taskId: 'task-1',
      score: 2,
      correct: true,
      feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
    }

    expect(taskAnswerResultSchema.parse(result)).toEqual(result)
    expect(() =>
      taskAnswerResultSchema.parse({
        ...result,
        wordState: { easeFactor: 1.2, masteryScore: 50 },
      }),
    ).toThrow()
  })
})
