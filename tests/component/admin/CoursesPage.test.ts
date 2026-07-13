import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import CoursesPage from '@/pages/admin/CoursesPage.vue'

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
  learner: { id: 'learner-1', name: '小林' },
  course: {
    id: 'course-1',
    learnerId: 'learner-1',
    sourceVersionId: 'version-1',
    currentLessonNo: 1,
    status: 'active' as const,
  },
  credentialVersion: 1,
}

describe('CoursesPage', () => {
  it('creates a course from a published server version and shows the code only until acknowledged', async () => {
    const api = {
      listCourses: vi
        .fn()
        .mockResolvedValueOnce({ courses: [] })
        .mockResolvedValueOnce({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockResolvedValue({
        ...courseEntry,
        learner: { ...courseEntry.learner, accessCode: 'ABCDEFGH23' },
      }),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    expect(wrapper.text()).toContain('还没有课程')
    expect(wrapper.get('select[name="source-version-id"]').text()).toContain('Starter words · v1')

    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    const command = requireRecord((api.createCourse.mock.calls as unknown[][])[0]?.[0])
    expect(command).toMatchObject({
      learnerName: '小林',
      sourceVersionId: 'version-1',
    })
    expect(command.operationToken).toMatch(/^[0-9a-f]{64}$/)
    expect(wrapper.get('[data-one-time-code]').text()).toContain('ABCDEFGH23')
    expect(wrapper.get('[data-one-time-code]').text()).toContain('仅本次显示')
    expect(wrapper.get('table').text()).toContain('小林')

    await wrapper.get('[data-dismiss-code]').trigger('click')
    expect(wrapper.text()).not.toContain('ABCDEFGH23')
  })

  it('requires explicit confirmation before rotating a learner code', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn().mockResolvedValue({
        accessCode: 'JKLMNPQR45',
        credentialVersion: 2,
        revokedSessionCount: 2,
      }),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-rotate-code]').trigger('click')
    expect(api.rotateAccessCode).not.toHaveBeenCalled()
    expect(wrapper.get('[data-rotate-confirmation]').text()).toContain('现有学习会话会全部失效')

    await wrapper.get('[data-confirm-rotate]').trigger('click')
    await flushPromises()

    const rotateCall = (api.rotateAccessCode.mock.calls as unknown[][])[0]
    expect(rotateCall?.[0]).toBe('learner-1')
    const rotateCommand = requireRecord(rotateCall?.[1])
    expect(rotateCommand).toMatchObject({
      expectedCredentialVersion: 1,
    })
    expect(rotateCommand.operationToken).toMatch(/^[0-9a-f]{64}$/)
    expect(wrapper.get('[data-one-time-code]').text()).toContain('JKLMNPQR45')
    expect(wrapper.get('[data-one-time-code]').text()).toContain('2 个旧会话已失效')
  })

  it('keeps entered form data when course creation conflicts', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockRejectedValue(
        new ApiFailureError(409, { code: 'conflict', message: 'Course already exists' }),
      ),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('课程创建冲突')
    expect(wrapper.get('input[name="learner-name"]').element).toHaveProperty('value', '小林')
  })

  it('disables course creation when no published version exists', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [] }),
      listSourceVersions: vi.fn().mockResolvedValue([
        { ...publishedVersion, status: 'draft' as const, publishedAt: undefined },
      ]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[data-no-published]').text()).toContain('先发布一个词库版本')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('does not render partial course data when the initial read fails', async () => {
    const api = {
      listCourses: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取课程工作台')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('reuses the exact in-memory create token and payload after an unknown result', async () => {
    const committed = {
      ...courseEntry,
      learner: { ...courseEntry.learner, accessCode: 'ABCDEFGH23' },
    }
    const api = {
      listCourses: vi
        .fn()
        .mockResolvedValueOnce({ courses: [] })
        .mockResolvedValueOnce({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi
        .fn()
        .mockImplementationOnce(async () => {
          await Promise.resolve(committed)
          throw new ApiFailureError(503, {
            code: 'dependency_failure',
            message: 'Committed, but outcome read failed',
          })
        })
        .mockResolvedValueOnce(committed),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()
    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain('结果未知')
    expect(wrapper.text()).not.toContain('旧学习码与会话状态未在页面中改变')
    const firstCommand = requireRecord(
      (api.createCourse.mock.calls as unknown[][])[0]?.[0],
    )
    expect(firstCommand.operationToken).toMatch(/^[0-9a-f]{64}$/)

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()

    expect(api.createCourse).toHaveBeenCalledTimes(2)
    expect((api.createCourse.mock.calls as unknown[][])[1]?.[0]).toEqual(firstCommand)
    expect(wrapper.get('[data-one-time-code]').text()).toContain('ABCDEFGH23')
    expect(wrapper.find('[data-unknown-result]').exists()).toBe(false)
  })

  it('cannot replace an unknown create operation through a stale rotate confirmation', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockRejectedValue(new ApiNetworkError(new Error('offline'))),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    await wrapper.get('[data-rotate-code]').trigger('click')
    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain('课程可能已经创建')
    expect(wrapper.find('[data-rotate-confirmation]').exists()).toBe(false)
    expect(api.rotateAccessCode).not.toHaveBeenCalled()
  })

  it('reuses the exact rotation token and expected version after an unknown result', async () => {
    const committed = {
      accessCode: 'JKLMNPQR45',
      credentialVersion: 2,
      revokedSessionCount: 1,
    }
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi
        .fn()
        .mockImplementationOnce(async () => {
          await Promise.resolve(committed)
          throw new ApiFailureError(500, {
            code: 'internal_error',
            message: 'Committed, but response construction failed',
          })
        })
        .mockResolvedValueOnce(committed),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()
    await wrapper.get('[data-rotate-code]').trigger('click')
    await wrapper.get('[data-confirm-rotate]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain(
      '学习码和会话可能已经变更',
    )
    const firstCall = (api.rotateAccessCode.mock.calls as unknown[][])[0]
    const firstCommand = requireRecord(firstCall?.[1])
    expect(firstCommand).toMatchObject({
      expectedCredentialVersion: 1,
    })
    expect(firstCommand.operationToken).toMatch(/^[0-9a-f]{64}$/)

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()

    expect((api.rotateAccessCode.mock.calls as unknown[][])[1]).toEqual(firstCall)
    expect(wrapper.get('[data-one-time-code]').text()).toContain('JKLMNPQR45')
  })
})

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a recorded command object')
  }

  return value as Record<string, unknown>
}
