import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailureError } from '@/api/errors'
import ExerciseReviewPage from '@/pages/admin/ExerciseReviewPage.vue'

const reviewWindow = {
  sourceVersionId: 'version-1',
  sourceName: 'Starter words',
  versionNo: 1,
  contentRevision: 7,
  totalCount: 2,
  approvedCount: 0,
  pendingCount: 2,
  needsReworkCount: 0,
  disabledCount: 0,
  allApproved: false,
  firstItemId: 'item-1',
  nextItemId: 'item-2',
  current: {
    id: 'item-1',
    wordId: 'word-1',
    word: 'apple',
    wordOrderIndex: 1,
    position: 1,
    stage: 'S2',
    taskType: 'recall_word',
    status: 'draft',
    reviewState: 'pending_review',
    prompt: { meaning: '苹果' },
  },
} as const

const completeWindow = {
  ...reviewWindow,
  contentRevision: 8,
  approvedCount: 2,
  pendingCount: 0,
  allApproved: true,
  current: undefined,
  nextItemId: undefined,
}

const fullExerciseItem = {
  id: 'item-1',
  sourceVersionId: 'version-1',
  wordId: 'word-1',
  word: 'apple',
  stage: 'S2',
  taskType: 'recall_word',
  prompt: { meaning: '苹果' },
  answer: { word: 'apple' },
  status: 'draft',
} as const

const createApi = () => ({
  getExerciseReviewWindow: vi
    .fn()
    .mockResolvedValueOnce(reviewWindow)
    .mockResolvedValueOnce(completeWindow),
  previewExerciseReview: vi.fn(),
  getExerciseItem: vi.fn().mockResolvedValue(fullExerciseItem),
  evaluateExerciseReview: vi.fn().mockResolvedValue({
    exerciseItemId: 'item-1',
    score: 2,
    correct: true,
    feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
  }),
  decideExerciseReview: vi.fn().mockResolvedValue({
    exerciseItemId: 'item-1',
    sourceVersionId: 'version-1',
    action: 'approve',
    status: 'approved',
    reviewState: 'approved',
    contentRevision: 8,
  }),
})

const mountPage = async (api: ReturnType<typeof createApi>, itemId?: string) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/admin/source-versions/:versionId/review/:itemId?',
        name: 'admin-exercise-review',
        component: { template: '<div />' },
      },
      {
        path: '/admin/source-versions/:versionId',
        name: 'admin-source-version-detail',
        component: { template: '<div />' },
      },
    ],
  })
  await router.push(
    `/admin/source-versions/version-1/review${itemId ? `/${itemId}` : ''}`,
  )
  await router.isReady()

  const wrapper = mount(ExerciseReviewPage, {
    props: { api, versionId: 'version-1', ...(itemId ? { itemId } : {}) },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()

  return { wrapper, router }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ExerciseReviewPage', () => {
  it('requires a successful simulation before one review approval and then re-reads', async () => {
    const api = createApi()
    const decision = deferred<{
      exerciseItemId: string
      sourceVersionId: string
      action: 'approve'
      status: 'approved'
      reviewState: 'approved'
      contentRevision: number
    }>()
    api.decideExerciseReview.mockReturnValue(decision.promise)
    const { wrapper, router } = await mountPage(api)

    expect(wrapper.get('[data-review-runner]').text()).toContain('apple')
    expect(wrapper.get('[data-review-progress]').text()).toContain('1 / 2')
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeDefined()
    expect(router.currentRoute.value.params.itemId).toBe('item-1')

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(api.evaluateExerciseReview).toHaveBeenCalledWith('item-1', {
      expectedContentRevision: 7,
      submission: { taskType: 'recall_word', answer: 'apple' },
    })
    expect(wrapper.get('[data-review-evaluation]').text()).toContain('判定通过')
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeUndefined()

    const approve = wrapper.get('[data-review-approve]')
    await approve.trigger('click')
    await approve.trigger('click')
    expect(api.decideExerciseReview).toHaveBeenCalledTimes(1)
    decision.resolve({
      exerciseItemId: 'item-1',
      sourceVersionId: 'version-1',
      action: 'approve',
      status: 'approved',
      reviewState: 'approved',
      contentRevision: 8,
    })
    await flushPromises()

    expect(api.decideExerciseReview).toHaveBeenCalledTimes(1)
    expect(api.decideExerciseReview).toHaveBeenCalledWith('item-1', {
      action: 'approve',
      expectedContentRevision: 7,
    })
    expect(api.getExerciseReviewWindow).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-review-complete]').text()).toContain('全部审阅通过')
  })

  it('keeps S5 preview separate and only enables approval after self-score evaluation', async () => {
    const s5Window = {
      ...reviewWindow,
      current: {
        ...reviewWindow.current,
        id: 'item-s5',
        stage: 'S5',
        taskType: 'sentence_output',
        prompt: { meaning: '我每天使用这个单词。', instruction: '写一个英文句子' },
      },
      nextItemId: undefined,
    } as const
    const api = createApi()
    api.getExerciseReviewWindow.mockReset().mockResolvedValue(s5Window)
    api.previewExerciseReview.mockResolvedValue({
      exerciseItemId: 'item-s5',
      referenceSentence: 'I use this word every day.',
      revealedAt: '2026-07-17T00:00:00.000Z',
    })
    api.evaluateExerciseReview.mockResolvedValue({
      exerciseItemId: 'item-s5',
      score: 2,
      correct: true,
      feedback: {
        taskType: 'sentence_output',
        referenceSentence: 'I use this word every day.',
        selfScore: 2,
      },
    })
    const { wrapper } = await mountPage(api, 'item-s5')

    await wrapper.get('textarea').setValue('I use this word.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await flushPromises()
    expect(api.previewExerciseReview).toHaveBeenCalledWith('item-s5', {
      expectedContentRevision: 7,
      taskType: 'sentence_output',
      draft: 'I use this word.',
    })
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-self-score="2"]').trigger('click')
    await flushPromises()
    expect(api.evaluateExerciseReview).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeUndefined()
  })

  it('renders no mutable review control at 479px', async () => {
    const previous = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(max-width: 479px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    const { wrapper } = await mountPage(createApi())

    expect(wrapper.get('[data-review-readonly]').text()).toContain('至少 480px')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('[data-review-approve]').exists()).toBe(false)
    expect(wrapper.find('[data-review-feedback]').exists()).toBe(false)
    window.matchMedia = previous
  })

  it('persists a rework request, confirms it authoritatively, and continues with the next pending item', async () => {
    const feedbackWindow = {
      ...reviewWindow,
      contentRevision: 8,
      pendingCount: 1,
      needsReworkCount: 1,
      current: {
        ...reviewWindow.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '提示词不够准确',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const nextWindow = {
      ...feedbackWindow,
      current: {
        ...reviewWindow.current,
        id: 'item-2',
        wordId: 'word-2',
        word: 'banana',
        position: 2,
        prompt: { meaning: '香蕉' },
      },
      previousItemId: 'item-1',
      nextItemId: undefined,
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockResolvedValueOnce(feedbackWindow)
      .mockResolvedValueOnce(nextWindow)
    api.decideExerciseReview.mockResolvedValue({
      exerciseItemId: 'item-1',
      sourceVersionId: 'version-1',
      action: 'request_rework',
      status: 'draft',
      reviewState: 'needs_rework',
      contentRevision: 8,
    })
    const { wrapper, router } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    const feedback = wrapper.get('[data-review-feedback-text]')
    await feedback.setValue('  提示词不够准确  ')
    expect(wrapper.get('[data-review-feedback-count]').text()).toContain('7 / 2000')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()

    expect(api.decideExerciseReview).toHaveBeenCalledWith('item-1', {
      action: 'request_rework',
      expectedContentRevision: 7,
      feedback: '提示词不够准确',
    })
    expect(api.getExerciseReviewWindow).toHaveBeenNthCalledWith(2, 'version-1', 'item-1')
    expect(api.getExerciseReviewWindow).toHaveBeenNthCalledWith(3, 'version-1')
    expect(wrapper.get('[data-review-runner]').text()).toContain('banana')
    expect(router.currentRoute.value.params.itemId).toBe('item-2')
  })

  it('directly corrects through the review decision and requires a fresh simulation', async () => {
    const openFeedbackWindow = {
      ...reviewWindow,
      pendingCount: 1,
      needsReworkCount: 1,
      current: {
        ...reviewWindow.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '中文释义需要更明确',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const correctedWindow = {
      ...reviewWindow,
      contentRevision: 8,
      current: {
        ...reviewWindow.current,
        prompt: { meaning: '苹果（水果）' },
      },
    } as const
    const correctedItem = {
      ...fullExerciseItem,
      prompt: { meaning: '苹果（水果）' },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(openFeedbackWindow)
      .mockResolvedValueOnce(correctedWindow)
    api.getExerciseItem
      .mockReset()
      .mockResolvedValueOnce(fullExerciseItem)
      .mockResolvedValueOnce(correctedItem)
    api.decideExerciseReview.mockResolvedValue({
      exerciseItemId: 'item-1',
      sourceVersionId: 'version-1',
      action: 'correct',
      status: 'draft',
      reviewState: 'pending_review',
      contentRevision: 8,
    })
    const { wrapper } = await mountPage(api)

    expect(wrapper.get('[data-review-open-feedback]').text()).toContain('中文释义需要更明确')
    expect(wrapper.find('[data-review-approve]').exists()).toBe(false)
    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-direct-correction]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-review-correction] input[name="meaning"]').setValue('苹果（水果）')
    await wrapper.get('[data-review-correction] form').trigger('submit')
    await flushPromises()

    expect(api.decideExerciseReview).toHaveBeenCalledWith('item-1', {
      action: 'correct',
      expectedContentRevision: 7,
      content: {
        stage: 'S2',
        taskType: 'recall_word',
        prompt: { meaning: '苹果（水果）' },
        answer: { word: 'apple' },
      },
    })
    expect(wrapper.get('[data-review-runner]').text()).toContain('苹果（水果）')
    expect(wrapper.find('[data-review-open-feedback]').exists()).toBe(false)
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeDefined()
  })

  it('closes the feedback panel with Escape and restores focus to its trigger', async () => {
    const { wrapper } = await mountPage(createApi())
    const trigger = wrapper.get('[data-review-feedback]')

    await trigger.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-feedback-panel]').element)

    await wrapper.get('[data-feedback-panel]').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('[data-feedback-panel]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('drops stale feedback input when an authoritative reread reports a newer revision', async () => {
    const changedWindow = {
      ...reviewWindow,
      contentRevision: 8,
      current: {
        ...reviewWindow.current,
        prompt: { meaning: '并发修改后的苹果' },
      },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockResolvedValueOnce(changedWindow)
    api.decideExerciseReview.mockRejectedValue(new Error('conflict'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-feedback-text]').setValue('旧内容上的判断')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-feedback-panel]').exists()).toBe(false)
    expect(wrapper.get('[data-review-runner]').text()).toContain('并发修改后的苹果')
    expect(wrapper.get('[role="alert"]').text()).toContain('内容可能已变化')
  })

  it('preserves a direct-correction form when the write fails before commit at the same revision', async () => {
    const openFeedbackWindow = {
      ...reviewWindow,
      pendingCount: 1,
      needsReworkCount: 1,
      current: {
        ...reviewWindow.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '中文释义需要更明确',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow.mockReset().mockResolvedValue(openFeedbackWindow)
    api.getExerciseItem.mockReset().mockResolvedValue(fullExerciseItem)
    api.decideExerciseReview.mockRejectedValue(new Error('offline before commit'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-direct-correction]').trigger('click')
    await flushPromises()
    const meaning = wrapper.get('[data-review-correction] input[name="meaning"]')
    await meaning.setValue('苹果（待重试）')
    await wrapper.get('[data-review-correction] form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-review-correction] input[name="meaning"]').element).toHaveProperty(
      'value',
      '苹果（待重试）',
    )
    expect(wrapper.get('[role="alert"]').text()).toContain('更正未完成')
    expect(wrapper.get('[data-review-correction] button[type="submit"]').attributes('disabled')).toBeUndefined()
  })

  it('locks further writes and keeps feedback input when the decision and reread both fail', async () => {
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockRejectedValueOnce(new Error('D1 unavailable'))
    api.decideExerciseReview.mockRejectedValue(new Error('response unavailable'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-feedback-text]').setValue('数据库恢复后继续提交')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-review-feedback-text]').element).toHaveProperty(
      'value',
      '数据库恢复后继续提交',
    )
    expect(wrapper.get('[data-review-recovery-lock]').text()).toContain('无法确认')
    expect(wrapper.get('[data-review-request-rework]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-review-reload-authoritative]').text()).toContain('重新读取')
    expect(wrapper.get('[data-review-direct-correction]').attributes('disabled')).toBeDefined()
  })

  it('removes stale mutable content when an authoritative recovery reload finds an immutable version', async () => {
    const immutableError = new ApiFailureError(409, {
      code: 'source_version_immutable',
      message: 'Published source versions are immutable',
    })
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockRejectedValueOnce(new Error('D1 unavailable'))
      .mockRejectedValueOnce(immutableError)
    api.decideExerciseReview.mockRejectedValue(new Error('response unavailable'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-feedback-text]').setValue('并发发布前尚未确认的反馈')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-review-reload-authoritative]').trigger('click')
    await flushPromises()

    expect(api.getExerciseReviewWindow).toHaveBeenCalledTimes(3)
    expect(wrapper.find('[data-review-feedback]').exists()).toBe(false)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('[data-review-immutable]').text()).toContain('版本已不再是可审阅草稿')
    expect(wrapper.get('[data-review-back-after-error]').attributes('href')).toBe(
      '/admin/source-versions/version-1',
    )
  })

  it('removes stale mutable content when a concurrent publish makes the version immutable', async () => {
    const api = createApi()
    api.getExerciseReviewWindow.mockReset().mockResolvedValueOnce(reviewWindow)
    api.decideExerciseReview.mockRejectedValue(
      new ApiFailureError(409, {
        code: 'source_version_immutable',
        message: 'Published source versions are immutable',
      }),
    )
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-feedback-text]').setValue('并发发布前的反馈')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()

    expect(api.getExerciseReviewWindow).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-review-feedback]').exists()).toBe(false)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('[data-review-immutable]').text()).toContain('版本已不再是可审阅草稿')
    expect(wrapper.get('[data-review-back-after-error]').attributes('href')).toBe(
      '/admin/source-versions/version-1',
    )
  })

  it('does not confirm an ambiguous approval after more than one revision changed', async () => {
    const approvedAfterInterveningChange = {
      ...reviewWindow,
      contentRevision: 9,
      approvedCount: 1,
      pendingCount: 1,
      current: {
        ...reviewWindow.current,
        status: 'approved',
        reviewState: 'approved',
      },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockResolvedValueOnce(approvedAfterInterveningChange)
      .mockResolvedValueOnce(completeWindow)
    api.decideExerciseReview.mockRejectedValue(new Error('approval response lost'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('input').setValue('apple')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-review-approve]').trigger('click')
    await flushPromises()

    expect(api.getExerciseReviewWindow).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-review-complete]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('内容可能已变化')
  })

  it('does not confirm matching rework feedback after intervening revisions', async () => {
    const matchingLaterFeedback = {
      ...reviewWindow,
      contentRevision: 9,
      pendingCount: 1,
      needsReworkCount: 1,
      current: {
        ...reviewWindow.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '提示词不够准确',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(reviewWindow)
      .mockResolvedValueOnce(matchingLaterFeedback)
    api.decideExerciseReview.mockRejectedValue(new Error('rework response lost'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-feedback-text]').setValue('提示词不够准确')
    await wrapper.get('[data-review-request-rework]').trigger('click')
    await flushPromises()

    expect(api.getExerciseReviewWindow).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-review-recovery-lock]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('内容可能已变化')
  })

  it('does not confirm matching corrected content after intervening revisions', async () => {
    const openFeedbackWindow = {
      ...reviewWindow,
      needsReworkCount: 1,
      current: {
        ...reviewWindow.current,
        reviewState: 'needs_rework',
        feedback: {
          text: '中文释义需要更明确',
          requestedAt: '2026-07-17T09:00:00.000Z',
        },
      },
    } as const
    const correctedLaterWindow = {
      ...reviewWindow,
      contentRevision: 9,
      current: {
        ...reviewWindow.current,
        prompt: { meaning: '苹果（水果）' },
      },
    } as const
    const correctedItem = {
      ...fullExerciseItem,
      prompt: { meaning: '苹果（水果）' },
    } as const
    const api = createApi()
    api.getExerciseReviewWindow
      .mockReset()
      .mockResolvedValueOnce(openFeedbackWindow)
      .mockResolvedValueOnce(correctedLaterWindow)
    api.getExerciseItem
      .mockReset()
      .mockResolvedValueOnce(fullExerciseItem)
      .mockResolvedValueOnce(correctedItem)
    api.decideExerciseReview.mockRejectedValue(new Error('correction response lost'))
    const { wrapper } = await mountPage(api)

    await wrapper.get('[data-review-feedback]').trigger('click')
    await wrapper.get('[data-review-direct-correction]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-review-correction] input[name="meaning"]').setValue('苹果（水果）')
    await wrapper.get('[data-review-correction] form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-review-recovery-lock]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('内容已变化')
    expect(wrapper.get('[data-review-approve]').attributes('disabled')).toBeDefined()
  })
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}
