import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import AdminCoursesWorkspace from '@/features/admin-course/AdminCoursesWorkspace.vue'

const publishedVersion = {
  sourceId: 'source-1',
  sourceName: 'Starter words',
  versionId: 'version-1',
  versionNo: 1,
  status: 'published' as const,
  wordCount: 20,
  groupCount: 4,
  exerciseItemCount: 120,
  approvedItemCount: 120,
  createdAt: '2026-07-13T00:00:00.000Z',
  publishedAt: '2026-07-13T01:00:00.000Z',
}

const courseEntry = {
  learner: { id: 'learner-1', name: '小林', loginAccount: 'xiaolin01' },
  course: {
    id: 'course-1',
    learnerId: 'learner-1',
    sourceVersionId: 'version-1',
    currentLessonNo: 1,
    status: 'active' as const,
  },
  credentialVersion: 1,
  learningRunNo: 1,
}

afterEach(() => {
  setViewportWidth(1024)
})

describe('AdminCoursesWorkspace', () => {
  it('creates a course with account and PIN without rendering either secret afterward', async () => {
    const created = { ...courseEntry, learner: { ...courseEntry.learner, name: '小林' } }
    const api = {
      listCourses: vi
        .fn()
        .mockResolvedValueOnce({ courses: [] })
        .mockResolvedValueOnce({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockResolvedValue(created),
      updateLearnerLogin: vi.fn(),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('input[name="login-account"]').setValue(' Xiaolin01 ')
    await wrapper.get('input[name="login-pin"]').setValue('123456')
    await wrapper.get('[data-course-form]').trigger('submit')
    await flushPromises()

    const command = requireRecord((api.createCourse.mock.calls as unknown[][])[0]?.[0])
    expect(command).toMatchObject({
      learnerName: '小林',
      loginAccount: ' Xiaolin01 ',
      pin: '123456',
      sourceVersionId: 'version-1',
    })
    expect(command.operationToken).toMatch(/^[0-9a-f]{64}$/u)
    expect(wrapper.get('[data-action-success]').text()).toContain('xiaolin01')
    expect(wrapper.text()).not.toContain('123456')
    expect(wrapper.find('[data-one-time-code]').exists()).toBe(false)
    await wrapper.get('[data-toggle-create]').trigger('click')
    expect((wrapper.get('input[name="login-pin"]').element as HTMLInputElement).value).toBe('')
  })

  it('shows assigned accounts and marks legacy learners as waiting for setup', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({
        courses: [
          courseEntry,
          {
            ...courseEntry,
            learner: { id: 'learner-2', name: '小周' },
            course: { ...courseEntry.course, id: 'course-2', learnerId: 'learner-2' },
          },
        ],
      }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn(),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    expect(wrapper.get('table').text()).toContain('xiaolin01')
    expect(wrapper.get('table').text()).toContain('待设置')
    expect(wrapper.findAll('[data-edit-login]')).toHaveLength(2)
  })

  it('updates login information, clears the PIN, and advances the displayed version', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn().mockResolvedValue({
        loginAccount: 'xiaolin02',
        credentialVersion: 2,
        revokedSessionCount: 2,
      }),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, {
      props: { api },
      attachTo: document.body,
    })
    await flushPromises()

    await wrapper.get('[data-edit-login]').trigger('click')
    expect(document.activeElement).toBe(wrapper.get('input[name="edit-login-account"]').element)
    await wrapper.get('input[name="edit-login-account"]').setValue('xiaolin02')
    await wrapper.get('input[name="edit-login-pin"]').setValue('654321')
    await wrapper.get('[data-login-form]').trigger('submit')
    await flushPromises()

    const call = (api.updateLearnerLogin.mock.calls as unknown[][])[0]
    expect(call?.[0]).toBe('learner-1')
    expect(requireRecord(call?.[1])).toMatchObject({
      expectedCredentialVersion: 1,
      loginAccount: 'xiaolin02',
      pin: '654321',
    })
    expect(wrapper.get('[data-action-success]').text()).toContain('2 个旧会话已失效')
    expect(wrapper.get('table').text()).toContain('xiaolin02')
    expect((wrapper.get('input[name="edit-login-pin"]').element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('requires a PIN when setting an account for a legacy learner', async () => {
    const legacy = { ...courseEntry, learner: { id: 'learner-1', name: '小林' } }
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [legacy] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn(),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-edit-login]').trigger('click')
    await wrapper.get('input[name="edit-login-account"]').setValue('xiaolin01')
    expect(wrapper.get('[data-submit-login]').attributes('disabled')).toBeDefined()
    await wrapper.get('input[name="edit-login-pin"]').setValue('123456')
    expect(wrapper.get('[data-submit-login]').attributes('disabled')).toBeUndefined()
  })

  it('reuses the exact login-update token and payload when the result is unknown', async () => {
    const committed = {
      loginAccount: 'xiaolin02',
      credentialVersion: 2,
      revokedSessionCount: 1,
    }
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockResolvedValueOnce(committed),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-edit-login]').trigger('click')
    await wrapper.get('input[name="edit-login-account"]').setValue('xiaolin02')
    await wrapper.get('[data-login-form]').trigger('submit')
    await flushPromises()
    const firstCall = (api.updateLearnerLogin.mock.calls as unknown[][])[0]
    expect(wrapper.get('[data-unknown-result]').text()).toContain('登录信息可能已经变更')

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()
    expect((api.updateLearnerLogin.mock.calls as unknown[][])[1]).toEqual(firstCall)
    expect(wrapper.get('table').text()).toContain('xiaolin02')
  })

  it('maps account and credential conflicts without discarding the edit form', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'login_account_unavailable',
          message: 'Unavailable',
        }),
      ),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()
    await wrapper.get('[data-edit-login]').trigger('click')
    await wrapper.get('input[name="edit-login-account"]').setValue('used01')
    await wrapper.get('[data-login-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('学习账号已被占用')
    expect(wrapper.find('[data-login-form]').exists()).toBe(true)
  })

  it('shows a distinct message when a login operation token is reused with different input', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'idempotency_conflict',
          message: 'Conflict',
        }),
      ),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()
    await wrapper.get('[data-edit-login]').trigger('click')
    await wrapper.get('input[name="edit-login-account"]').setValue('xiaolin02')
    await wrapper.get('[data-login-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('操作令牌对应的参数不一致')
    expect(wrapper.find('[data-login-form]').exists()).toBe(true)
  })

  it('preserves the separate confirmed restart-learning operation', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn(),
      resetCourseProgress: vi.fn().mockResolvedValue({
        course: { ...courseEntry.course, currentLessonNo: 1 },
        learningRunNo: 2,
        abandonedSessionCount: 1,
        historyPreserved: true as const,
      }),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-reset-progress]').trigger('click')
    expect(wrapper.get('[data-reset-confirmation]').text()).toContain('保留全部历史记录')
    await wrapper.get('[data-confirm-reset]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-action-success]').text()).toContain('已从第 1 课重新开始')
    expect(wrapper.get('table').text()).toContain('第 2 轮')
  })

  it('keeps editing read-only below 480px and restores actions at the boundary', async () => {
    setViewportWidth(479)
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      updateLearnerLogin: vi.fn(),
      resetCourseProgress: vi.fn(),
    }
    const wrapper = mount(AdminCoursesWorkspace, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[data-mobile-readonly]').text()).toContain('至少 480px')
    expect(wrapper.find('[data-edit-login]').exists()).toBe(false)
    setViewportWidth(480)
    await nextTick()
    expect(wrapper.find('[data-edit-login]').exists()).toBe(true)
  })
})

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a recorded command object')
  }
  return value as Record<string, unknown>
}

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}
