/* eslint-disable vue/one-component-per-file */
import { defineComponent, h, onUnmounted } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import {
  reportAdminAuthorizationFailure,
} from '@/api/adminAuthorizationBoundary'
import { ApiFailureError, ApiNetworkError, InvalidApiResponseError } from '@/api/errors'
import AdminGate from '@/app/AdminGate.vue'
import { useAdminSessionContext } from '@/features/admin-auth/adminSessionContext'

enableAutoUnmount(afterEach)

type AdminGateApi = Pick<
  ReturnType<typeof createAdminApi>,
  'getAdminSession' | 'logoutAdmin'
>

const session = {
  id: 'admin-1',
  source: 'application_session' as const,
  displayName: 'Solazhu',
}

const sessionFailure = (
  code:
    | 'admin_session_required'
    | 'admin_session_expired'
    | 'admin_session_revoked',
) =>
  new ApiFailureError(401, { code, message: 'Session unavailable' })

const mountGate = async (
  api: AdminGateApi,
  slot?: string | (() => ReturnType<typeof h>),
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
    ],
  })
  await router.push('/admin/courses?filter=active')
  await router.isReady()
  const wrapper = mount(AdminGate, {
    props: { api },
    global: { plugins: [router] },
    ...(slot ? { slots: { default: slot } } : {}),
  })

  return { router, wrapper }
}

describe('AdminGate', () => {
  it('does not expose the workspace before the server confirms a session', async () => {
    let resolveSession!: (value: typeof session) => void
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockReturnValue(
        new Promise<typeof session>((resolve) => {
          resolveSession = resolve
        }),
      ),
      logoutAdmin: vi.fn(),
    }
    const { wrapper } = await mountGate(api, '<div data-admin-workspace>私有业务数据</div>')

    expect(wrapper.text()).toContain('正在验证管理员身份')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)

    resolveSession(session)
    await flushPromises()

    expect(wrapper.get('[data-admin-workspace]').text()).toBe('私有业务数据')
  })

  it('provides the authoritative session to the private subtree', async () => {
    const SessionProbe = defineComponent({
      setup() {
        const context = useAdminSessionContext()
        return () => h('p', { 'data-session': '' }, context.session.value?.displayName)
      },
    })
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue(session),
      logoutAdmin: vi.fn(),
    }
    const { wrapper } = await mountGate(api, () => h(SessionProbe))
    await flushPromises()

    expect(wrapper.get('[data-session]').text()).toBe('Solazhu')
  })

  it.each([
    sessionFailure('admin_session_required'),
    sessionFailure('admin_session_expired'),
    new InvalidApiResponseError(401),
    new InvalidApiResponseError(403),
  ])('fails closed into login when the initial session check rejects identity', async (error) => {
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockRejectedValue(error),
      logoutAdmin: vi.fn(),
    }
    const { router, wrapper } = await mountGate(
      api,
      '<div data-admin-workspace>私有业务数据</div>',
    )
    await flushPromises()

    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/admin/login')
    expect(router.currentRoute.value.query.returnTo).toBe('/admin/courses?filter=active')
  })

  it('labels a revoked initial session as invalid on the login route', async () => {
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockRejectedValue(sessionFailure('admin_session_revoked')),
      logoutAdmin: vi.fn(),
    }
    const { router } = await mountGate(api)
    await flushPromises()

    expect(router.currentRoute.value.query.reason).toBe('invalid')
  })

  it('does not mount the browser shell for a service-token identity', async () => {
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue({
        ...session,
        source: 'service_token' as const,
      }),
      logoutAdmin: vi.fn(),
    }
    const { router, wrapper } = await mountGate(
      api,
      '<div data-admin-workspace>私有业务数据</div>',
    )
    await flushPromises()

    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
    expect(router.currentRoute.value.path).toBe('/admin/login')
    expect(router.currentRoute.value.query.reason).toBe('invalid')
  })

  it('keeps the private subtree unmounted and allows retry after a network failure', async () => {
    const api: AdminGateApi = {
      getAdminSession: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockResolvedValueOnce(session),
      logoutAdmin: vi.fn(),
    }
    const { wrapper } = await mountGate(
      api,
      '<div data-admin-workspace>私有业务数据</div>',
    )
    await flushPromises()

    expect(wrapper.text()).toContain('无法验证管理员身份')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-admin-workspace]').text()).toBe('私有业务数据')
  })

  it('does not treat a 503 carrying a session code as confirmed identity rejection', async () => {
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockRejectedValue(
        new ApiFailureError(503, {
          code: 'admin_session_required',
          message: 'Session dependency unavailable',
        }),
      ),
      logoutAdmin: vi.fn(),
    }
    const { router, wrapper } = await mountGate(
      api,
      '<div data-admin-workspace>私有业务数据</div>',
    )
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/admin/courses')
    expect(wrapper.text()).toContain('无法验证管理员身份')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
  })

  it('unmounts stale private state only for a stable session-failure code', async () => {
    let unmounted = false
    const PrivateWorkspace = defineComponent({
      setup() {
        onUnmounted(() => {
          unmounted = true
        })
        return () => h('div', { 'data-admin-workspace': '' }, '旧页面私有状态')
      },
    })
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue(session),
      logoutAdmin: vi.fn(),
    }
    const { router, wrapper } = await mountGate(api, () => h(PrivateWorkspace))
    await flushPromises()

    reportAdminAuthorizationFailure('admin_session_revoked')
    await flushPromises()

    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
    expect(unmounted).toBe(true)
    expect(router.currentRoute.value.path).toBe('/admin/login')
  })

  it('revalidates the server session when a persisted page is restored', async () => {
    const api: AdminGateApi = {
      getAdminSession: vi
        .fn()
        .mockResolvedValueOnce(session)
        .mockRejectedValueOnce(sessionFailure('admin_session_revoked')),
      logoutAdmin: vi.fn(),
    }
    const { router } = await mountGate(api, '<div data-admin-workspace />')
    await flushPromises()

    const event = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(event, 'persisted', { value: true })
    window.dispatchEvent(event)
    await flushPromises()

    expect(api.getAdminSession).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.path).toBe('/admin/login')
  })

  it('revokes an application session and clears the private subtree on logout', async () => {
    const LogoutProbe = defineComponent({
      setup() {
        const context = useAdminSessionContext()
        return () =>
          h(
            'button',
            { 'data-logout': '', onClick: () => void context.logout() },
            '退出',
          )
      },
    })
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue(session),
      logoutAdmin: vi.fn().mockResolvedValue({ loggedOut: true as const }),
    }
    const { router, wrapper } = await mountGate(api, () => h(LogoutProbe))
    await flushPromises()

    await wrapper.get('[data-logout]').trigger('click')
    await flushPromises()

    expect(api.logoutAdmin).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-logout]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/admin/login?reason=logged_out')
  })

  it('uses Cloudflare Access logout without calling the application logout API', async () => {
    const accessSession = {
      ...session,
      source: 'cloudflare_access' as const,
    }
    const navigateToAccessLogout = vi.fn()
    const LogoutProbe = defineComponent({
      setup() {
        const context = useAdminSessionContext()
        return () =>
          h(
            'button',
            { 'data-logout': '', onClick: () => void context.logout() },
            '退出',
          )
      },
    })
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue(accessSession),
      logoutAdmin: vi.fn(),
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/admin/courses',
          component: { template: '<div />' },
          meta: { requiresAdmin: true },
        },
      ],
    })
    await router.push('/admin/courses')
    await router.isReady()
    const wrapper = mount(AdminGate, {
      props: { api, navigateToAccessLogout },
      slots: { default: () => h(LogoutProbe) },
      global: { plugins: [router] },
    })
    await flushPromises()

    await wrapper.get('[data-logout]').trigger('click')
    await flushPromises()

    expect(navigateToAccessLogout).toHaveBeenCalledTimes(1)
    expect(api.logoutAdmin).not.toHaveBeenCalled()
  })

  it('keeps the private subtree when application logout fails', async () => {
    const LogoutProbe = defineComponent({
      setup() {
        const context = useAdminSessionContext()
        return () =>
          h(
            'button',
            {
              'data-logout': '',
              onClick: () => void context.logout().catch(() => undefined),
            },
            '退出',
          )
      },
    })
    const api: AdminGateApi = {
      getAdminSession: vi.fn().mockResolvedValue(session),
      logoutAdmin: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    }
    const { router, wrapper } = await mountGate(api, () => h(LogoutProbe))
    await flushPromises()

    await wrapper.get('[data-logout]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-logout]').exists()).toBe(true)
    expect(router.currentRoute.value.path).toBe('/admin/courses')
  })
})
