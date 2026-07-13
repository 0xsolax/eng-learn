import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UiInput from '@/components/ui/UiInput.vue'

describe('UiInput', () => {
  it('associates its label, hint and field error with the input', async () => {
    const wrapper = mount(UiInput, {
      props: {
        id: 'access-code',
        label: '学习码',
        modelValue: '',
        hint: '请输入老师提供的学习码',
        error: '学习码无效，请重新检查',
        context: 'learner',
      },
    })
    const input = wrapper.get('input')

    expect(wrapper.get('label').attributes('for')).toBe('access-code')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('access-code-hint access-code-error')
    expect(wrapper.get('#access-code-error').attributes('role')).toBe('alert')

    await input.setValue('ABCD12')

    expect(wrapper.emitted('update:modelValue')).toEqual([['ABCD12']])
  })

  it('does not announce an error state when the field is valid', () => {
    const wrapper = mount(UiInput, {
      props: {
        id: 'source-name',
        label: '词库名称',
        modelValue: '基础词库',
        context: 'admin',
      },
    })

    expect(wrapper.get('input').attributes('aria-invalid')).toBeUndefined()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})
