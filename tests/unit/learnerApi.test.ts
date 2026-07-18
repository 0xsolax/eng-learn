import { describe, expect, it, vi } from 'vitest'
import { createLearnerApi } from '@/api/learnerApi'
import { InvalidApiResponseError } from '@/api/errors'
import { createHttpClient, type FetchImplementation } from '@/api/httpClient'

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 1,
  status: 'active',
} as const

const lesson = {
  session: {
    id: 'lesson-1',
    courseId: 'course-1',
    lessonNo: 1,
    status: 'started',
    taskCount: 0,
    completedTaskCount: 0,
  },
  tasks: [],
} as const

describe('learner API client', () => {
  it('exchanges an explicit learning code only through the app session endpoint', async () => {
    const establishedSession = {
      learner: { id: 'learner-1', name: 'Alice' },
      course,
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: establishedSession }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.exchangeAccessCode(' abcdefgh23 ')).resolves.toEqual(
      establishedSession,
    )
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/session/by-code', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ accessCode: 'ABCDEFGH23' }),
    })
  })

  it('restores the learner session from the same-origin cookie without a learning code', async () => {
    const restoredSession = {
      learner: { id: 'learner-1' },
      course,
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: restoredSession }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.restoreSession()).resolves.toEqual(restoredSession)
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/session', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('accessCode')
  })

  it('gets the authoritative course home without deriving lesson counts in the client', async () => {
    const courseHome = {
      course,
      newWordCount: 5,
      reviewWordCount: 0,
      action: 'start',
      lessonPath: [
        { lessonNo: 1, status: 'current' },
        { lessonNo: 2, status: 'locked' },
      ],
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: courseHome }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.getCourseHome()).resolves.toEqual(courseHome)
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/course', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('logs out through the app namespace and validates the acknowledgement', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: { loggedOut: true } }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.logout()).resolves.toEqual({ loggedOut: true })
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/session/logout', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'POST',
    })
  })

  it('starts a lesson without allowing a course id to escape the app path', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: lesson }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.startLesson('course/../admin?x=1')).resolves.toEqual(lesson)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/app/courses/course%2F..%2Fadmin%3Fx%3D1/lessons/start',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('gets the authoritative lesson snapshot through the app namespace', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: lesson }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.getLesson('lesson/1')).resolves.toEqual(lesson)
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/lessons/lesson%2F1', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('previews S5 output with typed input and encoded resource ids', async () => {
    const preview = {
      taskId: 'task-1',
      draft: 'I eat an apple.',
      referenceSentence: 'I eat an apple every day.',
      revealedAt: '2026-07-13T00:00:00.000Z',
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: preview }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(
      api.previewSentenceOutput('lesson/1', 'task?1', {
        taskType: 'sentence_output',
        draft: ' I eat an apple. ',
      }),
    ).resolves.toEqual(preview)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/app/lessons/lesson%2F1/tasks/task%3F1/preview',
      {
        credentials: 'same-origin',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          taskType: 'sentence_output',
          draft: 'I eat an apple.',
        }),
      },
    )
  })

  it('submits a discriminated typed answer and validates typed feedback', async () => {
    const result = {
      taskId: 'task-1',
      score: 3,
      correct: true,
      feedback: {
        taskType: 'multiple_choice',
        correctAnswer: 'apple',
      },
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: result }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(
      api.submitAnswer('lesson/1', 'task?1', {
        taskType: 'multiple_choice',
        answer: ' apple ',
      }),
    ).resolves.toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/app/lessons/lesson%2F1/tasks/task%3F1/answer',
      {
        credentials: 'same-origin',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({ taskType: 'multiple_choice', answer: 'apple' }),
      },
    )
  })

  it('completes a lesson and validates both resulting course and session state', async () => {
    const completed = {
      course: { ...course, currentLessonNo: 2 },
      session: {
        ...lesson.session,
        status: 'completed',
        taskCount: 1,
        completedTaskCount: 1,
      },
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: completed }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.completeLesson('lesson/1')).resolves.toEqual(completed)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/app/lessons/lesson%2F1/complete',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('gets a completed lesson report through its scoped app endpoint', async () => {
    const report = {
      lessonNo: 1,
      completedTaskCount: 6,
      totalTaskCount: 6,
      correctRate: 0.8,
      needsPracticeWords: [{ id: 'word-1', word: 'apple' }],
      progressWords: [{ id: 'word-2', word: 'pear' }],
      nextLessonNo: 2,
      courseStatus: 'active',
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: report }))
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.getLessonReport('lesson/1')).resolves.toEqual(report)
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/lessons/lesson%2F1/report', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('lists completed lessons and uses isolated replay endpoints', async () => {
    const completedPage = {
      currentLearningRunNo: 2,
      lessons: [
        {
          sourceSessionId: 'lesson/1',
          learningRunNo: 1,
          lessonNo: 1,
          taskCount: 1,
          completedAt: '2026-07-18T00:00:00.000Z',
        },
      ],
    }
    const replay = {
      session: {
        id: 'replay/1',
        courseId: 'course/1',
        sourceSessionId: 'lesson/1',
        learningRunNo: 1,
        lessonNo: 1,
        status: 'started',
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      },
      tasks: [
        {
          id: 'replay-task/1',
          sessionId: 'replay/1',
          courseId: 'course/1',
          wordId: 'word-1',
          stage: 'S0',
          taskType: 'recognize_meaning',
          prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I eat an apple.' },
          orderIndex: 1,
          status: 'pending',
          role: 'primary',
          required: true,
        },
      ],
    } as const
    const answer = {
      taskId: 'replay-task/1',
      score: 3,
      correct: true,
      feedback: {
        taskType: 'recognize_meaning',
        response: 'known',
      },
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: completedPage }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: replay }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: replay }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: answer }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            ...replay,
            session: {
              ...replay.session,
              status: 'completed',
              completedTaskCount: 1,
              correctCount: 1,
            },
            tasks: [{ ...replay.tasks[0], status: 'completed' }],
          },
        }),
      )
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(
      api.listCompletedLessons('course/1', { limit: 20 }),
    ).resolves.toEqual(completedPage)
    await expect(api.startLessonReplay('lesson/1')).resolves.toEqual(replay)
    await expect(api.getLessonReplay('replay/1')).resolves.toEqual(replay)
    await expect(
      api.submitReplayAnswer('replay/1', 'replay-task/1', {
        taskType: 'recognize_meaning',
        response: 'known',
      }),
    ).resolves.toEqual(answer)
    await api.completeLessonReplay('replay/1')

    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      '/api/app/courses/course%2F1/completed-lessons?limit=20',
      '/api/app/lessons/lesson%2F1/replays',
      '/api/app/lesson-replays/replay%2F1',
      '/api/app/lesson-replays/replay%2F1/tasks/replay-task%2F1/answer',
      '/api/app/lesson-replays/replay%2F1/complete',
    ])
  })

  it('rejects invalid ids and typed commands before making a network request', () => {
    const fetchImpl = vi.fn<FetchImplementation>()
    const api = createLearnerApi(createHttpClient(fetchImpl))

    expect(() => api.exchangeAccessCode('invalid-code')).toThrow()
    expect(() => api.startLesson('   ')).toThrow()
    expect(() =>
      api.previewSentenceOutput('lesson-1', 'task-1', {
        taskType: 'sentence_output',
        draft: '   ',
      }),
    ).toThrow()
    expect(() =>
      api.submitAnswer('lesson-1', 'task-1', {
        taskType: 'sentence_build',
        pieceIds: ['piece-1', 'piece-1'],
      }),
    ).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a learner response that leaks a learning code or drifts from the schema', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          learner: {
            id: 'learner-1',
            name: 'Alice',
            accessCode: 'ABCDEFGH23',
          },
          course,
        },
      }),
    )
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await expect(api.exchangeAccessCode('ABCDEFGH23')).rejects.toBeInstanceOf(
      InvalidApiResponseError,
    )
  })

  it('keeps every public learner operation inside the app namespace', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            ok: false,
            error: { code: 'not_found', message: 'Controlled contract failure' },
          },
          { status: 404 },
        ),
      ),
    )
    const api = createLearnerApi(createHttpClient(fetchImpl))

    await Promise.allSettled([
      api.exchangeAccessCode('ABCDEFGH23'),
      api.restoreSession(),
      api.getCourseHome(),
      api.logout(),
      api.startLesson('course-1'),
      api.getLesson('lesson-1'),
      api.previewSentenceOutput('lesson-1', 'task-1', {
        taskType: 'sentence_output',
        draft: 'I eat an apple.',
      }),
      api.submitAnswer('lesson-1', 'task-1', {
        taskType: 'recognize_meaning',
        response: 'known',
      }),
      api.completeLesson('lesson-1'),
      api.getLessonReport('lesson-1'),
      api.listCompletedLessons('course-1'),
      api.startLessonReplay('lesson-1'),
      api.getLessonReplay('replay-1'),
      api.submitReplayAnswer('replay-1', 'task-1', {
        taskType: 'recognize_meaning',
        response: 'known',
      }),
      api.completeLessonReplay('replay-1'),
    ])

    const paths = fetchImpl.mock.calls.map(([path]) => requestPath(path))
    expect(paths).toHaveLength(15)
    expect(paths.every((path) => path.startsWith('/api/app/'))).toBe(true)
    expect(paths.some((path) => path.startsWith('/api/admin/'))).toBe(false)
  })
})

const requestPath = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
