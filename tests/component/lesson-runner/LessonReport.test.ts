import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ApiFailureError } from '@/api/errors'
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
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('return-lesson')).toHaveLength(1)
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

  it('keeps non-session failures as the report unavailable path', async () => {
    const api = { getLessonReport: vi.fn().mockRejectedValue(new Error('offline')) }
    const wrapper = mount(LessonReport, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('课后结果暂不可用')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('return-course')).toHaveLength(1)
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

})
