import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UiButton from '@/components/ui/UiButton.vue'

describe('UiButton', () => {
  it('emits one click while available and blocks interaction while loading', async () => {
    const wrapper = mount(UiButton, {
      props: {
        context: 'learner',
      },
      slots: {
        default: '开始学习',
      },
    })

    expect(wrapper.attributes('type')).toBe('button')
    expect(wrapper.attributes('aria-busy')).toBeUndefined()

    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)

    await wrapper.setProps({ loading: true })
    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toHaveLength(1)
    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.text()).toContain('处理中')
  })

  it('keeps native disabled semantics', async () => {
    const wrapper = mount(UiButton, {
      props: {
        disabled: true,
      },
      slots: {
        default: '发布版本',
      },
    })

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
    expect(wrapper.attributes('disabled')).toBeDefined()
  })
})
