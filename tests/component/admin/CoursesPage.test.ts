import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import CoursesPage from '@/pages/admin/CoursesPage.vue'

const createTemporaryAccessCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (byte) => alphabet[byte % alphabet.length],
  ).join('')
}
const CREATED_ACCESS_CODE = createTemporaryAccessCode()
const ROTATED_ACCESS_CODE = createTemporaryAccessCode()

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

afterEach(() => {
  clearClipboard()
  setViewportWidth(1024)
})

describe('CoursesPage', () => {
  it('creates a course from a published server version and shows the code only until acknowledged', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard(writeText)
    const api = {
      listCourses: vi
        .fn()
        .mockResolvedValueOnce({ courses: [] })
        .mockResolvedValueOnce({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockResolvedValue({
        ...courseEntry,
        learner: { ...courseEntry.learner, accessCode: CREATED_ACCESS_CODE },
      }),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain('还没有课程')
    expect(wrapper.get('[data-toggle-create]').attributes('aria-expanded')).toBe('true')
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
    const dialog = wrapper.get('[data-one-time-code]')
    expect(dialog.text()).toContain(CREATED_ACCESS_CODE)
    expect(dialog.text()).toContain('仅本次显示')
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(wrapper.get('[data-one-time-code-backdrop]').attributes('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(dialog.element)
    expect(wrapper.get('table').text()).toContain('小林')

    const copyButton = wrapper.get('[data-copy-code]')
    const dismissButton = wrapper.get('[data-dismiss-code]')
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(dismissButton.element)
    ;(copyButton.element as HTMLButtonElement).focus()
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(dismissButton.element)
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(copyButton.element)

    await copyButton.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(CREATED_ACCESS_CODE)
    expect(wrapper.get('[data-copy-feedback]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-copy-feedback]').text()).toContain('复制成功')

    await dismissButton.trigger('click')
    expect(wrapper.text()).not.toContain(CREATED_ACCESS_CODE)
    expect(wrapper.find('[data-one-time-code-backdrop]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-toggle-create]').element)
    await wrapper.get('[data-toggle-create]').trigger('click')
    expect(wrapper.text()).not.toContain(CREATED_ACCESS_CODE)

    wrapper.unmount()
    clearClipboard()
  })

  it('keeps the course table primary and only expands creation from the title action', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    expect(wrapper.get('table').text()).toContain('小林')
    expect(wrapper.find('form[data-course-form]').exists()).toBe(false)
    expect(wrapper.get('[data-toggle-create]').attributes('aria-expanded')).toBe('false')

    await wrapper.get('[data-toggle-create]').trigger('click')
    const table = wrapper.get('table')
    const form = wrapper.get('form[data-course-form]')
    expect(
      table.element.compareDocumentPosition(form.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('requires explicit confirmation before rotating a learner code', async () => {
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn().mockResolvedValue({
        accessCode: ROTATED_ACCESS_CODE,
        credentialVersion: 2,
        revokedSessionCount: 2,
      }),
    }
    const wrapper = mount(CoursesPage, { props: { api }, attachTo: document.body })
    await flushPromises()

    const trigger = wrapper.get('[data-rotate-code]')
    ;(trigger.element as HTMLButtonElement).focus()
    await trigger.trigger('click')
    expect(api.rotateAccessCode).not.toHaveBeenCalled()
    const confirmation = wrapper.get('[data-rotate-confirmation]')
    expect(confirmation.text()).toContain('现有学习会话会全部失效')
    expect(trigger.element.closest('td')?.contains(confirmation.element)).toBe(true)
    expect(document.activeElement).toBe(confirmation.element)

    const cancel = confirmation.findAll('button').find((button) => button.text() === '取消')
    expect(cancel).toBeDefined()
    await cancel?.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')

    await wrapper.get('[data-confirm-rotate]').trigger('click')
    await flushPromises()

    const rotateCall = (api.rotateAccessCode.mock.calls as unknown[][])[0]
    expect(rotateCall?.[0]).toBe('learner-1')
    const rotateCommand = requireRecord(rotateCall?.[1])
    expect(rotateCommand).toMatchObject({
      expectedCredentialVersion: 1,
    })
    expect(rotateCommand.operationToken).toMatch(/^[0-9a-f]{64}$/)
    expect(wrapper.get('[data-one-time-code]').text()).toContain(ROTATED_ACCESS_CODE)
    expect(wrapper.get('[data-one-time-code]').text()).toContain('2 个旧会话已失效')
    expect(document.activeElement).toBe(wrapper.get('[data-one-time-code]').element)

    await wrapper.get('[data-dismiss-code]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('keeps copy failure visible inside the one-time-code dialog', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    setClipboard(writeText)
    const api = {
      listCourses: vi
        .fn()
        .mockResolvedValueOnce({ courses: [] })
        .mockResolvedValueOnce({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn().mockResolvedValue({
        ...courseEntry,
        learner: { ...courseEntry.learner, accessCode: CREATED_ACCESS_CODE },
      }),
      rotateAccessCode: vi.fn(),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()
    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    await wrapper.get('[data-copy-code]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-copy-feedback]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-copy-feedback]').text()).toContain('复制失败')
    expect(wrapper.get('[data-one-time-code]').text()).toContain(CREATED_ACCESS_CODE)
    clearClipboard()
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
    expect(wrapper.get('[data-source-workbench-link]').text()).toContain('前往词库工作台')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('removes create, copy, and rotate entrances at 479px and restores them at 480px', async () => {
    setViewportWidth(479)
    const api = {
      listCourses: vi.fn().mockResolvedValue({ courses: [courseEntry] }),
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      createCourse: vi.fn(),
      rotateAccessCode: vi.fn().mockResolvedValue({
        accessCode: ROTATED_ACCESS_CODE,
        credentialVersion: 2,
        revokedSessionCount: 0,
      }),
    }
    const wrapper = mount(CoursesPage, { props: { api } })
    await flushPromises()

    expect(wrapper.get('[data-mobile-readonly]').text()).toContain('至少 480px')
    expect(wrapper.find('[data-toggle-create]').exists()).toBe(false)
    expect(wrapper.find('form[data-course-form]').exists()).toBe(false)
    expect(wrapper.find('[data-rotate-code]').exists()).toBe(false)
    expect(wrapper.get('[data-scroll-region="courses"]').attributes()).toMatchObject({
      tabindex: '0',
      'aria-label': '课程列表表格',
    })

    setViewportWidth(480)
    await nextTick()
    expect(wrapper.find('[data-toggle-create]').exists()).toBe(true)
    expect(wrapper.find('[data-rotate-code]').exists()).toBe(true)

    await wrapper.get('[data-rotate-code]').trigger('click')
    await wrapper.get('[data-confirm-rotate]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-copy-code]').exists()).toBe(true)

    setViewportWidth(479)
    await nextTick()
    expect(wrapper.find('[data-copy-code]').exists()).toBe(false)
    wrapper.unmount()
    setViewportWidth(1024)
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
      learner: { ...courseEntry.learner, accessCode: CREATED_ACCESS_CODE },
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

    setViewportWidth(479)
    await nextTick()
    expect(wrapper.find('[data-retry-unknown]').exists()).toBe(false)
    setViewportWidth(480)
    await nextTick()

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()

    expect(api.createCourse).toHaveBeenCalledTimes(2)
    expect((api.createCourse.mock.calls as unknown[][])[1]?.[0]).toEqual(firstCommand)
    expect(wrapper.get('[data-one-time-code]').text()).toContain(CREATED_ACCESS_CODE)
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
    await wrapper.get('[data-toggle-create]').trigger('click')
    await wrapper.get('input[name="learner-name"]').setValue('小林')
    await wrapper.get('form[data-course-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain('课程可能已经创建')
    expect(wrapper.find('[data-rotate-confirmation]').exists()).toBe(false)
    expect(api.rotateAccessCode).not.toHaveBeenCalled()
  })

  it('reuses the exact rotation token and expected version after an unknown result', async () => {
    const committed = {
      accessCode: ROTATED_ACCESS_CODE,
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
    expect(wrapper.get('[data-one-time-code]').text()).toContain(ROTATED_ACCESS_CODE)
  })
})

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a recorded command object')
  }

  return value as Record<string, unknown>
}

const setClipboard = (writeText: (value: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

const clearClipboard = (): void => {
  Reflect.deleteProperty(navigator, 'clipboard')
}

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}
