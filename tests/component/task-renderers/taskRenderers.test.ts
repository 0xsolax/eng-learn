import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import FillBlankTask from '@/components/task-renderers/FillBlankTask.vue'
import MultipleChoiceTask from '@/components/task-renderers/MultipleChoiceTask.vue'
import RecallWordTask from '@/components/task-renderers/RecallWordTask.vue'
import RecognizeMeaningTask from '@/components/task-renderers/RecognizeMeaningTask.vue'
import SentenceBuildTask from '@/components/task-renderers/SentenceBuildTask.vue'
import SentenceOutputTask from '@/components/task-renderers/SentenceOutputTask.vue'

describe('task renderers', () => {
  it('submits S0 known or learning without calculating a score', async () => {
    const wrapper = mount(RecognizeMeaningTask, {
      props: {
        prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I ate an apple.' },
      },
    })

    expect(wrapper.text()).toContain('apple')
    expect(wrapper.text()).toContain('苹果')
    await wrapper.get('[data-response="learning"]').trigger('click')

    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'recognize_meaning', response: 'learning' }],
    ])
    expect(wrapper.emitted('submit')?.[0]?.[0]).not.toHaveProperty('score')
  })

  it('accepts only the first S0 response during rapid repeated activation', async () => {
    const wrapper = mount(RecognizeMeaningTask, {
      props: {
        prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
      },
    })

    await wrapper.get('[data-response="learning"]').trigger('click')
    await wrapper.get('[data-response="known"]').trigger('click')

    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'recognize_meaning', response: 'learning' }],
    ])
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined))
      .toBe(true)
  })

  it('keeps typed input and submits the S1 answer', async () => {
    const wrapper = mount(RecallWordTask, {
      props: { prompt: { meaning: '苹果' } },
    })

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('label').text()).toContain('写出英文单词')
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'recall_word', answer: 'apple' }],
    ])
  })

  it('emits the S1 answer once during rapid repeated submission', async () => {
    const wrapper = mount(RecallWordTask, {
      props: { prompt: { meaning: '苹果' } },
    })

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })

  it('keeps typed input and submits the S3 answer', async () => {
    const wrapper = mount(FillBlankTask, {
      props: { prompt: { sentence: 'I ate an ____.' } },
    })

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('label').text()).toContain('填入缺少的单词')
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'fill_blank', answer: 'apple' }],
    ])
  })

  it('emits the S3 answer once during rapid repeated submission', async () => {
    const wrapper = mount(FillBlankTask, {
      props: { prompt: { sentence: 'I ate an ____.' } },
    })

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })

  it('uses native keyboard-operable choices and submits only a selected S2 value', async () => {
    const wrapper = mount(MultipleChoiceTask, {
      props: {
        prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
      },
    })
    const submit = wrapper.get('[type="submit"]')

    expect(submit.attributes('disabled')).toBeDefined()
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined()
    await wrapper.get('input[value="apple"]').setValue(true)
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'multiple_choice', answer: 'apple' }],
    ])
  })

  it('emits the selected S2 answer once during rapid repeated submission', async () => {
    const wrapper = mount(MultipleChoiceTask, {
      props: {
        prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
      },
    })

    await wrapper.get('input[value="apple"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
  })

  it('builds S4 by click order without drag and submits stable piece ids', async () => {
    const wrapper = mount(SentenceBuildTask, {
      props: {
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p3', text: 'an apple' },
            { id: 'p1', text: 'I' },
          ],
        },
      },
    })

    expect(wrapper.find('[draggable="true"]').exists()).toBe(false)
    await wrapper.get('[aria-label="选择词块 I"]').trigger('click')
    await wrapper.get('[aria-label="选择词块 ate"]').trigger('click')
    await wrapper.get('[aria-label="选择词块 an apple"]').trigger('click')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('[aria-live="polite"]').text()).toContain('I ate an apple')
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'sentence_build', pieceIds: ['p1', 'p2', 'p3'] }],
    ])
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined))
      .toBe(true)
  })

  it('does not expose S4 piece ids that can reveal the answer order in the DOM', () => {
    const wrapper = mount(SentenceBuildTask, {
      props: {
        prompt: {
          pieces: [
            { id: 'correct-position-2', text: 'ate' },
            { id: 'correct-position-1', text: 'I' },
          ],
        },
      },
    })

    expect(wrapper.html()).not.toContain('correct-position-')
  })

  it('lets a keyboard-operable S4 piece be removed and selected again without drag', async () => {
    const wrapper = mount(SentenceBuildTask, {
      props: {
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p1', text: 'I' },
          ],
        },
      },
    })

    await wrapper.get('[aria-label="选择词块 I"]').trigger('click')
    await wrapper.get('[aria-label="移除词块 I"]').trigger('click')

    expect(wrapper.get('[aria-label="选择词块 I"]').text()).toBe('I')
    expect(wrapper.find('[draggable]').exists()).toBe(false)
    expect(wrapper.get('[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('moves focus with an S4 piece when selection changes its control', async () => {
    const wrapper = mount(SentenceBuildTask, {
      attachTo: document.body,
      props: {
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p1', text: 'I' },
          ],
        },
      },
    })

    try {
      const availablePiece = wrapper.get('[aria-label="选择词块 I"]')
      ;(availablePiece.element as HTMLButtonElement).focus()
      await availablePiece.trigger('click')

      const selectedPiece = wrapper.get('[aria-label="移除词块 I"]')
      expect(document.activeElement).toBe(selectedPiece.element)

      await selectedPiece.trigger('click')

      expect(document.activeElement).toBe(
        wrapper.get('[aria-label="选择词块 I"]').element,
      )
    } finally {
      wrapper.unmount()
    }
  })

  it('requires the S5 preview before allowing a 0-3 self score', async () => {
    const wrapper = mount(SentenceOutputTask, {
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
      },
    })

    await wrapper.get('textarea').setValue('I ate an apple.')
    expect(wrapper.find('[data-self-score]').exists()).toBe(false)
    await wrapper.get('[data-action="preview"]').trigger('click')
    expect(wrapper.emitted('preview')).toEqual([
      [{ taskType: 'sentence_output', draft: 'I ate an apple.' }],
    ])

    await wrapper.setProps({ referenceSentence: 'I ate an apple.' })
    expect(wrapper.text()).toContain('I ate an apple.')
    await wrapper.get('[data-self-score="3"]').trigger('click')
    await wrapper.get('[data-self-score="2"]').trigger('click')

    expect(wrapper.emitted('submit')).toEqual([
      [
        {
          taskType: 'sentence_output',
          draft: 'I ate an apple.',
          selfScore: 3,
        },
      ],
    ])
    expect(wrapper.findAll('[data-self-score]').every((button) => button.attributes('disabled') !== undefined))
      .toBe(true)
  })

  it('keeps an S5 reference sentence out of the DOM until preview is requested', () => {
    const wrapper = mount(SentenceOutputTask, {
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
        referenceSentence: 'PRIVATE REFERENCE SENTENCE',
      },
    })

    expect(wrapper.html()).not.toContain('PRIVATE REFERENCE SENTENCE')
    expect(wrapper.find('[data-self-score]').exists()).toBe(false)
  })

  it('emits the S5 preview once during rapid repeated activation', async () => {
    const wrapper = mount(SentenceOutputTask, {
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
      },
    })

    await wrapper.get('textarea').setValue('I ate an apple.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await wrapper.get('[data-action="preview"]').trigger('click')

    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  })

  it('announces the S5 reference without putting self-score controls in the live region', async () => {
    const wrapper = mount(SentenceOutputTask, {
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
      },
    })

    await wrapper.get('textarea').setValue('I ate an apple.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await wrapper.setProps({ referenceSentence: 'I ate an apple.' })

    const announcement = wrapper.get('[role="status"]')
    expect(announcement.text()).toContain('I ate an apple.')
    expect(announcement.find('button').exists()).toBe(false)
    expect(wrapper.findAll('[data-self-score]')).toHaveLength(4)
  })

  it('moves focus to the S5 reference when preview replaces the action', async () => {
    const wrapper = mount(SentenceOutputTask, {
      attachTo: document.body,
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
      },
    })

    try {
      await wrapper.get('textarea').setValue('I ate an apple.')
      const preview = wrapper.get('[data-action="preview"]')
      ;(preview.element as HTMLButtonElement).focus()
      await preview.trigger('click')
      await wrapper.setProps({ referenceSentence: 'I ate an apple.' })
      await nextTick()

      const reference = wrapper.get('[role="status"]')
      expect(reference.attributes('tabindex')).toBe('-1')
      expect(document.activeElement).toBe(reference.element)
    } finally {
      wrapper.unmount()
    }
  })

  it('disables every answer control while a request is in flight', () => {
    const recognize = mount(RecognizeMeaningTask, {
      props: {
        prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
        disabled: true,
      },
    })
    const recall = mount(RecallWordTask, {
      props: { prompt: { meaning: '苹果' }, disabled: true },
    })
    const choice = mount(MultipleChoiceTask, {
      props: {
        prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
        disabled: true,
      },
    })
    const fill = mount(FillBlankTask, {
      props: { prompt: { sentence: 'I ate an ____.' }, disabled: true },
    })
    const build = mount(SentenceBuildTask, {
      props: {
        prompt: {
          pieces: [
            { id: 'p2', text: 'ate' },
            { id: 'p1', text: 'I' },
          ],
        },
        disabled: true,
      },
    })
    const output = mount(SentenceOutputTask, {
      props: {
        prompt: { meaning: '我吃了一个苹果。', instruction: '请写一个完整英文句子' },
        disabled: true,
      },
    })

    const directlyDisabledControls = [
      ...recognize.findAll('button'),
      ...recall.findAll('button, input'),
      ...choice.findAll('button'),
      ...fill.findAll('button, input'),
      ...build.findAll('button'),
      ...output.findAll('button, textarea'),
    ]
    expect(
      directlyDisabledControls.every((control) => control.attributes('disabled') !== undefined),
    ).toBe(true)
    expect(choice.get('fieldset').attributes('disabled')).toBeDefined()
  })
})
