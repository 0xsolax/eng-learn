import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'

describe('UiStatusMessage', () => {
  it('announces errors assertively with visible explanatory text', () => {
    const wrapper = mount(UiStatusMessage, {
      props: {
        tone: 'error',
        title: '提交失败',
      },
      slots: {
        default: '答案已经保留，请检查网络后重试。',
      },
    })

    expect(wrapper.attributes('role')).toBe('alert')
    expect(wrapper.attributes('aria-live')).toBe('assertive')
    expect(wrapper.text()).toContain('提交失败')
    expect(wrapper.text()).toContain('答案已经保留')
    expect(wrapper.get('[aria-hidden="true"]')).toBeDefined()
  })

  it('announces non-error status updates politely', () => {
    const wrapper = mount(UiStatusMessage, {
      props: {
        tone: 'success',
        title: '保存成功',
      },
    })

    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
  })
})
