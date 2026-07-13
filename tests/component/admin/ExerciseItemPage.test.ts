import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
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

const mountPage = (api: ExerciseItemApi) =>
  mount(ExerciseItemPage, {
    props: { api, versionId: 'version-1', itemId: 'item-1' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })

describe('ExerciseItemPage', () => {
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

    expect(wrapper.get('[role="alert"]').text()).toContain('答案必须是选项之一')
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
    expect(wrapper.findAll('input').every((input) => input.attributes('disabled') !== undefined)).toBe(
      true,
    )
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
