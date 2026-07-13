import { describe, expect, it } from 'vitest'
import {
  adminExerciseItemSchema,
  archivedSourceVersionSchema,
  batchApprovalResultSchema,
  buildCoverageSchema,
  editExerciseItemRequestSchema,
  sourceVersionDetailSchema,
  sourceVersionSummarySchema,
  publishedSourceVersionSchema,
} from '../../shared/api/contentSchemas'

describe('content API schemas', () => {
  it('validates source version list and detail DTOs without invented fields', () => {
    const summary = {
      sourceId: 'source-1',
      sourceName: 'Starter words',
      versionId: 'version-1',
      versionNo: 1,
      status: 'draft',
      wordCount: 3,
      groupCount: 1,
      exerciseItemCount: 18,
      approvedItemCount: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
    }

    expect(sourceVersionSummarySchema.parse(summary)).toEqual(summary)
    expect(
      sourceVersionDetailSchema.parse({
        ...summary,
        readyToPublish: false,
        missingItems: [
          {
            word: 'apple',
            stage: 'S0',
            taskType: 'recognize_meaning',
            reason: 'exercise_item_draft',
          },
        ],
      }),
    ).toBeTruthy()
    expect(() => sourceVersionSummarySchema.parse({ ...summary, updatedAt: summary.createdAt })).toThrow()
  })

  it('validates a location-aware coverage matrix', () => {
    expect(
      buildCoverageSchema.parse({
        sourceVersionId: 'version-1',
        wordCount: 1,
        readyToPublish: false,
        cells: [
          {
            wordId: 'word-1',
            word: 'apple',
            stage: 'S0',
            taskType: 'recognize_meaning',
            status: 'draft',
            itemId: 'item-1',
            reason: 'exercise_item_draft',
          },
        ],
        missingItems: [
          {
            word: 'apple',
            stage: 'S0',
            taskType: 'recognize_meaning',
            reason: 'exercise_item_draft',
          },
        ],
      }),
    ).toBeTruthy()
  })

  it('keeps admin answers behind an explicit admin-only schema', () => {
    const exercise = {
      id: 'item-1',
      sourceVersionId: 'version-1',
      wordId: 'word-1',
      word: 'apple',
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning: '苹果' },
      answer: { word: 'apple' },
      status: 'draft',
    }

    expect(adminExerciseItemSchema.parse(exercise)).toEqual(exercise)
    expect(
      editExerciseItemRequestSchema.parse({
        content: {
          stage: exercise.stage,
          taskType: exercise.taskType,
          prompt: exercise.prompt,
          answer: exercise.answer,
        },
      }),
    ).toBeTruthy()
    expect(() =>
      adminExerciseItemSchema.parse({ ...exercise, prompt: { meaning: '苹果', answer: 'apple' } }),
    ).toThrow()
  })

  it('validates lifecycle mutation results without accepting undeclared data', () => {
    expect(
      publishedSourceVersionSchema.parse({
        sourceVersionId: 'version-1',
        status: 'published',
      }),
    ).toBeTruthy()
    expect(
      archivedSourceVersionSchema.parse({
        sourceVersionId: 'version-2',
        sourceId: 'source-1',
        status: 'archived',
      }),
    ).toBeTruthy()
    expect(batchApprovalResultSchema.parse({ approvedCount: 30 })).toEqual({
      approvedCount: 30,
    })
    expect(() => batchApprovalResultSchema.parse({ approvedCount: 0 })).toThrow()
  })
})
