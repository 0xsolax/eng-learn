import { describe, expect, it } from 'vitest'
import { evaluateTaskSubmission } from '../../server/services/taskEvaluation'
import type { ExerciseItemContent } from '../../shared/api/taskSchemas'

describe('task evaluation', () => {
  it.each([
    ['known', 2],
    ['learning', 0],
  ] as const)('maps an S0 %s response to the frozen score', (response, score) => {
    expect(
      evaluateTaskSubmission(
        content({
          stage: 'S0',
          taskType: 'recognize_meaning',
          prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
          answer: { expectedResponse: 'known' },
        }),
        { taskType: 'recognize_meaning', response },
      ),
    ).toMatchObject({ score, logCorrectAnswer: 'known' })
  })

  it.each([
    ['recall_word', 'S1', { meaning: '苹果' }],
    ['multiple_choice', 'S2', { meaning: '苹果', options: ['pear', 'apple', 'peach'] }],
    ['fill_blank', 'S3', { sentence: 'I ate an ____.' }],
  ] as const)('normalizes exact text answers for %s', (taskType, stage, prompt) => {
    const item = content({ stage, taskType, prompt, answer: { word: 'Apple' } } as ExerciseItemContent)

    expect(
      evaluateTaskSubmission(item, { taskType, answer: '  apple  ' }),
    ).toMatchObject({ score: 2, logCorrectAnswer: 'Apple' })
    expect(
      evaluateTaskSubmission(item, { taskType, answer: '苹果' }),
    ).toMatchObject({ score: 0 })
  })

  it('treats canonically equivalent Unicode answers as the same text', () => {
    const item = content({
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning: '咖啡' },
      answer: { word: 'café' },
    })

    expect(
      evaluateTaskSubmission(item, {
        taskType: 'recall_word',
        answer: 'cafe\u0301',
      }),
    ).toMatchObject({ score: 2, logCorrectAnswer: 'café' })
  })

  it('requires the exact ordered piece-id sequence for S4', () => {
    const item = content({
      stage: 'S4',
      taskType: 'sentence_build',
      prompt: {
        pieces: [
          { id: 'p2', text: 'eat' },
          { id: 'p1', text: 'I' },
        ],
      },
      answer: { pieceIds: ['p1', 'p2'], referenceSentence: 'I eat' },
    })

    expect(
      evaluateTaskSubmission(item, { taskType: 'sentence_build', pieceIds: ['p1', 'p2'] }),
    ).toMatchObject({ score: 2, logCorrectAnswer: '["p1","p2"]' })
    expect(
      evaluateTaskSubmission(item, { taskType: 'sentence_build', pieceIds: ['p2', 'p1'] }),
    ).toMatchObject({ score: 0 })
  })

  it('uses the learner S5 self score without automatic text grading', () => {
    const item = content({
      stage: 'S5',
      taskType: 'sentence_output',
      prompt: { meaning: '我吃苹果。', instruction: '写一个英文句子' },
      answer: { referenceSentence: 'I eat an apple.' },
    })

    expect(
      evaluateTaskSubmission(item, {
        taskType: 'sentence_output',
        draft: 'My sentence can be different.',
        selfScore: 1,
      }),
    ).toMatchObject({ score: 1, logCorrectAnswer: 'I eat an apple.' })
  })

  it('rejects a submission whose task type does not match the snapshot', () => {
    const item = content({
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning: '苹果' },
      answer: { word: 'apple' },
    })

    expect(() =>
      evaluateTaskSubmission(item, {
        taskType: 'multiple_choice',
        answer: 'apple',
      }),
    ).toThrow('Task submission type does not match the task snapshot')
  })
})

const content = <T extends ExerciseItemContent>(value: T): T => value
