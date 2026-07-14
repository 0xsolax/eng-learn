import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import AdminLoginPage from '@/pages/admin/AdminLoginPage.vue'

enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())

const existingSession = {
  id: 'admin-1',
  source: 'application_session' as const,
  displayName: '内容管理员',
}

type AdminLoginApi = Pick<
  ReturnType<typeof createAdminApi>,
  'getAdminSession' | 'loginAdmin'
>

const sessionRequired = () =>
  new ApiFailureError(401, {
    code: 'admin_session_required',
    message: 'Admin session required',
  })

const mountLogin = async (
  path: string,
  api: AdminLoginApi,
) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/admin/login',
        name: 'admin-login',
        component: { template: '<div />' },
        meta: { requiresAdmin: false },
      },
      {
        path: '/admin/source-versions',
        name: 'admin-source-versions',
        component: { template: '<div />' },
        meta: { requiresAdmin: true },
      },
      {
        path: '/admin/courses',
        name: 'admin-courses',
        component: { template: '<div />' },
        meta: { requiresAdmin: true },
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: { template: '<div />' },
      },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AdminLoginPage, {
    attachTo: document.body,
    props: { api },
    global: { plugins: [router] },
  })

  return { router, wrapper }
}

describe('AdminLoginPage', () => {
  it('does not mount editable fields while checking an existing session', async () => {
    let resolveSession!: (session: typeof existingSession) => void
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockReturnValue(
        new Promise<typeof existingSession>((resolve) => {
          resolveSession = resolve
        }),
      ),
      loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
    }
    const { wrapper } = await mountLogin('/admin/login', api)

    expect(wrapper.text()).toContain('正在检查管理员会话')
    expect(wrapper.find('input').exists()).toBe(false)

    resolveSession(existingSession)
    await flushPromises()
  })

  it.each([
    ['/admin/courses', '/admin/courses'],
    ['https://example.com/admin', '/admin/source-versions'],
    ['//example.com/admin', '/admin/source-versions'],
    ['/admin/login', '/admin/source-versions'],
    ['/admin/not-registered', '/admin/source-versions'],
  ])(
    'replaces an already-authenticated login route using the safe return target %s',
    async (returnTo, expectedPath) => {
      const api: AdminLoginApi = {
        getAdminSession: vi.fn().mockResolvedValue(existingSession),
        loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
      }
      const { router } = await mountLogin(
        `/admin/login?returnTo=${encodeURIComponent(returnTo)}`,
        api,
      )

      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe(expectedPath)
    },
  )

  it('keeps the account, clears the password, and restores password focus after invalid credentials', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'invalid_admin_credentials',
          message: 'Invalid credentials',
        }),
      ),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get<HTMLInputElement>('input[name="username"]').element.value).toBe(
      'admin@example.com',
    )
    expect(wrapper.get<HTMLInputElement>('input[name="password"]').element.value).toBe('')
    expect(wrapper.get('[role="alert"]').text()).toContain('账号或密码不正确')
    expect(document.activeElement).toBe(
      wrapper.get<HTMLInputElement>('input[name="password"]').element,
    )
  })

  it('checks the session before allowing a password retry when the login result is unknown', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi
        .fn()
        .mockRejectedValueOnce(sessionRequired())
        .mockResolvedValueOnce(existingSession),
      loginAdmin: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
    }
    const { router, wrapper } = await mountLogin('/admin/login?returnTo=/admin/courses', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.loginAdmin).toHaveBeenCalledTimes(1)
    expect(api.getAdminSession).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.fullPath).toBe('/admin/courses')
  })

  it.each([
    ['expired', '登录已过期，请重新登录'],
    ['invalid', '登录已失效，请重新登录'],
    ['logged_out', '已安全退出'],
  ])('shows the explicit %s recovery reason next to the login form', async (reason, message) => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
    }
    const { wrapper } = await mountLogin(`/admin/login?reason=${reason}`, api)
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toContain(message)
    expect(wrapper.find('form').exists()).toBe(true)
  })

  it('focuses the password field when an expired session returns to login', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
    }
    const { wrapper } = await mountLogin('/admin/login?reason=expired', api)
    await flushPromises()

    expect(document.activeElement).toBe(
      wrapper.get<HTMLInputElement>('input[name="password"]').element,
    )
  })

  it('keeps the form unmounted when the initial session check has a network failure', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockRejectedValueOnce(sessionRequired()),
      loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法连接服务器')
    expect(wrapper.find('form').exists()).toBe(false)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(api.getAdminSession).toHaveBeenCalledTimes(2)
    expect(wrapper.find('form').exists()).toBe(true)
  })

  it('uses the server cooldown and only re-enables submission after it expires', async () => {
    vi.useFakeTimers()
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn().mockRejectedValue(
        new ApiFailureError(429, {
          code: 'admin_login_rate_limited',
          message: 'Rate limited',
          details: { retryAfterSeconds: 2 },
        }),
      ),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('2 秒后重试')
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)

    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(false)
  })

  it.each([
    ['admin_not_configured', '管理员登录尚未配置，请先在部署终端完成初始化'],
    ['dependency_failure', '登录服务暂不可用，请稍后重试'],
    ['internal_error', '登录服务暂不可用，请稍后重试'],
  ] as const)('shows a recoverable login state for %s', async (code, message) => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn().mockRejectedValue(
        new ApiFailureError(code === 'admin_not_configured' ? 503 : 500, {
          code,
          message: 'Server detail is not shown',
        }),
      ),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(message)
    expect(wrapper.get<HTMLInputElement>('input[name="username"]').element.value).toBe(
      'admin@example.com',
    )
  })

  it('allows retry after a login network failure is confirmed not to have created a session', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi
        .fn()
        .mockRejectedValueOnce(sessionRequired())
        .mockRejectedValueOnce(sessionRequired()),
      loginAdmin: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法连接服务器')
    expect(wrapper.get<HTMLInputElement>('input[name="username"]').element.value).toBe(
      'admin@example.com',
    )
    expect(wrapper.get<HTMLInputElement>('input[name="password"]').element.value).toBe('')
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(false)
  })

  it('establishes a session and replaces the login route with the default workspace', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn().mockResolvedValue(existingSession),
    }
    const { router, wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    await wrapper.get('input[name="username"]').setValue('admin@example.com')
    await wrapper.get('input[name="password"]').setValue('not-a-real-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/admin/source-versions')
    expect(api.loginAdmin).toHaveBeenCalledTimes(1)
  })

  it('uses account autocomplete and does not expose the learner-code form', async () => {
    const api: AdminLoginApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionRequired()),
      loginAdmin: vi.fn<AdminLoginApi['loginAdmin']>(),
    }
    const { wrapper } = await mountLogin('/admin/login', api)
    await flushPromises()

    expect(wrapper.get('input[name="username"]').attributes('autocomplete')).toBe('username')
    expect(wrapper.get('input[name="password"]').attributes('autocomplete')).toBe(
      'current-password',
    )
    expect(wrapper.get('a[href="/app"]').text()).toContain('前往学生学习端')
    expect(wrapper.text()).not.toContain('10 位学习码')
  })
})
