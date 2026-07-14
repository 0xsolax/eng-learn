import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import LessonReport from '@/features/lesson-runner/LessonReport.vue'

const lessonReport = {
  lessonNo: 7,
  completedTaskCount: 6,
  totalTaskCount: 6,
  correctRate: 0.75,
  needsPracticeWords: [{ id: 'word-1', word: 'apple' }],
  progressWords: [{ id: 'word-2', word: 'orange' }],
  nextLessonNo: 8,
  courseStatus: 'active' as const,
}

const learnerSessionErrorCodes = [
  'learner_session_required',
  'learner_session_expired',
  'learner_session_revoked',
] as const

const transientReportFailures = [
  {
    label: 'network',
    create: () => new ApiNetworkError(new Error('offline')),
  },
  {
    label: '5xx',
    create: () =>
      new ApiFailureError(503, {
        code: 'dependency_failure',
        message: 'Report dependency is unavailable',
      }),
  },
  {
    label: 'invalid response',
    create: () => new InvalidApiResponseError(200),
  },
] as const

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe('LessonReport', () => {
  it('renders the independent server report without internal scheduling fields', async () => {
    const api = { getLessonReport: vi.fn().mockResolvedValue(lessonReport) }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(api.getLessonReport).toHaveBeenCalledWith('session-7')
    expect(wrapper.get('h1').text()).toBe('第 7 课完成')
    expect(wrapper.text()).toContain('已完成 6 / 6 道任务')
    expect(wrapper.text()).toContain('75%')
    expect(wrapper.text()).toContain('apple')
    expect(wrapper.text()).toContain('orange')
    expect(wrapper.text()).toContain('下一步：第 8 课')
    expect(wrapper.text()).not.toMatch(/掌握度|easeFactor|阶段计数|nextDueLessonNo/)

    await wrapper.get('[data-action="return-course"]').trigger('click')
    expect(wrapper.emitted('return-course')).toHaveLength(1)
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of showing report retry for %s',
    async (code) => {
      const api = {
        getLessonReport: vi.fn().mockRejectedValue(
          new ApiFailureError(401, { code, message: 'Learner session is unavailable' }),
        ),
      }
      const wrapper = mount(LessonReport, {
        props: { api, sessionId: 'session-7' },
      })

      await flushPromises()

      expect(wrapper.emitted('access-required')).toHaveLength(1)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.find('button').exists()).toBe(false)
    },
  )

  it('requests the access-code page for a generic 401 without showing report actions', async () => {
    const api = {
      getLessonReport: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'unauthorized',
          message: 'Authentication is required',
        }),
      ),
    }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.emitted('access-required')).toHaveLength(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="retry-report"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="return-course"]').exists()).toBe(false)
  })

  it('keeps report_unavailable as the return-to-lesson business block', async () => {
    const api = {
      getLessonReport: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'report_unavailable',
          message: 'Lesson report is unavailable',
        }),
      ),
    }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('本课尚未完成')
    expect(wrapper.find('[data-action="retry-report"]').exists()).toBe(false)
    await wrapper.get('[data-action="return-lesson"]').trigger('click')
    expect(wrapper.emitted('return-lesson')).toHaveLength(1)
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

  it('returns to the course without retrying when the lesson is no longer active', async () => {
    const api = {
      getLessonReport: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'lesson_not_active',
          message: 'Lesson session is not active',
        }),
      ),
    }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('本课状态已变化')
    expect(wrapper.find('[data-action="retry-report"]').exists()).toBe(false)
    await wrapper.get('[data-action="return-course"]').trigger('click')

    expect(api.getLessonReport).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('return-course')).toHaveLength(1)
    expect(wrapper.emitted('return-lesson')).toBeUndefined()
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

  it('does not offer a blind retry for another declared business failure', async () => {
    const api = {
      getLessonReport: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'course_unavailable',
          message: 'Course is unavailable',
        }),
      ),
    }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('课后结果无法打开')
    expect(wrapper.find('[data-action="retry-report"]').exists()).toBe(false)
    expect(wrapper.get('[data-action="return-course"]').text()).toContain('返回课程')
    expect(api.getLessonReport).toHaveBeenCalledTimes(1)
  })

  it('does not retry a report read after a non-JSON 403 response', async () => {
    const api = {
      getLessonReport: vi.fn().mockRejectedValue(new InvalidApiResponseError(403)),
    }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('课后结果无法打开')
    expect(wrapper.find('[data-action="retry-report"]').exists()).toBe(false)
    expect(wrapper.get('[data-action="return-course"]').text()).toContain('返回课程')
    expect(api.getLessonReport).toHaveBeenCalledTimes(1)
  })

  it.each(transientReportFailures)(
    'retries the same report session after a $label failure and recovers in place',
    async ({ create }) => {
      const api = {
        getLessonReport: vi
          .fn()
          .mockRejectedValueOnce(create())
          .mockResolvedValueOnce(lessonReport),
      }
      const wrapper = mount(LessonReport, {
        props: { api, sessionId: 'session-7' },
      })

      await flushPromises()

      expect(wrapper.get('[role="alert"]').text()).toContain('课后结果暂不可用')
      expect(wrapper.get('[data-action="retry-report"]').text()).toContain(
        '重新读取课后结果',
      )
      expect(wrapper.get('[data-action="return-course"]').text()).toContain('返回课程')

      await wrapper.get('[data-action="retry-report"]').trigger('click')
      await flushPromises()

      expect(api.getLessonReport.mock.calls).toEqual([['session-7'], ['session-7']])
      expect(wrapper.get('h1').text()).toBe('第 7 课完成')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.emitted('return-course')).toBeUndefined()
      expect(wrapper.emitted('access-required')).toBeUndefined()
    },
  )

  it('keeps transient recovery keyboard-accessible while the retry is pending', async () => {
    const retryRequest = deferred<typeof lessonReport>()
    const api = {
      getLessonReport: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockReturnValueOnce(retryRequest.promise),
    }
    const wrapper = mount(LessonReport, {
      attachTo: document.body,
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    const retryButton = wrapper.get('[data-action="retry-report"]')
    expect(alert.attributes('aria-live')).toBe('assertive')
    expect(alert.attributes('aria-atomic')).toBe('true')
    expect(document.activeElement).toBe(retryButton.element)

    await retryButton.trigger('click')
    await wrapper.vm.$nextTick()

    const pendingRetryButton = wrapper.get('[data-action="retry-report"]')
    expect(pendingRetryButton.attributes('aria-busy')).toBe('true')
    expect(pendingRetryButton.attributes('disabled')).toBeDefined()
    expect(pendingRetryButton.text()).toContain('正在重新读取')
    expect(wrapper.find('[data-action="return-course"]').exists()).toBe(true)

    retryRequest.resolve(lessonReport)
    await flushPromises()

    const reportHeading = wrapper.get('h1')
    expect(reportHeading.attributes('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(reportHeading.element)

    wrapper.unmount()
  })

})
