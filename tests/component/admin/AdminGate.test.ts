import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import { createHttpClient, type FetchImplementation } from '@/api/httpClient'
import AdminGate from '@/app/AdminGate.vue'

enableAutoUnmount(afterEach)

describe('AdminGate', () => {
  it('does not expose the admin workspace before the server confirms an admin session', async () => {
    let resolveSession: ((value: { id: string; source: 'cloudflare_access' }) => void) | undefined
    const session = new Promise<{ id: string; source: 'cloudflare_access' }>((resolve) => {
      resolveSession = resolve
    })
    const api = { getAdminSession: vi.fn().mockReturnValue(session) }
    const wrapper = mount(AdminGate, {
      props: { api },
      slots: { default: '<div data-admin-workspace>私有业务数据</div>' },
    })

    expect(wrapper.get('[role="status"]').text()).toContain('正在验证管理员身份')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
    expect(api.getAdminSession).toHaveBeenCalledTimes(1)

    resolveSession?.({ id: 'admin-1', source: 'cloudflare_access' })
    await flushPromises()

    expect(wrapper.get('[data-admin-workspace]').text()).toBe('私有业务数据')
  })

  it('keeps the business shell unmounted when the admin identity is rejected', async () => {
    const api = {
      getAdminSession: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'unauthorized',
          message: 'Access identity required',
        }),
      ),
    }
    const wrapper = mount(AdminGate, {
      props: { api },
      slots: { default: '<div data-admin-workspace>私有业务数据</div>' },
    })

    await flushPromises()

    const main = wrapper.get('main')
    expect(main.get('h1').text()).toBe('管理端身份验证')
    expect(main.get('[role="alert"] h2').text()).toBe('管理员身份未通过')
    expect(wrapper.get('[role="alert"]').text()).toContain('管理员身份未通过')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it.each([401, 403])(
    'treats an initial non-JSON Cloudflare Access %s response as unauthorized',
    async (status) => {
      const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
        new Response('<html>Cloudflare Access</html>', {
          status,
          headers: { 'content-type': 'text/html' },
        }),
      )
      const api = createAdminApi(createHttpClient(fetchImpl))
      const wrapper = mount(AdminGate, {
        props: { api },
        slots: { default: '<div data-admin-workspace>私有业务数据</div>' },
        global: { stubs: { RouterView: true } },
      })

      await flushPromises()

      expect(wrapper.get('[role="alert"] h2').text()).toBe('管理员身份未通过')
      expect(wrapper.text()).not.toContain('无法验证管理员身份')
      expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
      expect(wrapper.find('button').exists()).toBe(false)
    },
  )

  it.each([
    {
      label: 'a non-JSON 500 response',
      response: () => new Response('<html>Server error</html>', { status: 500 }),
    },
    {
      label: 'an invalid 200 JSON response',
      response: () => Response.json({ unexpected: true }),
    },
  ])('keeps $label on the retryable verification-error path', async ({ response }) => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(response())
    const api = createAdminApi(createHttpClient(fetchImpl))
    const wrapper = mount(AdminGate, {
      props: { api },
      slots: { default: '<div data-admin-workspace>私有业务数据</div>' },
      global: { stubs: { RouterView: true } },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"] h2').text()).toBe('无法验证管理员身份')
    expect(wrapper.get('button').text()).toBe('重新验证')
    expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
  })

  it('allows an explicit retry after a temporary identity-check failure', async () => {
    const api = {
      getAdminSession: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockResolvedValueOnce({ id: 'admin-1', source: 'cloudflare_access' as const }),
    }
    const wrapper = mount(AdminGate, {
      props: { api },
      slots: { default: '<div data-admin-workspace>私有业务数据</div>' },
    })

    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('无法验证管理员身份')

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-admin-workspace]').text()).toBe('私有业务数据')
    expect(api.getAdminSession).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403])(
    'fails closed and unmounts stale business state when an admin request returns %s',
    async (status) => {
      let resolveRequest: ((response: Response) => void) | undefined
      let businessWorkspaceUnmounted = false
      const response = new Promise<Response>((resolve) => {
        resolveRequest = resolve
      })
      const fetchImpl = vi.fn<FetchImplementation>().mockReturnValue(response)
      const BusinessWorkspace = defineComponent({
        setup() {
          const api = createAdminApi(createHttpClient(fetchImpl))
          onMounted(() => {
            void api.listSourceVersions().catch(() => undefined)
          })
          onUnmounted(() => {
            businessWorkspaceUnmounted = true
          })
          return () => h('div', { 'data-admin-workspace': '' }, '旧页面私有状态')
        },
      })
      const wrapper = mount(AdminGate, {
        props: {
          api: {
            getAdminSession: vi.fn().mockResolvedValue({
              id: 'admin-1',
              source: 'cloudflare_access' as const,
            }),
          },
        },
        slots: { default: () => h(BusinessWorkspace) },
      })

      await flushPromises()
      expect(wrapper.get('[data-admin-workspace]').text()).toBe('旧页面私有状态')

      resolveRequest?.(
        Response.json(
          {
            ok: false,
            error: { code: 'unauthorized', message: 'Admin identity expired' },
          },
          { status },
        ),
      )
      await flushPromises()

      expect(wrapper.get('main h1').text()).toBe('管理端身份验证')
      expect(wrapper.get('[role="alert"]').text()).toContain('管理员身份未通过')
      expect(wrapper.find('[data-admin-workspace]').exists()).toBe(false)
      expect(businessWorkspaceUnmounted).toBe(true)
    },
  )
})
