import { describe, expect, it } from 'vitest'
import {
  canonicalizeLearningText,
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

  it.each([
    ['zero-width separator', 'ap\u200Bple', 'apple'],
    ['soft hyphen', 'ap\u00ADple', 'apple'],
    ['fullwidth text', 'ａｐｐｌｅ', 'apple'],
    ['compatibility ligature', 'oﬃce', 'office'],
  ])('treats %s as visually equivalent for safety checks', (_label, value, target) => {
    expect(containsUnicodeWholeToken(value, target)).toBe(true)
  })

  it('does not turn a visually joined larger token into a standalone answer', () => {
    expect(containsUnicodeWholeToken('apple\u200Bpie', 'apple')).toBe(false)
  })

  it('keeps persisted and scoring canonicalization on the existing NFC contract', () => {
    expect(canonicalizeLearningText('ＡＰＰＬＥ')).toBe('ａｐｐｌｅ')
    expect(canonicalizeLearningText('AP\u200BPLE')).toBe('ap\u200Bple')
    expect(canonicalizeLearningText('AP\u00ADPLE')).toBe('ap\u00ADple')
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

  it.each([
    [
      'meaning',
      {
        meaning: '请使用 ap\u200Bple 完成一句话',
        instruction: 'Write one complete English sentence.',
      },
    ],
    [
      'instruction',
      {
        meaning: '苹果',
        instruction: 'Write one sentence with ａｐｐｌｅ.',
      },
    ],
  ])('detects an S5 owning word exposed in the learner %s', (_field, prompt) => {
    expect(
      learnerPromptRevealsAnswer(
        {
          stage: 'S5',
          taskType: 'sentence_output',
          prompt,
          answer: { referenceSentence: 'I ate an apple.' },
        },
        'apple',
      ),
    ).toBe(true)
  })
})
