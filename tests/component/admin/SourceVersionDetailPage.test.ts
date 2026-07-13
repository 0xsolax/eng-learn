import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import SourceVersionDetailPage from '@/pages/admin/SourceVersionDetailPage.vue'

type VersionDetailApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItems'
  | 'buildSourceVersion'
  | 'discardSourceVersion'
  | 'getCoverage'
  | 'getSourceVersion'
  | 'listExerciseItems'
  | 'publishSourceVersion'
>

const missingItem = {
  word: 'apple',
  stage: 'S1' as const,
  taskType: 'recall_word' as const,
  reason: 'exercise_item_draft' as const,
}

const draftDetail = {
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
  missingItems: [missingItem],
}

const readyDetail = {
  ...draftDetail,
  approvedItemCount: 1,
  readyToPublish: true,
  missingItems: [],
}

const draftCoverage = {
  sourceVersionId: 'version-1',
  wordCount: 1,
  readyToPublish: false,
  cells: [
    {
      wordId: 'word-1',
      word: 'apple',
      stage: 'S1' as const,
      taskType: 'recall_word' as const,
      status: 'draft' as const,
      itemId: 'item-1',
      reason: 'exercise_item_draft' as const,
    },
  ],
  missingItems: [missingItem],
}

const readyCoverage = {
  ...draftCoverage,
  readyToPublish: true,
  cells: draftCoverage.cells.map((cell) => ({ ...cell, status: 'approved' as const })),
  missingItems: [],
}

const draftExercise = {
  id: 'item-1',
  sourceVersionId: 'version-1',
  wordId: 'word-1',
  word: 'apple',
  status: 'draft' as const,
  stage: 'S1' as const,
  taskType: 'recall_word' as const,
  prompt: { meaning: '苹果' },
  answer: { word: 'apple' },
}

const mountPage = (api: VersionDetailApi, attachTo?: HTMLElement) =>
  mount(SourceVersionDetailPage, {
    props: { api, versionId: 'version-1' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    ...(attachTo ? { attachTo } : {}),
  })

describe('SourceVersionDetailPage', () => {
  it('chunks a selection larger than the shared API limit and refreshes once after all batches', async () => {
    const draftItems = Array.from({ length: 501 }, (_, index) => ({
      ...draftExercise,
      id: `item-${String(index + 1)}`,
      wordId: `word-${String(index + 1)}`,
      word: `word-${String(index + 1)}`,
    }))
    const approvedItems = draftItems.map((item) => ({
      ...item,
      status: 'approved' as const,
    }))
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce({ ...draftDetail, exerciseItemCount: 501 })
        .mockResolvedValueOnce({
          ...readyDetail,
          wordCount: 501,
          groupCount: 101,
          exerciseItemCount: 501,
          approvedItemCount: 501,
        }),
      getCoverage: vi
        .fn()
        .mockResolvedValueOnce(draftCoverage)
        .mockResolvedValueOnce(readyCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValueOnce(draftItems)
        .mockResolvedValueOnce(approvedItems),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi
        .fn()
        .mockResolvedValueOnce({ approvedCount: 500 })
        .mockResolvedValueOnce({ approvedCount: 1 }),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-select-all]').setValue(true)
    await wrapper.get('[data-approve-selected]').trigger('click')
    await flushPromises()

    expect(api.approveExerciseItems).toHaveBeenCalledTimes(2)
    expect(api.approveExerciseItems).toHaveBeenNthCalledWith(1, {
      itemIds: Array.from({ length: 500 }, (_, index) => `item-${String(index + 1)}`),
    })
    expect(api.approveExerciseItems.mock.calls[1]?.[0]).toEqual({ itemIds: ['item-501'] })
    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('已批准 501 个练习项目')
  })

  it('re-reads authoritative state when a later approval batch fails after partial success', async () => {
    const draftItems = Array.from({ length: 501 }, (_, index) => ({
      ...draftExercise,
      id: `item-${String(index + 1)}`,
      wordId: `word-${String(index + 1)}`,
      word: `word-${String(index + 1)}`,
    }))
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue({ ...draftDetail, exerciseItemCount: 501 }),
      getCoverage: vi.fn().mockResolvedValue(draftCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValueOnce(draftItems)
        .mockResolvedValueOnce([
          ...draftItems.slice(0, 500).map((item) => ({ ...item, status: 'approved' as const })),
          draftItems[500],
        ]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi
        .fn()
        .mockResolvedValueOnce({ approvedCount: 500 })
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline'))),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-select-all]').setValue(true)
    await wrapper.get('[data-approve-selected]').trigger('click')
    await flushPromises()

    expect(api.approveExerciseItems).toHaveBeenCalledTimes(2)
    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toContain(
      '已确认批准 500 个练习项目，后续批次未完成',
    )
    expect(wrapper.findAll('.approval li input[type="checkbox"]')).toHaveLength(1)
  })

  it('uses server coverage to approve selected drafts before enabling publish confirmation', async () => {
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(draftDetail)
        .mockResolvedValueOnce(readyDetail)
        .mockResolvedValueOnce({
          ...readyDetail,
          status: 'published' as const,
          publishedAt: '2026-07-13T01:00:00.000Z',
        }),
      getCoverage: vi
        .fn()
        .mockResolvedValueOnce(draftCoverage)
        .mockResolvedValueOnce(readyCoverage)
        .mockResolvedValueOnce(readyCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValueOnce([draftExercise])
        .mockResolvedValueOnce([{ ...draftExercise, status: 'approved' as const }])
        .mockResolvedValueOnce([{ ...draftExercise, status: 'approved' as const }]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn().mockResolvedValue({ approvedCount: 1 }),
      publishSourceVersion: vi.fn().mockResolvedValue({
        sourceVersionId: 'version-1',
        status: 'published' as const,
      }),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[data-publish]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-blockers]').text()).toContain('apple · S1')
    expect(wrapper.get('[data-coverage-table]').text()).toContain('待审批')

    await wrapper.get('input[type="checkbox"][value="item-1"]').setValue(true)
    await wrapper.get('[data-approve-selected]').trigger('click')
    await flushPromises()

    expect(api.approveExerciseItems).toHaveBeenCalledWith({ itemIds: ['item-1'] })
    expect(wrapper.get('[data-publish]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('服务端确认可发布')

    await wrapper.get('[data-publish]').trigger('click')
    expect(api.publishSourceVersion).not.toHaveBeenCalled()
    expect(wrapper.get('[data-inline-confirmation]').text()).toContain('发布后不可原地修改')
    expect(wrapper.get('[data-inline-confirmation]').attributes('role')).toBe('region')
    expect(wrapper.get('[data-inline-confirmation]').attributes('aria-modal')).toBeUndefined()

    await wrapper.get('[data-confirm-publish]').trigger('click')
    await flushPromises()

    expect(api.publishSourceVersion).toHaveBeenCalledWith('version-1')
    expect(api.getSourceVersion).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('已发布，只读')
    expect(wrapper.find('[data-build]').exists()).toBe(false)
  })

  it('invalidates stale controls when publish succeeds but the authoritative refresh fails', async () => {
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(readyDetail)
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline'))),
      getCoverage: vi.fn().mockResolvedValue(readyCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValue([{ ...draftExercise, status: 'approved' as const }]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn().mockResolvedValue({
        sourceVersionId: 'version-1',
        status: 'published' as const,
      }),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-publish]').trigger('click')
    await wrapper.get('[data-confirm-publish]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('服务端已接受发布，但重新读取版本状态失败')
    expect(wrapper.find('[data-version-workspace]').exists()).toBe(false)
    expect(wrapper.find('[data-publish]').exists()).toBe(false)
  })

  it('recovers the published state when the publish response is lost after commit', async () => {
    const publishedDetail = {
      ...readyDetail,
      status: 'published' as const,
      publishedAt: '2026-07-13T01:00:00.000Z',
    }
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(readyDetail)
        .mockResolvedValueOnce(publishedDetail),
      getCoverage: vi.fn().mockResolvedValue(readyCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValue([{ ...draftExercise, status: 'approved' as const }]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('response lost')),
      ),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-publish]').trigger('click')
    await wrapper.get('[data-confirm-publish]').trigger('click')
    await flushPromises()

    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="status"]').text()).toContain('已发布，只读')
    expect(wrapper.find('[data-publish]').exists()).toBe(false)
  })

  it('shows a published version as immutable and offers the explicit next-version route', async () => {
    const published = {
      ...readyDetail,
      status: 'published' as const,
      publishedAt: '2026-07-13T01:00:00.000Z',
    }
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(published),
      getCoverage: vi.fn().mockResolvedValue(readyCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValue([{ ...draftExercise, status: 'approved' as const }]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toContain('已发布，只读')
    expect(wrapper.find('[data-build]').exists()).toBe(false)
    expect(wrapper.find('[data-publish]').exists()).toBe(false)
    expect(wrapper.get('[data-next-version]').text()).toContain('创建下一草稿版本')
  })

  it('re-reads the complete server workspace after discarding a draft', async () => {
    const archivedDetail = { ...draftDetail, status: 'archived' as const }
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(draftDetail)
        .mockResolvedValueOnce(archivedDetail),
      getCoverage: vi
        .fn()
        .mockResolvedValueOnce(draftCoverage)
        .mockResolvedValueOnce(draftCoverage),
      listExerciseItems: vi
        .fn()
        .mockResolvedValueOnce([draftExercise])
        .mockResolvedValueOnce([draftExercise]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn().mockResolvedValue({
        sourceVersionId: 'version-1',
        sourceId: 'source-1',
        status: 'archived' as const,
      }),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-discard]').trigger('click')
    await wrapper.get('[data-confirm-discard]').trigger('click')
    await flushPromises()

    expect(api.discardSourceVersion).toHaveBeenCalledWith('version-1')
    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('草稿已丢弃')
    expect(wrapper.find('[data-build]').exists()).toBe(false)
  })

  it('recovers the archived state when the discard response is lost after commit', async () => {
    const archivedDetail = { ...draftDetail, status: 'archived' as const }
    const api = {
      getSourceVersion: vi
        .fn()
        .mockResolvedValueOnce(draftDetail)
        .mockResolvedValueOnce(archivedDetail),
      getCoverage: vi.fn().mockResolvedValue(draftCoverage),
      listExerciseItems: vi.fn().mockResolvedValue([draftExercise]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('response lost')),
      ),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-discard]').trigger('click')
    await wrapper.get('[data-confirm-discard]').trigger('click')
    await flushPromises()

    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('已丢弃')
    expect(wrapper.find('[data-build]').exists()).toBe(false)
  })

  it.each([
    ['publish', '[data-publish]'],
    ['discard', '[data-discard]'],
  ] as const)(
    'announces the %s confirmation and restores its trigger after escape or cancel',
    async (_kind, triggerSelector) => {
      const api = {
        getSourceVersion: vi.fn().mockResolvedValue(readyDetail),
        getCoverage: vi.fn().mockResolvedValue(readyCoverage),
        listExerciseItems: vi
          .fn()
          .mockResolvedValue([{ ...draftExercise, status: 'approved' as const }]),
        buildSourceVersion: vi.fn(),
        approveExerciseItems: vi.fn(),
        publishSourceVersion: vi.fn(),
        discardSourceVersion: vi.fn(),
      }
      const wrapper = mountPage(api, document.body)
      await flushPromises()

      const trigger = wrapper.get(triggerSelector)
      ;(trigger.element as HTMLButtonElement).focus()
      await trigger.trigger('click')
      await flushPromises()

      const confirmation = wrapper.get('[data-inline-confirmation]')
      expect(confirmation.attributes('role')).toBe('region')
      expect(confirmation.attributes('aria-live')).toBe('polite')
      expect(confirmation.attributes('aria-atomic')).toBe('true')
      expect(confirmation.attributes('tabindex')).toBe('-1')
      expect(document.activeElement).toBe(confirmation.element)

      await confirmation.trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(wrapper.find('[data-inline-confirmation]').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger.element)

      await trigger.trigger('click')
      await flushPromises()
      const cancel = wrapper
        .findAll('button')
        .find((button) => button.text() === '取消')
      expect(cancel).toBeDefined()
      await cancel?.trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-inline-confirmation]').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger.element)
      wrapper.unmount()
    },
  )

  it('preserves loaded detail and exposes a retry when a build conflicts', async () => {
    const api = {
      getSourceVersion: vi.fn().mockResolvedValue(draftDetail),
      getCoverage: vi.fn().mockResolvedValue(draftCoverage),
      listExerciseItems: vi.fn().mockResolvedValue([draftExercise]),
      buildSourceVersion: vi.fn().mockRejectedValue(
        new ApiFailureError(409, { code: 'conflict', message: 'Concurrent build' }),
      ),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()
    await wrapper.get('[data-build]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('构建未完成')
    expect(wrapper.text()).toContain('Starter words')
    expect(wrapper.get('[data-build]').text()).toContain('重新构建')
  })

  it('does not render stale business content when the detail read fails', async () => {
    const api = {
      getSourceVersion: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      getCoverage: vi.fn().mockResolvedValue(draftCoverage),
      listExerciseItems: vi.fn().mockResolvedValue([draftExercise]),
      buildSourceVersion: vi.fn(),
      approveExerciseItems: vi.fn(),
      publishSourceVersion: vi.fn(),
      discardSourceVersion: vi.fn(),
    }
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取版本详情')
    expect(wrapper.find('[data-version-workspace]').exists()).toBe(false)
  })
})
