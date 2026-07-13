import { describe, expect, it } from 'vitest'
import {
  containsUnicodeWholeToken,
  learnerPromptRevealsAnswer,
} from '../../shared/api/taskContentSafety'

describe('task content safety', () => {
  it('treats collapsed whitespace as equivalent inside a multi-word answer', () => {
    expect(containsUnicodeWholeToken('New   York 城市', 'New York')).toBe(true)
  })

  it('treats canonically equivalent Unicode text as the same answer', () => {
    expect(containsUnicodeWholeToken('cafe\u0301 咖啡', 'café')).toBe(true)
  })

  it('detects an S5 reference sentence exposed as the learner meaning', () => {
    expect(
      learnerPromptRevealsAnswer(
        {
          stage: 'S5',
          taskType: 'sentence_output',
          prompt: {
            meaning: 'I   ATE an apple.',
            instruction: 'Write one complete English sentence.',
          },
          answer: { referenceSentence: 'I ate an apple.' },
        },
        'apple',
      ),
    ).toBe(true)
  })

  it('detects an S5 reference sentence embedded in the learner instruction', () => {
    expect(
      learnerPromptRevealsAnswer(
        {
          stage: 'S5',
          taskType: 'sentence_output',
          prompt: {
            meaning: '苹果',
            instruction: 'Write this: I ate an apple.',
          },
          answer: { referenceSentence: 'I ate an apple.' },
        },
        'apple',
      ),
    ).toBe(true)
  })
})
