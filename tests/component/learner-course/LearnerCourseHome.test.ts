import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ApiFailureError } from '@/api/errors'
import LearnerCourseHome from '@/features/learner-course/LearnerCourseHome.vue'

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 7,
  status: 'active' as const,
}
const courseHome = {
  course,
  newWordCount: 5,
  reviewWordCount: 2,
  action: 'continue' as const,
  startedSessionId: 'session-7',
  lessonPath: [
    { lessonNo: 6, status: 'completed' as const },
    { lessonNo: 7, status: 'current' as const },
    { lessonNo: 8, status: 'locked' as const },
  ],
}

describe('LearnerCourseHome', () => {
  it('renders only the server lesson number and one start-or-continue primary action', async () => {
    const api = {
      getCourseHome: vi.fn().mockResolvedValue(courseHome),
      startLesson: vi.fn(),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })

    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('第 7 课')
    expect(wrapper.get('[data-action="start-lesson"]').text()).toBe('继续第 7 课')
    expect(wrapper.findAll('[data-action="start-lesson"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('5 个新词')
    expect(wrapper.text()).toContain('2 个复习词')
    expect(wrapper.findAll('[data-lesson-path]')).toHaveLength(3)
    expect(wrapper.text()).not.toMatch(/连续|排名|金币|预计|日期/)
  })

  it('starts once and exposes the server session id for navigation', async () => {
    const startedLesson = {
      session: {
        id: 'session-7',
        courseId: course.id,
        lessonNo: 7,
        status: 'started' as const,
        taskCount: 1,
        completedTaskCount: 0,
      },
      tasks: [],
    }
    let resolveStart: ((lesson: typeof startedLesson) => void) | undefined
    const start = new Promise<typeof startedLesson>((resolve) => {
      resolveStart = resolve
    })
    const api = {
      getCourseHome: vi.fn().mockResolvedValue(courseHome),
      startLesson: vi.fn().mockReturnValue(start),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })
    await flushPromises()

    const action = wrapper.get('[data-action="start-lesson"]')
    await action.trigger('click')
    await action.trigger('click')

    expect(api.startLesson).toHaveBeenCalledTimes(1)
    expect(api.startLesson).toHaveBeenCalledWith('course-1')
    expect(action.attributes('aria-busy')).toBe('true')

    resolveStart?.(startedLesson)
    await flushPromises()

    expect(wrapper.emitted('started')).toEqual([['session-7']])
  })

  it.each([
    'learner_session_required',
    'learner_session_expired',
    'learner_session_revoked',
  ] as const)('returns to the access-code entry when lesson start reports %s', async (code) => {
    const api = {
      getCourseHome: vi.fn().mockResolvedValue(courseHome),
      startLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code,
          message: 'Learner session is unavailable',
        }),
      ),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-action="start-lesson"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('access-required')).toHaveLength(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows safe actionable guidance when legacy course content cannot start', async () => {
    const api = {
      getCourseHome: vi.fn().mockResolvedValue(courseHome),
      startLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'legacy_content_incompatible',
          message: 'internal reason: meaning_reveals_answer apple',
        }),
      ),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-action="start-lesson"]').trigger('click')
    await flushPromises()

    const alert = wrapper.get('[role="alert"]').text()
    expect(alert).toContain('本课内容暂时无法使用')
    expect(alert).toContain('联系课程管理员')
    expect(alert).not.toContain('meaning_reveals_answer')
    expect(alert).not.toContain('apple')
    expect(alert).not.toContain('检查网络')
  })

  it('turns an expired cookie into an explicit return-to-code action', async () => {
    const api = {
      getCourseHome: vi.fn().mockRejectedValue(
        new ApiFailureError(401, {
          code: 'learner_session_expired',
          message: 'Learner session has expired',
        }),
      ),
      startLesson: vi.fn(),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('学习会话已失效')
    await wrapper.get('[data-action="return-to-code"]').trigger('click')
    expect(wrapper.emitted('access-required')).toHaveLength(1)
    expect(api.startLesson).not.toHaveBeenCalled()
  })

  it('retries a normal course read failure without mislabeling the session', async () => {
    const api = {
      getCourseHome: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(courseHome),
      startLesson: vi.fn(),
    }
    const wrapper = mount(LearnerCourseHome, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取课程')
    expect(wrapper.find('[data-action="return-to-code"]').exists()).toBe(false)
    await wrapper.get('[data-action="reload-course"]').trigger('click')
    await flushPromises()

    expect(api.getCourseHome).toHaveBeenCalledTimes(2)
    expect(wrapper.get('h1').text()).toBe('第 7 课')
  })
})
