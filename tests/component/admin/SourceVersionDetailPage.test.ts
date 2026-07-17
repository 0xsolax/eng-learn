import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { createAdminApi } from '@/api/adminApi'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import {
  adminPageContextKey,
  type AdminPageContextPort,
} from '@/features/admin-auth/adminPageContext'
import SourceVersionDetailPage from '@/pages/admin/SourceVersionDetailPage.vue'
import type {
  AdminExerciseItemDto,
  BuildCoverageDto,
  ExerciseReviewWindowDto,
  SourceVersionDetailDto,
} from '@shared/api/contentSchemas'

type VersionDetailApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItems'
  | 'buildSourceVersion'
  | 'discardSourceVersion'
  | 'getCoverage'
  | 'getExerciseReviewWindow'
  | 'getSourceVersion'
  | 'listExerciseItems'
  | 'publishSourceVersion'
>
type VersionDetailApiInput = Omit<VersionDetailApi, 'getExerciseReviewWindow'> &
  Partial<Pick<VersionDetailApi, 'getExerciseReviewWindow'>>

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

const draftReviewSummary = {
  sourceVersionId: 'version-1',
  sourceName: 'Starter words',
  versionNo: 1,
  contentRevision: 0,
  totalCount: 1,
  approvedCount: 0,
  pendingCount: 1,
  needsReworkCount: 0,
  disabledCount: 0,
  allApproved: false,
  firstItemId: 'item-1',
  current: {
    id: 'item-1',
    wordId: 'word-1',
    word: 'apple',
    wordOrderIndex: 1,
    position: 1,
    stage: 'S1',
    taskType: 'recall_word',
    status: 'draft',
    reviewState: 'pending_review',
    prompt: { meaning: '苹果' },
  },
} as const satisfies ExerciseReviewWindowDto

const createPageContext = (): AdminPageContextPort => ({
  setPageContext: vi.fn(),
  clearPageContext: vi.fn(),
})

const mountPage = (
  api: VersionDetailApiInput,
  attachTo?: HTMLElement,
  pageContext: AdminPageContextPort = createPageContext(),
) =>
  mount(SourceVersionDetailPage, {
    props: {
      api: {
        getExerciseReviewWindow: vi.fn().mockResolvedValue(draftReviewSummary),
        ...api,
      },
      versionId: 'version-1',
    },
    global: {
      provide: { [adminPageContextKey]: pageContext },
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
    ...(attachTo ? { attachTo } : {}),
  })

describe('SourceVersionDetailPage', () => {
  it('reports authoritative source and version breadcrumbs and clears them on unmount', async () => {
    const pageContext = createPageContext()
    const wrapper = mountPage(createDraftApi(), undefined, pageContext)
    await flushPromises()

    expect(pageContext.setPageContext).toHaveBeenCalledWith({
      breadcrumbs: ['词库工作台', 'Starter words', 'v1'],
    })

    wrapper.unmount()
    expect(pageContext.clearPageContext).toHaveBeenCalledOnce()
  })

  it('orders the unique command bar before pipeline, blockers, matrix, and approval', async () => {
    const api = createDraftApi()
    const wrapper = mountPage(api)
    await flushPromises()

    const command = wrapper.get('[data-command-bar]').element
    const pipeline = wrapper.get('[data-pipeline]').element
    const blockers = wrapper.get('[data-blockers]').element
    const matrix = wrapper.get('[data-coverage-matrix]').element
    const approval = wrapper.get('[data-approval-list]').element

    expect(wrapper.findAll('[data-command-bar]')).toHaveLength(1)
    expect(isBefore(command, pipeline)).toBe(true)
    expect(isBefore(pipeline, blockers)).toBe(true)
    expect(isBefore(blockers, matrix)).toBe(true)
    expect(isBefore(matrix, approval)).toBe(true)
    expect(wrapper.get('[data-publish-blocker]').text()).toContain('当前有 1 项发布阻断')
  })

  it('groups coverage into one word row with S0-S5 facts and only links real items', async () => {
    const stages = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const
    const statuses = {
      S0: 'approved',
      S1: 'draft',
      S2: 'missing',
      S3: 'disabled',
      S4: 'approved',
      S5: 'approved',
    } as const
    const cells = stages.map((stage, index) => ({
      wordId: 'word-1',
      word: 'apple',
      stage,
      taskType: index === 0 ? 'recognize_meaning' as const : 'recall_word' as const,
      status: statuses[stage],
      ...(index === 0 || index === 1 || index === 3
        ? { itemId: `item-${String(index)}` }
        : {}),
    }))
    const api = createDraftApi({
      coverage: {
        ...draftCoverage,
        cells,
      },
    })
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.findAll('[data-matrix-stage]')).toHaveLength(6)
    expect(wrapper.findAll('[data-matrix-row]')).toHaveLength(1)
    const row = wrapper.get('[data-matrix-row]')
    expect(row.text()).toContain('apple')
    expect(row.text()).toContain('已批准')
    expect(row.text()).toContain('待审批')
    expect(row.text()).toContain('缺失')
    expect(row.text()).toContain('已禁用')
    expect(row.findAll('a')).toHaveLength(3)
    expect(row.find('[data-stage="S2"] a').exists()).toBe(false)
  })

  it('shows an explicit empty state when the gap filter has no matching word', async () => {
    const api = createDraftApi({
      detail: readyDetail,
      coverage: readyCoverage,
      items: [{ ...draftExercise, status: 'approved' as const }],
    })
    const wrapper = mountPage(api)
    await flushPromises()

    await wrapper.get('[data-gap-filter]').setValue(true)

    expect(wrapper.get('[data-gap-empty]').text()).toContain('当前条件下没有缺口')
    expect(wrapper.findAll('[data-matrix-row]')).toHaveLength(0)
  })

  it('shows one-click approval without select-all or per-item checkboxes', async () => {
    const secondDraft = {
      ...draftExercise,
      id: 'item-2',
      wordId: 'word-2',
      word: 'pear',
    }
    const api = createDraftApi({ items: [draftExercise, secondDraft] })
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[data-approval-list]').text()).toContain('待审阅 2')
    expect(wrapper.get('[data-enter-review]').text()).toContain('进入审阅模式')
    expect(wrapper.get('[data-approve-all]').text()).toContain('全部通过（2 项）')
    expect(wrapper.find('[data-select-all]').exists()).toBe(false)
    expect(wrapper.find('[data-selection-count]').exists()).toBe(false)
    expect(wrapper.findAll('[data-approval-list] input[type="checkbox"]')).toHaveLength(0)
  })

  it('fails closed when coverage has blockers that approval cannot resolve', async () => {
    const api = createDraftApi({
      coverage: {
        ...draftCoverage,
        missingItems: [
          ...draftCoverage.missingItems,
          {
            word: 'pear',
            stage: 'S2',
            taskType: 'multiple_choice',
            reason: 'exercise_item_required',
          },
        ],
      },
    })
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[data-approve-all]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-approve-all]').trigger('click')
    expect(api.approveExerciseItems).not.toHaveBeenCalled()
  })

  it('shows authoritative review counts and blocks one-click approval while feedback needs rework', async () => {
    const needsReworkSummary = {
      ...draftReviewSummary,
      pendingCount: 0,
      needsReworkCount: 1,
      current: {
        ...draftReviewSummary.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '提示需要重构',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const api = createDraftApi({ review: needsReworkSummary })
    const wrapper = mountPage(api)
    await flushPromises()

    expect(wrapper.get('[data-review-summary]').text()).toContain('需重构 1')
    expect(wrapper.get('[data-approve-all]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-approve-all]').trigger('click')
    expect(api.approveExerciseItems).not.toHaveBeenCalled()
  })

  it('does not show one-click approval when no draft remains', async () => {
    const wrapper = mountPage(createDraftApi({
      detail: readyDetail,
      coverage: readyCoverage,
      items: [{ ...draftExercise, status: 'approved' }],
    }))
    await flushPromises()

    expect(wrapper.find('[data-approval-list]').exists()).toBe(false)
    expect(wrapper.find('[data-approve-all]').exists()).toBe(false)
    expect(wrapper.get('[data-enter-review]').text()).toContain('进入审阅模式')
  })

  it('renders a blocker processing route only when coverage exposes a real item', async () => {
    const noItemBlocker = {
      word: 'pear',
      stage: 'S2' as const,
      taskType: 'multiple_choice' as const,
      reason: 'exercise_item_required' as const,
    }
    const draftCell = draftCoverage.cells[0]
    if (!draftCell) throw new Error('Expected the draft coverage fixture cell')
    const api = createDraftApi({
      detail: { ...draftDetail, missingItems: [missingItem, noItemBlocker] },
      coverage: {
        ...draftCoverage,
        cells: [
          draftCell,
          {
            wordId: 'word-2',
            word: 'pear',
            stage: 'S2' as const,
            taskType: 'multiple_choice' as const,
            status: 'missing' as const,
            reason: 'exercise_item_required' as const,
          },
        ],
      },
    })
    const wrapper = mountPage(api)
    await flushPromises()

    const blockers = wrapper.findAll('[data-blocker-item]')
    expect(blockers).toHaveLength(2)
    expect(blockers[0]?.text()).toContain('apple · S1')
    expect(blockers[0]?.text()).toContain('题型 回忆单词')
    expect(blockers[0]?.text()).toContain('原因 练习待审批')
    expect(blockers[0]?.find('a').text()).toContain('打开练习')
    expect(blockers[1]?.find('a').exists()).toBe(false)
    expect(blockers[1]?.text()).toContain('暂无可处理项目')
  })

  it('removes every detail mutation at 479px and restores draft actions at 480px', async () => {
    const compact = installMatchMedia(true)
    const compactWrapper = mountPage(createDraftApi())
    await flushPromises()

    expect(compactWrapper.get('[data-compact-readonly]').text()).toContain('480px')
    expect(compactWrapper.find('[data-command-bar]').exists()).toBe(false)
    expect(compactWrapper.find('[data-approval-list]').exists()).toBe(false)
    compactWrapper.unmount()
    compact.restore()

    const editable = installMatchMedia(false)
    const editableWrapper = mountPage(createDraftApi())
    await flushPromises()

    expect(editableWrapper.find('[data-command-bar]').exists()).toBe(true)
    expect(editableWrapper.find('[data-approval-list]').exists()).toBe(true)
    editableWrapper.unmount()
    editable.restore()
  })

  it('removes the published next-version mutation at 479px and restores it at 480px', async () => {
    const published = {
      ...readyDetail,
      status: 'published' as const,
      publishedAt: '2026-07-13T01:00:00.000Z',
    }
    const compact = installMatchMedia(true)
    const compactWrapper = mountPage(createDraftApi({ detail: published }))
    await flushPromises()
    expect(compactWrapper.find('[data-next-version]').exists()).toBe(false)
    compactWrapper.unmount()
    compact.restore()

    const editable = installMatchMedia(false)
    const editableWrapper = mountPage(createDraftApi({ detail: published }))
    await flushPromises()
    expect(editableWrapper.get('[data-next-version]').text()).toContain('创建下一草稿版本')
    editableWrapper.unmount()
    editable.restore()
  })

  it('chunks one-click approval larger than the shared API limit and refreshes once after all batches', async () => {
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

    await wrapper.get('[data-approve-all]').trigger('click')
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

    await wrapper.get('[data-approve-all]').trigger('click')
    await flushPromises()

    expect(api.approveExerciseItems).toHaveBeenCalledTimes(2)
    expect(api.getSourceVersion).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toContain(
      '已确认批准 500 个练习项目，后续批次未完成',
    )
    expect(wrapper.get('[data-approve-all]').text()).toContain('全部通过（1 项）')
    expect(wrapper.findAll('[data-approval-list] input[type="checkbox"]')).toHaveLength(0)
  })

  it('uses server coverage to approve all drafts before enabling publish confirmation', async () => {
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

    await wrapper.get('[data-approve-all]').trigger('click')
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
    expect(wrapper.find('[data-discard]').exists()).toBe(false)
    expect(wrapper.find('[data-approve-all]').exists()).toBe(false)
    expect(wrapper.find('[data-select-all]').exists()).toBe(false)
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

const createDraftApi = (overrides: {
  detail?: SourceVersionDetailDto
  coverage?: BuildCoverageDto
  items?: AdminExerciseItemDto[]
  review?: ExerciseReviewWindowDto
} = {}): VersionDetailApi => {
  const items = overrides.items ?? [draftExercise]
  const draftCount = items.filter((item) => item.status === 'draft').length
  const approvedCount = items.filter((item) => item.status === 'approved').length
  const disabledCount = items.filter((item) => item.status === 'disabled').length
  const derivedReview = {
    ...draftReviewSummary,
    totalCount: items.length,
    pendingCount: draftCount,
    approvedCount,
    disabledCount,
    allApproved: items.length > 0 && approvedCount === items.length,
  }

  return {
    getSourceVersion: vi.fn().mockResolvedValue(overrides.detail ?? draftDetail),
    getCoverage: vi.fn().mockResolvedValue(overrides.coverage ?? draftCoverage),
    listExerciseItems: vi.fn().mockResolvedValue(items),
    getExerciseReviewWindow: vi.fn().mockResolvedValue(overrides.review ?? derivedReview),
    buildSourceVersion: vi.fn(),
    approveExerciseItems: vi.fn(),
    publishSourceVersion: vi.fn(),
    discardSourceVersion: vi.fn(),
  }
}

const isBefore = (first: Element, second: Element): boolean =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

const installMatchMedia = (matches: boolean) => {
  const previous = window.matchMedia
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '(max-width: 479px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })

  return {
    restore: () => {
      window.matchMedia = previous
    },
  }
}
