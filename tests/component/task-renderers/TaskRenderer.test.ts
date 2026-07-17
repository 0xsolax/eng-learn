import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskRenderer from '@/components/task-renderers/TaskRenderer.vue'
import type { LessonTaskDto, TaskRenderDto } from '@shared/api/taskSchemas'

const base = {
  id: 'task-1',
  sessionId: 'session-1',
  courseId: 'course-1',
  wordId: 'word-1',
  orderIndex: 1,
  status: 'pending' as const,
  role: 'primary' as const,
  required: false,
}

const rendererCases: { task: LessonTaskDto; selector: string }[] = [
  {
    task: {
      ...base,
      stage: 'S0',
      taskType: 'recognize_meaning',
      prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
    },
    selector: '[data-response="known"]',
  },
  {
    task: {
      ...base,
      stage: 'S1',
      taskType: 'multiple_choice',
      prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
    },
    selector: 'fieldset',
  },
  {
    task: { ...base, stage: 'S2', taskType: 'recall_word', prompt: { meaning: '苹果' } },
    selector: 'input',
  },
  {
    task: {
      ...base,
      stage: 'S3',
      taskType: 'fill_blank',
      prompt: { sentence: 'I ate an ____.' },
    },
    selector: 'input',
  },
  {
    task: {
      ...base,
      stage: 'S4',
      taskType: 'sentence_build',
      prompt: { pieces: [{ id: 'p2', text: 'ate' }, { id: 'p1', text: 'I' }] },
    },
    selector: '[aria-label="可选词块"]',
  },
  {
    task: {
      ...base,
      stage: 'S5',
      taskType: 'sentence_output',
      prompt: { meaning: '我吃苹果。', instruction: '写一个英文句子' },
    },
    selector: 'textarea',
  },
]

describe('TaskRenderer', () => {
  it('renders an admin review task without invented course or session fields', () => {
    const task: TaskRenderDto = {
      id: 'item-1',
      stage: 'S2',
      taskType: 'recall_word',
      prompt: { meaning: '苹果' },
    }
    const wrapper = mount(TaskRenderer, { props: { task } })

    expect(wrapper.find('input').exists()).toBe(true)
  })

  it.each(rendererCases)('renders every discriminated lesson task type', ({ task, selector }) => {
    const wrapper = mount(TaskRenderer, { props: { task } })

    expect(wrapper.find(selector).exists()).toBe(true)
  })

  it('routes a discriminated task to its renderer and forwards only a typed submission', async () => {
    const task: LessonTaskDto = {
      ...base,
      stage: 'S0',
      taskType: 'recognize_meaning',
      prompt: { word: 'apple', meaning: '苹果', exampleSentence: '' },
    }
    const wrapper = mount(TaskRenderer, { props: { task } })

    await wrapper.get('[data-response="known"]').trigger('click')
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'recognize_meaning', response: 'known' }],
    ])
  })

  it('forwards S5 preview and final self-score as separate events', async () => {
    const task: LessonTaskDto = {
      ...base,
      stage: 'S5',
      taskType: 'sentence_output',
      prompt: { meaning: '我吃苹果。', instruction: '写一个英文句子' },
    }
    const wrapper = mount(TaskRenderer, { props: { task } })

    await wrapper.get('textarea').setValue('I eat apples.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    expect(wrapper.emitted('preview')).toEqual([
      [{ taskType: 'sentence_output', draft: 'I eat apples.' }],
    ])

    await wrapper.setProps({ referenceSentence: 'I eat an apple.' })
    await wrapper.get('[data-self-score="2"]').trigger('click')
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'sentence_output', draft: 'I eat apples.', selfScore: 2 }],
    ])
  })

  it('restores an authoritative S5 preview without allowing a different draft preview', async () => {
    const task: LessonTaskDto = {
      ...base,
      stage: 'S5',
      taskType: 'sentence_output',
      prompt: { meaning: '我吃苹果。', instruction: '写一个英文句子' },
      preview: {
        draft: 'I eat one apple.',
        referenceSentence: 'I eat an apple.',
        revealedAt: '2026-07-13T12:00:00.000Z',
      },
    }
    const wrapper = mount(TaskRenderer, { props: { task } })

    const draft = wrapper.get('textarea')
    expect((draft.element as HTMLTextAreaElement).value).toBe('I eat one apple.')
    expect(draft.attributes('readonly')).toBeDefined()
    expect(wrapper.find('[data-action="preview"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('I eat an apple.')
    expect(wrapper.findAll('[data-self-score]')).toHaveLength(4)

    await wrapper.get('[data-self-score="2"]').trigger('click')

    expect(wrapper.emitted('preview')).toBeUndefined()
    expect(wrapper.emitted('submit')).toEqual([
      [{ taskType: 'sentence_output', draft: 'I eat one apple.', selfScore: 2 }],
    ])
  })

  it('starts with clean local state when the next task has the same renderer type', async () => {
    const firstTask: LessonTaskDto = {
      ...base,
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning: '苹果' },
    }
    const wrapper = mount(TaskRenderer, { props: { task: firstTask } })

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')
    const nextTask: LessonTaskDto = {
      ...firstTask,
      id: 'task-2',
      orderIndex: 2,
      prompt: { meaning: '梨' },
    }
    await wrapper.setProps({ task: nextTask })

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('input').attributes('disabled')).toBeUndefined()
  })
})
