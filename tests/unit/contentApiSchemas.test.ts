import { describe, expect, it } from 'vitest'
import {
  adminExerciseItemSchema,
  archivedSourceVersionSchema,
  batchApprovalResultSchema,
  buildCoverageSchema,
  editExerciseItemRequestSchema,
  exerciseReviewDecisionRequestSchema,
  exerciseReviewDecisionResultSchema,
  exerciseReviewEvaluateRequestSchema,
  exerciseReviewEvaluateResultSchema,
  exerciseReviewPreviewRequestSchema,
  exerciseReviewPreviewResultSchema,
  exerciseReviewWindowSchema,
  sourceVersionDetailSchema,
  sourceVersionSummarySchema,
  publishedSourceVersionSchema,
} from '../../shared/api/contentSchemas'
import { importSourceVersionCommandSchema } from '../../shared/api/schemas'

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

  it('keeps the review window prompt-only and rejects learner runtime fields', () => {
    const reviewWindow = {
      sourceVersionId: 'version-1',
      sourceName: 'Starter words',
      versionNo: 1,
      contentRevision: 7,
      totalCount: 1,
      approvedCount: 0,
      pendingCount: 1,
      needsReworkCount: 0,
      disabledCount: 0,
      allApproved: false,
      firstItemId: 'item-1',
      current: {
        id: 'item-1',
        wordId: 'word-1',
        word: 'apple',
        wordOrderIndex: 1,
        position: 1,
        stage: 'S2',
        taskType: 'recall_word',
        status: 'draft',
        reviewState: 'pending_review',
        prompt: { meaning: '苹果' },
      },
    }

    expect(exerciseReviewWindowSchema.parse(reviewWindow)).toEqual(reviewWindow)
    expect(() =>
      exerciseReviewWindowSchema.parse({
        ...reviewWindow,
        current: { ...reviewWindow.current, answer: { word: 'apple' } },
      }),
    ).toThrow()
    expect(() =>
      exerciseReviewWindowSchema.parse({
        ...reviewWindow,
        current: { ...reviewWindow.current, courseId: 'course-1' },
      }),
    ).toThrow()
  })

  it('validates strict review preview, evaluate, and decision contracts', () => {
    expect(
      exerciseReviewPreviewRequestSchema.parse({
        expectedContentRevision: 7,
        taskType: 'sentence_output',
        draft: 'I eat an apple.',
      }),
    ).toBeTruthy()
    expect(
      exerciseReviewPreviewResultSchema.parse({
        exerciseItemId: 'item-1',
        referenceSentence: 'I eat an apple.',
        revealedAt: '2026-07-17T00:00:00.000Z',
      }),
    ).toBeTruthy()
    expect(
      exerciseReviewEvaluateRequestSchema.parse({
        expectedContentRevision: 7,
        submission: { taskType: 'recall_word', answer: 'apple' },
      }),
    ).toBeTruthy()
    expect(
      exerciseReviewEvaluateResultSchema.parse({
        exerciseItemId: 'item-1',
        score: 2,
        correct: true,
        feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
      }),
    ).toBeTruthy()

    for (const decision of [
      { action: 'approve', expectedContentRevision: 7 },
      {
        action: 'request_rework',
        expectedContentRevision: 7,
        feedback: '例句与词义不匹配',
      },
      {
        action: 'correct',
        expectedContentRevision: 7,
        content: {
          stage: 'S2',
          taskType: 'recall_word',
          prompt: { meaning: '苹果' },
          answer: { word: 'apple' },
        },
      },
    ]) {
      expect(exerciseReviewDecisionRequestSchema.parse(decision)).toEqual(decision)
    }

    expect(() =>
      exerciseReviewDecisionRequestSchema.parse({
        action: 'request_rework',
        expectedContentRevision: 7,
        feedback: '   ',
      }),
    ).toThrow()
    expect(() =>
      exerciseReviewDecisionRequestSchema.parse({
        action: 'approve',
        expectedContentRevision: 7,
        feedback: 'undeclared',
      }),
    ).toThrow()
    expect(
      exerciseReviewDecisionResultSchema.parse({
        exerciseItemId: 'item-1',
        sourceVersionId: 'version-1',
        action: 'approve',
        status: 'approved',
        reviewState: 'approved',
        contentRevision: 8,
      }),
    ).toBeTruthy()
  })

  it('requires one operation token for both source import modes', () => {
    const nextVersion = {
      mode: 'next_version',
      operationToken: 'a'.repeat(64),
      sourceId: 'source-1',
      words: [
        {
          word: 'apple',
          meaning: '苹果',
          examplePhrase: 'An apple',
          exampleSentence: 'I eat an apple.',
          exampleSentenceExtended: 'I eat an apple every day.',
        },
      ],
    }

    expect(importSourceVersionCommandSchema.parse(nextVersion)).toEqual(nextVersion)
    expect(() =>
      importSourceVersionCommandSchema.parse({
        ...nextVersion,
        operationToken: undefined,
      }),
    ).toThrow()
  })
})
