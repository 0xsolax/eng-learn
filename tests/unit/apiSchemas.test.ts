import { describe, expect, it } from 'vitest'
import {
  apiResponseSchema,
  enterCourseByAccessCodeRequestSchema,
  importSourceVersionCommandSchema,
} from '../../shared/api/schemas'
import { lessonTaskSchema } from '../../shared/api/taskSchemas'

const OPERATION_TOKEN = 'a'.repeat(64)

describe('API envelope schemas', () => {
  it('validates success data at the client boundary', () => {
    const schema = apiResponseSchema(lessonTaskSchema)
    const validTask = {
      id: 'task-1',
      sessionId: 'session-1',
      courseId: 'course-1',
      wordId: 'word-1',
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning: '苹果' },
      orderIndex: 1,
      status: 'pending',
      role: 'primary',
      required: false,
    }

    expect(schema.parse({ ok: true, data: validTask })).toEqual({
      ok: true,
      data: validTask,
    })
    expect(() =>
      schema.parse({
        ok: true,
        data: { ...validTask, prompt: { answer: 'apple' } },
      }),
    ).toThrow()
  })

  it('validates machine-readable field and lesson blockers', () => {
    const schema = apiResponseSchema(lessonTaskSchema)

    expect(
      schema.parse({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: {
            fields: [{ path: 'words.2.meaning', message: 'Required' }],
          },
        },
      }),
    ).toBeTruthy()
    expect(
      schema.parse({
        ok: false,
        error: {
          code: 'lesson_incomplete',
          message: 'Required practice remains',
          details: {
            completedPrimary: 5,
            totalPrimary: 5,
            pendingRequiredTaskIds: ['reflux-1'],
          },
        },
      }),
    ).toBeTruthy()

    expect(() =>
      schema.parse({
        ok: false,
        error: {
          code: 'lesson_incomplete',
          message: 'Required practice remains',
          details: { pendingRequiredTaskIds: 'reflux-1' },
        },
      }),
    ).toThrow()
  })

  it('rejects unknown error codes and undeclared error details', () => {
    const schema = apiResponseSchema(lessonTaskSchema)

    expect(() =>
      schema.parse({
        ok: false,
        error: { code: 'whatever_happened', message: 'Unknown' },
      }),
    ).toThrow()
    expect(() =>
      schema.parse({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Unauthorized',
          details: { secret: 'must not pass through' },
        },
      }),
    ).toThrow()
  })

  it('requires explicit import intent and normalizes the fixed learning-code format', () => {
    expect(
      importSourceVersionCommandSchema.parse({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 'Starter',
        words: [{ word: 'apple', meaning: '苹果', exampleSentence: '' }],
      }),
    ).toBeTruthy()
    expect(() =>
      importSourceVersionCommandSchema.parse({
        sourceName: 'Ambiguous',
        words: [{ word: 'apple', meaning: '苹果', exampleSentence: '' }],
      }),
    ).toThrow()
    expect(
      enterCourseByAccessCodeRequestSchema.parse({ accessCode: ' abcdefgh23 ' }),
    ).toEqual({ accessCode: 'ABCDEFGH23' })
    expect(() => enterCourseByAccessCodeRequestSchema.parse({ accessCode: '1234' })).toThrow()
  })

  it('bounds imported business fields before they can be persisted', () => {
    expect(() =>
      importSourceVersionCommandSchema.parse({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 's'.repeat(121),
        words: [{ word: 'apple', meaning: '苹果', exampleSentence: '' }],
      }),
    ).toThrow()
    expect(() =>
      importSourceVersionCommandSchema.parse({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 'Starter',
        words: [
          {
            word: 'apple',
            meaning: 'm'.repeat(501),
            exampleSentence: '',
          },
        ],
      }),
    ).toThrow()
  })
})
