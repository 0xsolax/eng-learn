import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import LearnerAccessEntry from '@/features/learner-course/LearnerAccessEntry.vue'

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 3,
  status: 'active' as const,
}

describe('LearnerAccessEntry', () => {
  it('restores the HttpOnly learner session without asking for or persisting a code', async () => {
    const restored = { learner: { id: 'learner-1' }, course }
    const api = {
      restoreSession: vi.fn().mockResolvedValue(restored),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })

    expect(wrapper.get('[role="status"]').text()).toContain('正在恢复学习会话')

    await flushPromises()

    expect(wrapper.emitted('authenticated')).toEqual([[restored]])
    expect(api.exchangeAccessCode).not.toHaveBeenCalled()
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('shows the 10-character code form when no learner session cookie exists', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'learner_session_required',
          message: 'Learner session is required',
        }),
      ),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })

    await flushPromises()

    const input = wrapper.get('input')
    expect(wrapper.get('label').text()).toBe('10 位学习码')
    expect(input.attributes('maxlength')).toBe('10')
    expect(input.attributes('autocomplete')).toBe('off')
    expect(input.attributes('autocapitalize')).toBe('characters')
    expect(wrapper.get('button').text()).toBe('进入课程')
  })

  it('validates, normalizes and exchanges one temporary code without duplicate submission', async () => {
    const established = {
      learner: { id: 'learner-1', name: '小林' },
      course,
    }
    let resolveExchange: ((value: typeof established) => void) | undefined
    const exchange = new Promise<typeof established>((resolve) => {
      resolveExchange = resolve
    })
    const api = {
      restoreSession: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'learner_session_required',
          message: 'Learner session is required',
        }),
      ),
      exchangeAccessCode: vi.fn().mockReturnValue(exchange),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    await wrapper.get('input').setValue('ABCD')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('10 位')
    expect(api.exchangeAccessCode).not.toHaveBeenCalled()

    await wrapper.get('input').setValue('abcdefgh23')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')

    expect(api.exchangeAccessCode).toHaveBeenCalledTimes(1)
    expect(api.exchangeAccessCode).toHaveBeenCalledWith('ABCDEFGH23')
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true')

    resolveExchange?.(established)
    await flushPromises()

    expect(wrapper.emitted('authenticated')).toEqual([[established]])
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('')
  })

  it('keeps the code editable and explains a rejected code', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'learner_session_required',
          message: 'Learner session is required',
        }),
      ),
      exchangeAccessCode: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'invalid_access_code',
          message: 'Learning code is invalid',
        }),
      ),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    await wrapper.get('input').setValue('ABCDEFGH23')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('学习码无效')
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('ABCDEFGH23')
    expect(wrapper.get('input').attributes('disabled')).toBeUndefined()
  })

  it('exposes a recoverable network message when cookie restoration cannot reach the server', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法恢复学习会话')
    expect(wrapper.find('input').exists()).toBe(true)
  })
})
