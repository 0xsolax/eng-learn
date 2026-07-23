import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App.vue'
import { ApiFailureError, InvalidApiResponseError } from '@/api/errors'
import { createAppRouter } from '@/app/router'
import {
  learnerApiKey,
  type LearnerApiPort,
} from '@/features/learner-course/learnerApiPort'
import type { LessonReportDto, StartedLessonDto } from '@shared/api/courseSchemas'

const adminApi = vi.hoisted(() => ({
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn(),
  getAdminSession: vi.fn(),
  listSourceVersions: vi.fn(),
  importSourceVersion: vi.fn(),
  getSourceVersion: vi.fn(),
  buildSourceVersion: vi.fn(),
  getCoverage: vi.fn(),
  listExerciseItems: vi.fn(),
  getExerciseItem: vi.fn(),
  editExerciseItem: vi.fn(),
  approveExerciseItem: vi.fn(),
  disableExerciseItem: vi.fn(),
  approveExerciseItems: vi.fn(),
  getExerciseReviewWindow: vi.fn(),
  previewExerciseReview: vi.fn(),
  evaluateExerciseReview: vi.fn(),
  decideExerciseReview: vi.fn(),
  publishSourceVersion: vi.fn(),
  discardSourceVersion: vi.fn(),
  createCourse: vi.fn(),
  listCourses: vi.fn(),
  rotateAccessCode: vi.fn(),
  resetCourseProgress: vi.fn(),
}))

vi.mock('@/api/adminApi', () => ({
  createAdminApi: () => adminApi,
}))

let wrapper: ReturnType<typeof mount> | undefined

beforeEach(() => {
  adminApi.getAdminSession.mockReset().mockResolvedValue({
    id: 'admin-1',
    source: 'cloudflare_access',
    displayName: 'Solazhu',
  })
  adminApi.loginAdmin.mockReset()
  adminApi.logoutAdmin.mockReset().mockResolvedValue({ loggedOut: true })
  adminApi.listSourceVersions.mockReset().mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const createLearnerApiFixture = () => ({
  exchangeAccountLogin: vi.fn(),
  exchangeAccessCode: vi.fn(),
  restoreSession: vi.fn().mockRejectedValue(
    new ApiFailureError(401, {
      code: 'learner_session_required',
      message: 'Learner session is required',
    }),
  ),
  logout: vi.fn(),
  getCourseHome: vi.fn().mockResolvedValue({
    course: {
      id: 'course-1',
      learnerId: 'learner-1',
      sourceVersionId: 'version-1',
      currentLessonNo: 4,
      status: 'active',
    },
    newWordCount: 5,
    reviewWordCount: 2,
    action: 'start',
    lessonPath: [
      { lessonNo: 3, status: 'completed' },
      { lessonNo: 4, status: 'current' },
      { lessonNo: 5, status: 'locked' },
    ],
  }),
  startLesson: vi.fn(),
  getLesson: vi.fn(),
  previewSentenceOutput: vi.fn(),
  submitAnswer: vi.fn(),
  completeLesson: vi.fn(),
  getLessonReport: vi.fn(),
  listCompletedLessons: vi.fn().mockResolvedValue({
    currentLearningRunNo: 1,
    lessons: [],
  }),
  startLessonReplay: vi.fn(),
  getLessonReplay: vi.fn(),
  previewReplaySentenceOutput: vi.fn(),
  submitReplayAnswer: vi.fn(),
  completeLessonReplay: vi.fn(),
}) satisfies LearnerApiPort

const learnerSessionErrorCodes = [
  'learner_session_required',
  'learner_session_expired',
  'learner_session_revoked',
] as const

const learnerSessionFailure = (code: (typeof learnerSessionErrorCodes)[number]) =>
  new ApiFailureError(401, { code, message: 'Learner session is unavailable' })

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const lessonSnapshot = (sessionId: string, lessonNo: number, meaning: string): StartedLessonDto => ({
  session: {
    id: sessionId,
    courseId: 'course-1',
    lessonNo,
    status: 'started',
    taskCount: 1,
    completedTaskCount: 0,
  },
  tasks: [
    {
      id: `task-${sessionId}`,
      sessionId,
      courseId: 'course-1',
      wordId: `word-${sessionId}`,
      orderIndex: 1,
      status: 'pending',
      role: 'primary',
      required: true,
      stage: 'S1',
      taskType: 'recall_word',
      prompt: { meaning },
    },
  ],
})

const lessonReport = (lessonNo: number): LessonReportDto => ({
  lessonNo,
  completedTaskCount: 1,
  totalTaskCount: 1,
  correctRate: 1,
  needsPracticeWords: [],
  progressWords: [],
  nextLessonNo: lessonNo + 1,
  courseStatus: 'active',
})

const renderRoute = async (
  path: string,
  learnerApi: LearnerApiPort = createLearnerApiFixture(),
): Promise<Router> => {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()

  wrapper = mount(App, {
    global: {
      plugins: [router],
      provide: {
        [learnerApiKey as symbol]: learnerApi,
      },
    },
  })
  await flushPromises()

  return router
}

describe('application router', () => {
  it('redirects the root route into the quiet learner workspace', async () => {
    const router = await renderRoute('/')

    expect(router.currentRoute.value.fullPath).toBe('/app')
    expect(wrapper?.get('[data-layout="learner"]').attributes('data-layout')).toBe('learner')
    expect(wrapper?.get('h1').text()).toBe('进入你的课程')
    expect(wrapper?.find('[data-layout="admin"]').exists()).toBe(false)
    expect(wrapper?.get('.skip-link').attributes('href')).toBe('#learner-main')
  })

  it('renders the compact admin workspace only after the server confirms the admin session', async () => {
    await renderRoute('/admin')

    expect(wrapper?.get('[data-layout="admin"]').attributes('data-layout')).toBe('admin')
    expect(wrapper?.get('h1').text()).toBe('词库版本')
    expect(wrapper?.get('nav').attributes('aria-label')).toBe('管理端主导航')
    expect(wrapper?.get('.skip-link').attributes('href')).toBe('#admin-main')
    expect(wrapper?.text()).toContain('窄屏可查看；编辑建议使用宽度至少 768px')
    expect(wrapper?.text()).not.toContain('只读预览')
    expect(adminApi.getAdminSession).toHaveBeenCalledTimes(1)
    expect(adminApi.listSourceVersions).toHaveBeenCalledTimes(1)
  })

  it('does not mount the admin business shell or read business data when identity fails', async () => {
    adminApi.getAdminSession.mockRejectedValue(
      new ApiFailureError(401, {
        code: 'admin_session_required',
        message: 'Access identity required',
      }),
    )

    const router = await renderRoute('/admin')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/admin/login')
    })
    expect(wrapper?.get('h1').text()).toBe('管理员登录')
    expect(wrapper?.find('[data-layout="admin"]').exists()).toBe(false)
    expect(adminApi.listSourceVersions).not.toHaveBeenCalled()
  })

  it.each([401, 403])(
    'keeps the admin route closed when Cloudflare Access returns non-JSON %s',
    async (status) => {
      adminApi.getAdminSession.mockRejectedValue(
        new InvalidApiResponseError(status),
      )

      const router = await renderRoute('/admin')

      await vi.waitFor(() => {
        expect(router.currentRoute.value.path).toBe('/admin/login')
      })
      expect(wrapper?.get('h1').text()).toBe('管理员登录')
      expect(wrapper?.find('[data-layout="admin"]').exists()).toBe(false)
      expect(adminApi.listSourceVersions).not.toHaveBeenCalled()
    },
  )

  it('renders the public admin login route without mounting the business shell', async () => {
    adminApi.getAdminSession.mockRejectedValue(
      new ApiFailureError(401, {
        code: 'admin_session_required',
        message: 'Admin session required',
      }),
    )

    const router = await renderRoute('/admin/login')

    expect(router.currentRoute.value.path).toBe('/admin/login')
    expect(wrapper?.get('h1').text()).toBe('管理员登录')
    expect(wrapper?.find('[data-layout="admin"]').exists()).toBe(false)
    expect(adminApi.listSourceVersions).not.toHaveBeenCalled()
  })

  it('maps the explicit next-version query into the import page without local persistence', async () => {
    adminApi.listSourceVersions.mockResolvedValueOnce([
      {
        sourceId: 'source-1',
        sourceName: 'Starter words',
        versionId: 'version-1',
        versionNo: 1,
        status: 'published',
        wordCount: 20,
        groupCount: 4,
        exerciseItemCount: 120,
        approvedItemCount: 120,
        createdAt: '2026-07-13T00:00:00.000Z',
        publishedAt: '2026-07-13T01:00:00.000Z',
      },
    ])

    await renderRoute('/admin/source-versions?mode=next_version&sourceId=source-1')

    expect(wrapper?.get('input[value="next_version"]').attributes('checked')).toBeDefined()
    expect(wrapper?.get('select[name="source-id"]').element).toHaveProperty('value', 'source-1')
  })

  it('remounts the import workspace when its same-route mode query changes', async () => {
    adminApi.listSourceVersions.mockResolvedValue([
      {
        sourceId: 'source-1',
        sourceName: 'Starter words',
        versionId: 'version-1',
        versionNo: 1,
        status: 'published',
        wordCount: 20,
        groupCount: 4,
        exerciseItemCount: 120,
        approvedItemCount: 120,
        createdAt: '2026-07-13T00:00:00.000Z',
        publishedAt: '2026-07-13T01:00:00.000Z',
      },
    ])

    const router = await renderRoute('/admin/source-versions')
    await wrapper?.get('[data-toggle-import]').trigger('click')
    await flushPromises()
    expect(wrapper?.get('input[value="new_source"]').attributes('checked')).toBeDefined()

    await router.push('/admin/source-versions?mode=next_version&sourceId=source-1')
    await flushPromises()

    expect(wrapper?.get('input[value="next_version"]').attributes('checked')).toBeDefined()
    expect(wrapper?.get('select[name="source-id"]').element).toHaveProperty('value', 'source-1')
  })

  it('renders a focused not-found page for unknown routes', async () => {
    await renderRoute('/missing-page')

    expect(wrapper?.get('h1').text()).toBe('页面不存在')
    expect(wrapper?.get('a').attributes('href')).toBe('/app')
    expect(wrapper?.find('[data-layout]').exists()).toBe(false)
  })

  it('wires the course route to the learner API port without browser-date derivation', async () => {
    const api = createLearnerApiFixture()
    await renderRoute('/app/course', api)

    expect(api.getCourseHome).toHaveBeenCalledTimes(1)
    expect(wrapper?.get('h1').text()).toBe('第 4 课')
    expect(wrapper?.text()).toContain('5 个新词')
    expect(wrapper?.text()).not.toMatch(/日期|连续学习/)
  })

  it('returns a learner to the access-code route when lesson start finds an invalid session', async () => {
    const api = createLearnerApiFixture()
    api.startLesson.mockRejectedValueOnce(
      new ApiFailureError(401, {
        code: 'learner_session_required',
        message: 'Learner session is required',
      }),
    )
    const router = await renderRoute('/app/course', api)

    await wrapper?.get('[data-action="start-lesson"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/app')
    expect(wrapper?.get('h1').text()).toBe('进入你的课程')
  })

  it.each(learnerSessionErrorCodes)(
    'replaces an invalid lesson route with the access-code route for %s',
    async (code) => {
      const api = createLearnerApiFixture()
      api.getLesson.mockRejectedValueOnce(learnerSessionFailure(code))

      const router = await renderRoute('/app/lesson/session-7', api)

      expect(router.currentRoute.value.fullPath).toBe('/app')
      expect(wrapper?.get('h1').text()).toBe('进入你的课程')
      expect(wrapper?.text()).not.toContain('重新读取本课')
    },
  )

  it('routes completed repeat practice back to the selectable course page', async () => {
    const api = createLearnerApiFixture()
    const replay = {
      session: {
        id: 'replay-1',
        courseId: 'course-1',
        sourceSessionId: 'session-1',
        learningRunNo: 1,
        lessonNo: 1,
        status: 'started' as const,
        taskCount: 1,
        completedTaskCount: 1,
        correctCount: 1,
        wrongCount: 0,
      },
      tasks: [
        {
          id: 'replay-task-1',
          sessionId: 'replay-1',
          courseId: 'course-1',
          wordId: 'word-1',
          orderIndex: 1,
          status: 'completed' as const,
          role: 'primary' as const,
          required: true,
          stage: 'S0' as const,
          taskType: 'recognize_meaning' as const,
          prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I eat an apple.' },
        },
      ],
    }
    api.getLessonReplay.mockResolvedValue(replay)
    api.completeLessonReplay.mockResolvedValue({
      ...replay,
      session: { ...replay.session, status: 'completed' },
    })

    const router = await renderRoute('/app/replay/replay-1', api)
    expect(wrapper?.text()).toContain('重复练习')
    await wrapper?.get('[data-action="complete-replay"]').trigger('click')
    await flushPromises()

    expect(api.completeLessonReplay).toHaveBeenCalledWith('replay-1')
    expect(router.currentRoute.value.fullPath).toBe('/app/replay/replay-1')
    await wrapper?.get('[data-action="return-to-course"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/app/course')
  })

  it.each(learnerSessionErrorCodes)(
    'replaces an invalid lesson report route with the access-code route for %s',
    async (code) => {
      const api = createLearnerApiFixture()
      api.getLessonReport.mockRejectedValueOnce(learnerSessionFailure(code))

      const router = await renderRoute('/app/lesson/session-7/report', api)

      expect(router.currentRoute.value.fullPath).toBe('/app')
      expect(wrapper?.get('h1').text()).toBe('进入你的课程')
      expect(wrapper?.text()).not.toContain('课后结果暂不可用')
    },
  )

  it('does not let a stale lesson request overwrite a newer session route', async () => {
    const api = createLearnerApiFixture()
    const first = deferred<StartedLessonDto>()
    const second = deferred<StartedLessonDto>()
    api.getLesson.mockImplementation((sessionId) =>
      sessionId === 'session-a' ? first.promise : second.promise,
    )

    const router = await renderRoute('/app/lesson/session-a', api)
    await router.push('/app/lesson/session-b')
    await flushPromises()

    second.resolve(lessonSnapshot('session-b', 8, '新的课时'))
    await flushPromises()
    expect(wrapper?.text()).toContain('新的课时')

    first.resolve(lessonSnapshot('session-a', 7, '过期的课时'))
    await flushPromises()
    expect(wrapper?.text()).toContain('新的课时')
    expect(wrapper?.text()).not.toContain('过期的课时')
  })

  it('does not let a stale report request overwrite a newer report route', async () => {
    const api = createLearnerApiFixture()
    const first = deferred<LessonReportDto>()
    const second = deferred<LessonReportDto>()
    api.getLessonReport.mockImplementation((sessionId) =>
      sessionId === 'session-a' ? first.promise : second.promise,
    )

    const router = await renderRoute('/app/lesson/session-a/report', api)
    await router.push('/app/lesson/session-b/report')
    await flushPromises()

    second.resolve(lessonReport(8))
    await flushPromises()
    expect(wrapper?.get('h1').text()).toBe('第 8 课完成')

    first.resolve(lessonReport(7))
    await flushPromises()
    expect(wrapper?.get('h1').text()).toBe('第 8 课完成')
  })

  it('keeps layouts and route pages lazy-loaded', () => {
    const router = createAppRouter(createMemoryHistory())
    const routeNames = [
      'admin-login',
      'admin-gate',
      'admin',
      'admin-source-versions',
      'admin-source-version-detail',
      'admin-exercise-review',
      'admin-exercise-item',
      'admin-courses',
      'learner',
      'learner-home',
      'learner-lesson-replay',
      'not-found',
    ]

    for (const routeName of routeNames) {
      const route = router.getRoutes().find((candidate) => candidate.name === routeName)
      expect(typeof route?.components?.default).toBe('function')
    }
  })

  it('keeps the login page public and marks every business route as protected', () => {
    const router = createAppRouter(createMemoryHistory())
    const login = router.getRoutes().find((route) => route.name === 'admin-login')
    const protectedRoutes = [
      'admin-gate',
      'admin',
      'admin-home',
      'admin-source-versions',
      'admin-source-version-detail',
      'admin-exercise-review',
      'admin-exercise-item',
      'admin-courses',
    ]

    expect(login?.path).toBe('/admin/login')
    expect(login?.meta.requiresAdmin).toBe(false)

    for (const name of protectedRoutes) {
      expect(router.getRoutes().find((route) => route.name === name)?.meta.requiresAdmin).toBe(true)
    }
  })

  it('exposes the fixed learner course, lesson and report routes as lazy pages', () => {
    const router = createAppRouter(createMemoryHistory())
    const expectedRoutes = [
      ['learner-course', '/app/course'],
      ['learner-lesson', '/app/lesson/:sessionId'],
      ['learner-lesson-report', '/app/lesson/:sessionId/report'],
    ] as const

    for (const [name, path] of expectedRoutes) {
      const route = router.getRoutes().find((candidate) => candidate.name === name)
      expect(route?.path).toBe(path)
      expect(typeof route?.components?.default).toBe('function')
    }
  })
})
