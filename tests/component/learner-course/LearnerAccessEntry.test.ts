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

const sessionRequired = () =>
  new ApiFailureError(401, {
    code: 'learner_session_required',
    message: 'Learner session is required',
  })

describe('LearnerAccessEntry', () => {
  it('restores the HttpOnly learner session without showing login credentials', async () => {
    const restored = { learner: { id: 'learner-1' }, course }
    const api = {
      restoreSession: vi.fn().mockResolvedValue(restored),
      exchangeAccountLogin: vi.fn(),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })

    expect(wrapper.get('[role="status"]').text()).toContain('正在恢复学习会话')
    await flushPromises()

    expect(wrapper.emitted('authenticated')).toEqual([[restored]])
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('shows account and PIN as the primary login while keeping legacy code collapsed', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(sessionRequired()),
      exchangeAccountLogin: vi.fn(),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    expect(wrapper.get('label[for="learner-login-account"]').text()).toBe('学习账号')
    expect(wrapper.get('#learner-login-account').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('#learner-login-pin').attributes()).toMatchObject({
      type: 'password',
      autocomplete: 'current-password',
      inputmode: 'numeric',
      maxlength: '6',
    })
    expect(wrapper.find('#learner-access-code').exists()).toBe(false)
    expect(wrapper.get('[data-toggle-legacy-code]').attributes('aria-expanded')).toBe('false')
  })

  it('normalizes the account, prevents duplicate submission, and emits the established session', async () => {
    const established = { learner: { id: 'learner-1', name: '小林' }, course }
    let resolveLogin: ((value: typeof established) => void) | undefined
    const login = new Promise<typeof established>((resolve) => {
      resolveLogin = resolve
    })
    const api = {
      restoreSession: vi.fn().mockRejectedValue(sessionRequired()),
      exchangeAccountLogin: vi.fn().mockReturnValue(login),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    await wrapper.get('#learner-login-account').setValue(' Alice01 ')
    await wrapper.get('#learner-login-pin').setValue('123456')
    await wrapper.get('[data-account-form]').trigger('submit')
    await wrapper.get('[data-account-form]').trigger('submit')

    expect(api.exchangeAccountLogin).toHaveBeenCalledTimes(1)
    expect(api.exchangeAccountLogin).toHaveBeenCalledWith('alice01', '123456')
    expect(wrapper.get('button[type="submit"]').attributes('aria-busy')).toBe('true')

    resolveLogin?.(established)
    await flushPromises()
    expect(wrapper.emitted('authenticated')).toEqual([[established]])
  })

  it('uses one generic credential error, clears the PIN, and returns focus to it', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(sessionRequired()),
      exchangeAccountLogin: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'invalid_learner_credentials',
          message: 'Invalid credentials',
        }),
      ),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api }, attachTo: document.body })
    await flushPromises()

    await wrapper.get('#learner-login-account').setValue('alice01')
    await wrapper.get('#learner-login-pin').setValue('123456')
    await wrapper.get('[data-account-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('账号或 PIN 不正确')
    expect((wrapper.get('#learner-login-account').element as HTMLInputElement).value).toBe(
      'alice01',
    )
    expect((wrapper.get('#learner-login-pin').element as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(wrapper.get('#learner-login-pin').element)
    wrapper.unmount()
  })

  it('expands the migration-only learning-code form on demand', async () => {
    const established = { learner: { id: 'learner-1', name: '小林' }, course }
    const api = {
      restoreSession: vi.fn().mockRejectedValue(sessionRequired()),
      exchangeAccountLogin: vi.fn(),
      exchangeAccessCode: vi.fn().mockResolvedValue(established),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-toggle-legacy-code]').trigger('click')
    expect(wrapper.get('#learner-access-code').element).toBeInstanceOf(HTMLInputElement)
    await wrapper.get('#learner-access-code').setValue('abcdefgh23')
    await wrapper.get('[data-legacy-code-form]').trigger('submit')
    await flushPromises()

    expect(api.exchangeAccessCode).toHaveBeenCalledWith('ABCDEFGH23')
    expect(wrapper.emitted('authenticated')).toEqual([[established]])
  })

  it('keeps login available when cookie restoration cannot reach the server', async () => {
    const api = {
      restoreSession: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      exchangeAccountLogin: vi.fn(),
      exchangeAccessCode: vi.fn(),
    }
    const wrapper = mount(LearnerAccessEntry, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法恢复学习会话')
    expect(wrapper.find('#learner-login-account').exists()).toBe(true)
  })
})
