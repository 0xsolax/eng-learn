import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import AdminLayout from '@/app/layouts/AdminLayout.vue'
import {
  adminPageContextKey,
  type AdminPageContextPort,
} from '@/features/admin-auth/adminPageContext'
import { adminSessionContextKey } from '@/features/admin-auth/adminSessionContext'
import ExerciseItemPage from '@/pages/admin/ExerciseItemPage.vue'

type ExerciseItemApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItem'
  | 'disableExerciseItem'
  | 'editExerciseItem'
  | 'getExerciseItem'
  | 'getSourceVersion'
>

const draftVersion = {
  sourceId: 'source-1',
  sourceName: 'Starter words',
  versionId: 'version-1',
  versionNo: 1,
  status: 'draft' as const,
  wordCount: 1,
  groupCount: 1,
  exerciseItemCount: 1,
  approvedItemCount: 0,
  createdAt: '2026-07-13T00:00:00.000Z',
  readyToPublish: false,
  missingItems: [],
}

const multipleChoiceItem = {
  id: 'item-1',
  sourceVersionId: 'version-1',
  wordId: 'word-1',
  word: 'apple',
  status: 'draft' as const,
  stage: 'S2' as const,
  taskType: 'multiple_choice' as const,
  prompt: { meaning: '苹果', options: ['apple', 'pear', 'banana'] },
  answer: { word: 'apple' },
}

const createPageContext = (): AdminPageContextPort => ({
  setPageContext: vi.fn(),
  clearPageContext: vi.fn(),
})

const mountPage = (
  api: ExerciseItemApi,
  pageContext: AdminPageContextPort = createPageContext(),
) =>
  mount(ExerciseItemPage, {
    props: { api, versionId: 'version-1', itemId: 'item-1' },
    global: {
      provide: { [adminPageContextKey]: pageContext },
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  })

afterEach(() => {
  setViewportWidth(1024)
  Reflect.deleteProperty(window, 'confirm')
})

describe('ExerciseItemPage', () => {
  it('reports authoritative exercise breadcrumbs and exposes the same dirty leave guard', async () => {
    const pageContext = createPageContext()
    const confirm = vi.fn().mockReturnValue(false)
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: confirm,
    })
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api, pageContext)
    await flushPromises()

    const reportedContext = vi.mocked(pageContext.setPageContext).mock
      .calls[0]?.[0]
    expect(reportedContext?.breadcrumbs).toEqual([
      '词库工作台',
      'Starter words',
      'v1',
      'apple',
      'S2',
    ])
    expect(typeof reportedContext?.confirmLeave).toBe('function')
    expect(await reportedContext?.confirmLeave?.()).toBe(true)

    await wrapper.get('input[name="meaning"]').setValue('一种水果')
    expect(await reportedContext?.confirmLeave?.()).toBe(false)
    expect(confirm).toHaveBeenCalledWith('当前练习有未保存修改，确定离开吗？')

    wrapper.unmount()
    expect(pageContext.clearPageContext).toHaveBeenCalledOnce()
  })

  it('edits a draft through task-specific fields instead of raw JSON', async () => {
    const editedItem = {
      ...multipleChoiceItem,
      prompt: { meaning: '一种水果', options: ['apple', 'pear', 'banana'] },
    }
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn().mockResolvedValue(editedItem),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('h1').text()).toContain('apple')
    expect(wrapper.find('textarea[name="raw-json"]').exists()).toBe(false)
    expect(wrapper.get('textarea[name="options"]').element).toHaveProperty(
      'value',
      'apple\npear\nbanana',
    )

    await wrapper.get('input[name="meaning"]').setValue('一种水果')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.editExerciseItem).toHaveBeenCalledWith('item-1', {
      content: {
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: {
          meaning: '一种水果',
          options: ['apple', 'pear', 'banana'],
        },
        answer: { word: 'apple' },
      },
    })
    expect(wrapper.get('[role="status"]').text()).toContain('练习内容已保存')
  })

  it('blocks an invalid structured answer before sending a write request', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('input[name="answer-word"]').setValue('orange')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const answerInput = wrapper.get('input[name="answer-word"]')
    const fieldErrorId = answerInput.attributes('aria-describedby')
    expect(answerInput.attributes('aria-invalid')).toBe('true')
    expect(fieldErrorId).toBeDefined()
    expect(wrapper.get(`[id="${String(fieldErrorId)}"]`).text()).toContain(
      '答案必须是选项之一',
    )
    expect(wrapper.get('[data-form-error-summary]').text()).toContain('字段问题')
    expect(api.editExerciseItem).not.toHaveBeenCalled()
  })

  it('renders every control read-only when the server reports a published version', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue({
        ...draftVersion,
        status: 'published' as const,
        readyToPublish: true,
        publishedAt: '2026-07-13T01:00:00.000Z',
      }),
      getExerciseItem: vi.fn().mockResolvedValue({
        ...multipleChoiceItem,
        status: 'approved' as const,
      }),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toContain('已发布版本只读')
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false)
    expect(wrapper.find('[data-approve]').exists()).toBe(false)
    expect(wrapper.findAll('button').some((button) => button.text() === '禁用项目')).toBe(false)
    expect(wrapper.findAll('input').every((input) => input.attributes('disabled') !== undefined)).toBe(
      true,
    )
  })

  it('guards route and browser exits only while task fields are dirty', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/admin',
          component: AdminLayout,
          children: [
            {
              path: 'exercise',
              name: 'admin-exercise-item',
              component: ExerciseItemPage,
              props: { api, versionId: 'version-1', itemId: 'item-1' },
            },
            {
              path: 'next',
              name: 'admin-courses',
              component: { template: '<p>next page</p>' },
            },
          ],
        },
      ],
    })
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const confirm = vi.fn().mockReturnValue(false)
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: confirm,
    })

    await router.push('/admin/exercise')
    await router.isReady()
    const wrapper = mount(RouterView, {
      attachTo: document.body,
      global: {
        plugins: [router],
        provide: {
          [adminSessionContextKey as symbol]: {
            session: ref({
              id: 'admin-1',
              source: 'application_session',
              displayName: 'Solazhu',
            }),
            refreshSession: vi.fn(),
            logout: vi.fn(),
            clearPrivateState: vi.fn(),
          },
        },
      },
    })
    await flushPromises()

    expect(addEventListener.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false)
    const input = wrapper.get('input[name="meaning"]')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('一种水果')
    await nextTick()

    expect(addEventListener.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    await router.push('/admin/next')
    expect(confirm).toHaveBeenCalledWith('当前练习有未保存修改，确定离开吗？')
    expect(router.currentRoute.value.path).toBe('/admin/exercise')
    expect(document.activeElement).toBe(input.element)

    confirm.mockClear()
    confirm.mockReturnValue(true)
    await router.push('/admin/next')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/admin/next')
    expect(removeEventListener.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)

    wrapper.unmount()
    Reflect.deleteProperty(window, 'confirm')
    addEventListener.mockRestore()
    removeEventListener.mockRestore()
  })

  it('removes every edit entrance at 479px and restores the core editor at 480px', async () => {
    setViewportWidth(479)
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[data-mobile-readonly]').text()).toContain('至少 480px')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('[data-mobile-exercise-summary]').text()).toContain('苹果')
    expect(wrapper.get('[data-mobile-exercise-summary]').text()).toContain('apple、pear、banana')
    expect(wrapper.find('[data-approve]').exists()).toBe(false)
    expect(wrapper.findAll('button').some((button) => button.text() === '禁用项目')).toBe(false)

    setViewportWidth(480)
    await nextTick()

    expect(wrapper.find('[data-mobile-readonly]').exists()).toBe(false)
    expect(wrapper.find('form').exists()).toBe(true)
    expect(wrapper.get('button[type="submit"]').text()).toContain('保存练习内容')
    wrapper.unmount()
    setViewportWidth(1024)
  })

  it('reloads authoritative state when a concurrent publish makes a save immutable', async () => {
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(draftVersion)
        .mockResolvedValueOnce({
          ...draftVersion,
          status: 'published' as const,
          readyToPublish: true,
          publishedAt: '2026-07-13T01:00:00.000Z',
        }),
      getExerciseItem: vi
        .fn()
        .mockResolvedValueOnce(multipleChoiceItem)
        .mockResolvedValueOnce({ ...multipleChoiceItem, status: 'approved' as const }),
      editExerciseItem: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'source_version_immutable',
          message: 'Version is immutable',
        }),
      ),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="status"]').text()).toContain('已发布版本只读')
    expect(wrapper.get('[role="alert"]').text()).toContain('服务端已将该版本设为只读')
  })

  it('reloads authoritative content instead of blindly retrying a concurrent edit conflict', async () => {
    const authoritativeItem = {
      ...multipleChoiceItem,
      prompt: {
        ...multipleChoiceItem.prompt,
        meaning: '服务端刚刚更新的词义',
      },
    }
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi
        .fn()
        .mockResolvedValueOnce(multipleChoiceItem)
        .mockResolvedValueOnce(authoritativeItem),
      editExerciseItem: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'conflict',
          message: 'Exercise item changed concurrently',
        }),
      ),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('input[name="meaning"]').setValue('本地尚未保存的词义')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(api.getExerciseItem).toHaveBeenCalledTimes(2)
    expect(wrapper.get<HTMLInputElement>('input[name="meaning"]').element.value).toBe(
      '服务端刚刚更新的词义',
    )
    expect(wrapper.get('[role="alert"]').text()).toContain('检测到其他编辑已更新内容')
  })

  it('preserves unsaved fields and blocks approve or disable until they are saved', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    const input = wrapper.get<HTMLInputElement>('input[name="meaning"]')
    await input.setValue('本地尚未保存的词义')
    const approveButton = wrapper.get<HTMLButtonElement>('[data-approve]')
    const disableButton = wrapper
      .findAll<HTMLButtonElement>('button')
      .find((button) => button.text() === '禁用项目')
    if (!disableButton) throw new Error('Expected the disable action')

    expect(approveButton.element.disabled).toBe(true)
    expect(disableButton.element.disabled).toBe(true)
    expect(wrapper.get('[data-review-dirty-hint]').text()).toContain('请先保存')
    await approveButton.trigger('click')
    await disableButton.trigger('click')

    expect(api.approveExerciseItem).not.toHaveBeenCalled()
    expect(api.disableExerciseItem).not.toHaveBeenCalled()
    expect(wrapper.find('[data-disable-confirmation]').exists()).toBe(false)
    expect(input.element.value).toBe('本地尚未保存的词义')
  })

  it('recovers an approved item when the approve response is lost after commit', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi
        .fn()
        .mockResolvedValueOnce(multipleChoiceItem)
        .mockResolvedValueOnce({ ...multipleChoiceItem, status: 'approved' as const }),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('response lost')),
      ),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-approve]').trigger('click')
    await flushPromises()

    expect(api.getExerciseItem).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-status="approved"]').text()).toBe('已批准')
    expect(wrapper.find('[data-approve]').exists()).toBe(false)
  })

  it('recovers a disabled item when the disable response is lost after commit', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi
        .fn()
        .mockResolvedValueOnce(multipleChoiceItem)
        .mockResolvedValueOnce({ ...multipleChoiceItem, status: 'disabled' as const }),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('response lost')),
      ),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    const disableButton = wrapper.findAll('button').find((button) => button.text() === '禁用项目')
    if (!disableButton) throw new Error('Expected the disable action')
    await disableButton.trigger('click')
    const confirmButton = wrapper
      .get('[data-disable-confirmation]')
      .findAll('button')
      .find((button) => button.text() === '确认禁用')
    if (!confirmButton) throw new Error('Expected the disable confirmation')
    await confirmButton.trigger('click')
    await flushPromises()

    expect(api.getExerciseItem).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-status="disabled"]').text()).toBe('已禁用')
    expect(wrapper.find('[data-disable-confirmation]').exists()).toBe(false)
  })

  it('moves focus into disable confirmation and restores the trigger on cancel', async () => {
    setViewportWidth(1024)
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue(multipleChoiceItem),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mount(ExerciseItemPage, {
      attachTo: document.body,
      props: { api, versionId: 'version-1', itemId: 'item-1' },
      global: {
        provide: { [adminPageContextKey]: createPageContext() },
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    })
    await flushPromises()

    const trigger = wrapper.findAll('button').find((button) => button.text() === '禁用项目')
    expect(trigger).toBeDefined()
    ;(trigger?.element as HTMLButtonElement).focus()
    await trigger?.trigger('click')
    await nextTick()

    const confirmation = wrapper.get('[data-disable-confirmation]')
    expect(document.activeElement).toBe(confirmation.element)
    const cancel = confirmation.findAll('button').find((button) => button.text() === '取消')
    await cancel?.trigger('click')
    await nextTick()

    expect(wrapper.find('[data-disable-confirmation]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger?.element)
    wrapper.unmount()
  })

  it('does not render a partial editor when either required resource fails to load', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取练习项目')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('fails closed when the route version and exercise item belong to different resources', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftVersion),
      getExerciseItem: vi.fn().mockResolvedValue({
        ...multipleChoiceItem,
        sourceVersionId: 'version-2',
      }),
      editExerciseItem: vi.fn(),
      approveExerciseItem: vi.fn(),
      disableExerciseItem: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取练习项目')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(api.editExerciseItem).not.toHaveBeenCalled()
    expect(api.approveExerciseItem).not.toHaveBeenCalled()
    expect(api.disableExerciseItem).not.toHaveBeenCalled()
  })
})

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}
