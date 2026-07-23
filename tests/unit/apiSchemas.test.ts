import { describe, expect, it } from 'vitest'
import {
  apiResponseSchema,
  createCourseRequestSchema,
  enterCourseByAccountRequestSchema,
  enterCourseByAccessCodeRequestSchema,
  importSourceVersionCommandSchema,
  updateLearnerLoginRequestSchema,
} from '../../shared/api/schemas'
import { lessonTaskSchema } from '../../shared/api/taskSchemas'

const OPERATION_TOKEN = 'a'.repeat(64)
const IMPORT_WORD = {
  word: 'apple',
  meaning: '苹果',
  examplePhrase: 'an apple',
  exampleSentence: 'I eat an apple',
  exampleSentenceExtended: 'I eat an apple every day',
}

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
        words: [IMPORT_WORD],
      }),
    ).toBeTruthy()
    expect(() =>
      importSourceVersionCommandSchema.parse({
        sourceName: 'Ambiguous',
        words: [IMPORT_WORD],
      }),
    ).toThrow()
    expect(
      enterCourseByAccessCodeRequestSchema.parse({ accessCode: ' abcdefgh23 ' }),
    ).toEqual({ accessCode: 'ABCDEFGH23' })
    expect(() => enterCourseByAccessCodeRequestSchema.parse({ accessCode: '1234' })).toThrow()
  })

  it('normalizes the administrator-assigned learner account and accepts only a six-digit PIN', () => {
    expect(
      createCourseRequestSchema.parse({
        operationToken: OPERATION_TOKEN,
        learnerName: '小明',
        loginAccount: ' Xiao.Ming-01 ',
        pin: '123456',
        sourceVersionId: 'version-1',
      }),
    ).toEqual({
      operationToken: OPERATION_TOKEN,
      learnerName: '小明',
      loginAccount: 'xiao.ming-01',
      pin: '123456',
      sourceVersionId: 'version-1',
    })
    expect(() =>
      createCourseRequestSchema.parse({
        operationToken: OPERATION_TOKEN,
        learnerName: '小明',
        loginAccount: 'ab',
        pin: '123456',
        sourceVersionId: 'version-1',
      }),
    ).toThrow()
    expect(() =>
      createCourseRequestSchema.parse({
        operationToken: OPERATION_TOKEN,
        learnerName: '小明',
        loginAccount: 'xiaoming',
        pin: '12345a',
        sourceVersionId: 'version-1',
      }),
    ).toThrow()
  })

  it('uses the same strict account credential contract for learner login and administrator updates', () => {
    expect(
      enterCourseByAccountRequestSchema.parse({
        loginAccount: ' Student_07 ',
        pin: '654321',
      }),
    ).toEqual({ loginAccount: 'student_07', pin: '654321' })
    expect(
      updateLearnerLoginRequestSchema.parse({
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 2,
        loginAccount: ' Student_08 ',
      }),
    ).toEqual({
      operationToken: OPERATION_TOKEN,
      expectedCredentialVersion: 2,
      loginAccount: 'student_08',
    })
    expect(() =>
      updateLearnerLoginRequestSchema.parse({
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 2,
        loginAccount: 'student_08',
        pin: '123456',
        accessCode: 'ABCDEFGH23',
      }),
    ).toThrow()
  })

  it('accepts only declared learner credential errors and bounded retry details', () => {
    const schema = apiResponseSchema(lessonTaskSchema)

    expect(
      schema.parse({
        ok: false,
        error: {
          code: 'invalid_learner_credentials',
          message: 'Invalid learner credentials',
        },
      }),
    ).toBeTruthy()
    expect(
      schema.parse({
        ok: false,
        error: {
          code: 'learner_login_rate_limited',
          message: 'Too many attempts',
          details: { retryAfterSeconds: 900 },
        },
      }),
    ).toBeTruthy()
    expect(() =>
      schema.parse({
        ok: false,
        error: {
          code: 'learner_login_rate_limited',
          message: 'Too many attempts',
          details: { retryAfterSeconds: 0 },
        },
      }),
    ).toThrow()
  })

  it('bounds imported business fields before they can be persisted', () => {
    expect(() =>
      importSourceVersionCommandSchema.parse({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 's'.repeat(121),
        words: [IMPORT_WORD],
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
            examplePhrase: 'an apple',
            exampleSentence: 'I eat an apple',
            exampleSentenceExtended: 'I eat an apple every day',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      importSourceVersionCommandSchema.parse({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 'Starter',
        words: [{ ...IMPORT_WORD, examplePhrase: '' }],
      }),
    ).toThrow()
  })
})
