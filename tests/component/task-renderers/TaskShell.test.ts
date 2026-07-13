import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TaskShell from '@/components/task-renderers/TaskShell.vue'

describe('TaskShell', () => {
  it('shows the authoritative lesson position and emits exit without changing task state', async () => {
    const wrapper = mount(TaskShell, {
      props: { lessonNo: 3, position: 2, total: 8 },
      slots: { default: '<div data-task>题目</div>' },
    })

    expect(wrapper.text()).toContain('第 3 课')
    expect(wrapper.text()).toContain('2 / 8')
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuemin': '0',
      'aria-valuemax': '8',
      'aria-valuenow': '2',
    })
    await wrapper.get('[data-action="exit"]').trigger('click')
    expect(wrapper.emitted('exit')).toHaveLength(1)
  })

  it('announces feedback and exposes one recovery action after a network failure', async () => {
    const wrapper = mount(TaskShell, {
      props: {
        lessonNo: 1,
        position: 1,
        total: 5,
        feedback: { tone: 'error', title: '还差一点', message: '正确答案是 apple' },
        retryLabel: '重新提交',
      },
    })

    expect(wrapper.get('[role="alert"]').text()).toContain('正确答案是 apple')
    await wrapper.get('[data-action="retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('emits one retry during rapid repeated activation', async () => {
    const wrapper = mount(TaskShell, {
      props: {
        lessonNo: 1,
        position: 1,
        total: 5,
        retryLabel: '重新提交',
      },
    })

    await wrapper.get('[data-action="retry"]').trigger('click')
    await wrapper.get('[data-action="retry"]').trigger('click')

    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.get('[data-action="retry"]').attributes('disabled')).toBeDefined()
  })
})
