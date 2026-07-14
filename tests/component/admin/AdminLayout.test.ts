/* eslint-disable vue/one-component-per-file */
import { defineComponent, h, onMounted, ref, type Component } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminLayout from '@/app/layouts/AdminLayout.vue'
import {
  adminPageContextKey,
  useAdminPageContext,
} from '@/features/admin-auth/adminPageContext'
import {
  adminSessionContextKey,
  type AdminSessionContext,
} from '@/features/admin-auth/adminSessionContext'

enableAutoUnmount(afterEach)

const session = {
  id: 'admin-1',
  source: 'application_session' as const,
  displayName: 'Solazhu',
}

const PlainPage = defineComponent({
  setup: () => () => h('h1', '页面内容'),
})

const mountLayout = async ({
  width = 1280,
  page = PlainPage,
  logout = vi.fn().mockResolvedValue(undefined),
}: {
  width?: number
  page?: Component
  logout?: AdminSessionContext['logout']
} = {}) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/admin/login',
        name: 'admin-login',
        component: PlainPage,
        meta: { requiresAdmin: false },
      },
      {
        path: '/admin/source-versions',
        name: 'admin-source-versions',
        component: page,
        meta: { requiresAdmin: true },
      },
      {
        path: '/admin/courses',
        name: 'admin-courses',
        component: PlainPage,
        meta: { requiresAdmin: true },
      },
    ],
  })
  await router.push('/admin/source-versions')
  await router.isReady()
  const sessionContext: AdminSessionContext = {
    session: ref(session),
    refreshSession: vi.fn().mockResolvedValue(session),
    logout,
    clearPrivateState: vi.fn(),
  }
  const wrapper = mount(AdminLayout, {
    global: {
      plugins: [router],
      provide: {
        [adminSessionContextKey as symbol]: sessionContext,
      },
    },
  })
  await flushPromises()

  return { logout, router, wrapper }
}

describe('AdminLayout', () => {
  it.each([
    [1280, 'sidebar'],
    [1024, 'topbar'],
  ] as const)('shows the real identity exactly once at %spx in the %s', async (width, area) => {
    const { wrapper } = await mountLayout({ width })

    const identities = wrapper.findAll('[data-admin-identity]')
    expect(identities).toHaveLength(1)
    expect(identities[0]?.text()).toContain('Solazhu')
    expect(identities[0]?.attributes('data-admin-identity')).toBe(area)
  })

  it('shows the fixed context for the source list route', async () => {
    const { wrapper } = await mountLayout()

    expect(
      wrapper.findAll('[aria-label="当前页面"] li').map((item) => item.text()),
    ).toEqual(['词库工作台', '词库版本'])
  })

  it('uses authoritative page context reported by the loaded child and clears stale context', async () => {
    const ContextPage = defineComponent({
      setup() {
        const pageContext = useAdminPageContext()
        onMounted(() => {
          pageContext.setPageContext({
            breadcrumbs: ['词库工作台', 'Starter words', 'v2'],
          })
        })
        return () => h('h1', '版本详情')
      },
    })
    const { router, wrapper } = await mountLayout({ page: ContextPage })

    expect(
      wrapper.findAll('[aria-label="当前页面"] li').map((item) => item.text()),
    ).toEqual(['词库工作台', 'Starter words', 'v2'])

    await router.push('/admin/courses')
    await flushPromises()

    expect(
      wrapper.findAll('[aria-label="当前页面"] li').map((item) => item.text()),
    ).toEqual(['课程工作台', '学习者与课程'])
    expect(wrapper.text()).not.toContain('Starter words')
  })

  it('keeps the workspace mounted and reports a failed logout', async () => {
    const logout = vi.fn().mockRejectedValue(new Error('logout failed'))
    const { wrapper } = await mountLayout({ logout })

    await wrapper.get('[data-action="admin-logout"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(
      '退出失败，会话仍可能有效，请重试',
    )
    expect(wrapper.find('[data-layout="admin"]').exists()).toBe(true)
  })

  it('does not send logout when a dirty child cancels leaving', async () => {
    const DirtyPage = defineComponent({
      setup() {
        const pageContext = useAdminPageContext()
        onMounted(() => {
          pageContext.setPageContext({
            breadcrumbs: ['练习项目', '编辑'],
            confirmLeave: () => false,
          })
        })
        return () => h('h1', '未保存练习')
      },
    })
    const logout = vi.fn().mockResolvedValue(undefined)
    const { wrapper } = await mountLayout({ page: DirtyPage, logout })

    await wrapper.get('[data-action="admin-logout"]').trigger('click')
    await flushPromises()

    expect(logout).not.toHaveBeenCalled()
  })

  it('fails closed when a dirty leave guard cannot determine the result', async () => {
    const DirtyPage = defineComponent({
      setup() {
        const pageContext = useAdminPageContext()
        onMounted(() => {
          pageContext.setPageContext({
            breadcrumbs: ['练习项目', '编辑'],
            confirmLeave: () => Promise.reject(new Error('dialog unavailable')),
          })
        })
        return () => h('h1', '未保存练习')
      },
    })
    const logout = vi.fn().mockResolvedValue(undefined)
    const { wrapper } = await mountLayout({ page: DirtyPage, logout })

    await wrapper.get('[data-action="admin-logout"]').trigger('click')
    await flushPromises()

    expect(logout).not.toHaveBeenCalled()
  })

  it('uses the same dirty guard for sidebar navigation', async () => {
    const DirtyPage = defineComponent({
      setup() {
        const pageContext = useAdminPageContext()
        onMounted(() => {
          pageContext.setPageContext({
            breadcrumbs: ['练习项目', '编辑'],
            confirmLeave: () => false,
          })
        })
        return () => h('h1', '未保存练习')
      },
    })
    const { router, wrapper } = await mountLayout({ page: DirtyPage })

    await wrapper.get('a[href="/admin/courses"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/admin/source-versions')
  })

  it('cannot let a dirty guard block a forced session-invalid redirect', async () => {
    const DirtyPage = defineComponent({
      setup() {
        const pageContext = useAdminPageContext()
        onMounted(() => {
          pageContext.setPageContext({
            breadcrumbs: ['练习项目', '编辑'],
            confirmLeave: () => false,
          })
        })
        return () => h('h1', '未保存练习')
      },
    })
    const { router } = await mountLayout({ page: DirtyPage })

    await router.push({ name: 'admin-login', query: { reason: 'expired' } })
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/admin/login')
  })

  it('exposes a typed page-context provider to the loaded page', async () => {
    let received = false
    const ContextProbe = defineComponent({
      setup() {
        received = Boolean(useAdminPageContext())
        return () => h('div')
      },
    })
    await mountLayout({ page: ContextProbe })

    expect(received).toBe(true)
    expect(adminPageContextKey).toBeTypeOf('symbol')
  })
})
