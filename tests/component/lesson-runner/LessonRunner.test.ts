import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ApiFailureError, ApiNetworkError, InvalidApiResponseError } from '@/api/errors'
import LessonRunner from '@/features/lesson-runner/LessonRunner.vue'
import type { LessonTaskDto } from '@shared/api/taskSchemas'

const recallTask = (
  id: string,
  orderIndex: number,
  meaning: string,
  status: LessonTaskDto['status'],
): LessonTaskDto => ({
  id,
  sessionId: 'session-7',
  courseId: 'course-1',
  wordId: `word-${id}`,
  orderIndex,
  status,
  role: 'primary',
  required: true,
  stage: 'S1',
  taskType: 'recall_word',
  prompt: { meaning },
})

const lesson = {
  session: {
    id: 'session-7',
    courseId: 'course-1',
    lessonNo: 7,
    status: 'started' as const,
    taskCount: 3,
    completedTaskCount: 1,
  },
  tasks: [
    recallTask('task-1', 1, '已经完成的题', 'completed'),
    recallTask('task-2', 2, '当前待答题', 'pending'),
    recallTask('task-3', 3, '后续待答题', 'pending'),
  ],
}

const [completedFixtureTask, currentFixtureTask, nextFixtureTask] = lesson.tasks
if (!completedFixtureTask || !currentFixtureTask || !nextFixtureTask) {
  throw new Error('Lesson runner fixture requires three tasks')
}

const sentenceOutputLesson = {
  session: {
    id: 'session-s5',
    courseId: 'course-1',
    lessonNo: 7,
    status: 'started' as const,
    taskCount: 1,
    completedTaskCount: 0,
  },
  tasks: [
    {
      id: 'task-s5',
      sessionId: 'session-s5',
      courseId: 'course-1',
      wordId: 'word-s5',
      orderIndex: 1,
      status: 'pending' as const,
      role: 'primary' as const,
      required: true,
      stage: 'S5' as const,
      taskType: 'sentence_output' as const,
      prompt: { meaning: '我每天吃一个苹果。', instruction: '写一个完整英文句子' },
    },
  ],
}

const runnerApiNoops = () => ({
  completeLesson: vi.fn(),
  previewSentenceOutput: vi.fn(),
})

const learnerSessionErrorCodes = [
  'learner_session_required',
  'learner_session_expired',
  'learner_session_revoked',
] as const

const learnerSessionFailure = (code: (typeof learnerSessionErrorCodes)[number]) =>
  new ApiFailureError(401, { code, message: 'Learner session is unavailable' })

const expectAccessRequiredWithoutNetworkRetry = (wrapper: VueWrapper): void => {
  expect(wrapper.emitted('access-required')).toHaveLength(1)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('.task-form').exists()).toBe(false)
  expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  expect(wrapper.find('[data-action="reload-lesson"]').exists()).toBe(false)
}

describe('LessonRunner', () => {
  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of showing initial-load retry for %s',
    async (code) => {
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockRejectedValue(learnerSessionFailure(code)),
        submitAnswer: vi.fn(),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })

      await flushPromises()

      expect(api.getLesson).toHaveBeenCalledTimes(1)
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('unloads the lesson for a non-JSON 401 instead of exposing stale retry UI', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockRejectedValue(new InvalidApiResponseError(401)),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expectAccessRequiredWithoutNetworkRetry(wrapper)
  })

  it('shows safe return-and-contact guidance for incompatible persisted lesson content', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'legacy_content_incompatible',
          message: 'internal reason: meaning_reveals_answer apple',
        }),
      ),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    const alert = wrapper.get('[role="alert"]').text()
    expect(alert).toContain('本课内容暂时无法使用')
    expect(alert).toContain('联系课程管理员')
    expect(alert).not.toContain('meaning_reveals_answer')
    expect(alert).not.toContain('apple')
    expect(alert).not.toContain('检查网络')
    expect(wrapper.find('[data-action="reload-lesson"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('返回课程')
  })

  it.each([
    ['completed', 'completed'],
    ['abandoned', 'exit'],
  ] as const)(
    'routes an initially restored %s authority session without another mutation',
    async (status, event) => {
      const authoritativeLesson = {
        ...lesson,
        session: {
          ...lesson.session,
          status,
          completedTaskCount: status === 'completed' ? 3 : 1,
        },
        tasks: status === 'completed'
          ? lesson.tasks.map((task) => ({ ...task, status: 'completed' as const }))
          : lesson.tasks,
      }
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(authoritativeLesson),
        submitAnswer: vi.fn(),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })

      await flushPromises()

      expect(api.getLesson).toHaveBeenCalledTimes(1)
      expect(api.submitAnswer).not.toHaveBeenCalled()
      expect(api.completeLesson).not.toHaveBeenCalled()
      expect(wrapper.emitted(event)).toEqual([[]])
    },
  )

  it('gets the authoritative snapshot and renders only its first pending task', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(lesson),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })

    await flushPromises()

    expect(api.getLesson).toHaveBeenCalledWith('session-7')
    expect(wrapper.get('h2').text()).toBe('当前待答题')
    expect(wrapper.text()).not.toContain('已经完成的题')
    expect(wrapper.text()).not.toContain('后续待答题')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('2')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('3')
  })

  it('shows server feedback, re-gets authority, and advances only after continue', async () => {
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: [
        completedFixtureTask,
        { ...currentFixtureTask, status: 'completed' as const },
        nextFixtureTask,
      ],
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi.fn().mockResolvedValue({
        taskId: 'task-2',
        score: 0,
        correct: false,
        feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
      }),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('wrong')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledWith('session-7', 'task-2', {
      taskType: 'recall_word',
      answer: 'wrong',
    })
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('h2').text()).toBe('当前待答题')
    expect(wrapper.get('[role="alert"]').text()).toContain('参考答案：apple')
    expect(wrapper.get('[data-action="retry"]').text()).toBe('继续')

    await wrapper.get('[data-action="retry"]').trigger('click')

    expect(wrapper.get('h2').text()).toBe('后续待答题')
  })

  it('moves focus from answer feedback to the next authoritative task', async () => {
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: [
        completedFixtureTask,
        { ...currentFixtureTask, status: 'completed' as const },
        nextFixtureTask,
      ],
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi.fn().mockResolvedValue({
        taskId: 'task-2',
        score: 3,
        correct: true,
        feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
      }),
    }
    const wrapper = mount(LessonRunner, {
      attachTo: document.body,
      props: { api, sessionId: 'session-7' },
    })

    try {
      await flushPromises()
      await wrapper.get('input').setValue('apple')
      await wrapper.get('.task-form').trigger('submit')
      await flushPromises()

      const continueAction = wrapper.get('[data-action="retry"]')
      expect(document.activeElement).toBe(continueAction.element)

      await continueAction.trigger('click')

      expect(wrapper.get('h2').text()).toBe('后续待答题')
      expect(document.activeElement).toBe(wrapper.get('input').element)
    } finally {
      wrapper.unmount()
    }
  })

  it('preserves input and position across a network failure, then retries the same answer once', async () => {
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: [
        completedFixtureTask,
        { ...currentFixtureTask, status: 'completed' as const },
        nextFixtureTask,
      ],
    }
    const result = {
      taskId: 'task-2',
      score: 3 as const,
      correct: true,
      feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
    }
    let rejectFirst: ((reason: unknown) => void) | undefined
    const firstAttempt = new Promise<typeof result>((_resolve, reject) => {
      rejectFirst = reject
    })
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi
        .fn()
        .mockReturnValueOnce(firstAttempt)
        .mockResolvedValueOnce(result),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await wrapper.get('.task-form').trigger('submit')
    expect(api.submitAnswer).toHaveBeenCalledTimes(1)

    rejectFirst?.(new ApiNetworkError(new Error('offline')))
    await flushPromises()

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('apple')
    expect(wrapper.get('h2').text()).toBe('当前待答题')
    expect(wrapper.get('[role="alert"]').text()).toContain('答案和当前题目都已保留')
    expect(api.getLesson).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(2)
    expect(api.submitAnswer.mock.calls[1]).toEqual(api.submitAnswer.mock.calls[0])
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-action="retry"]').text()).toBe('继续')
  })

  it('retries the identical answer after a malformed success response leaves the result unknown', async () => {
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: [
        completedFixtureTask,
        { ...currentFixtureTask, status: 'completed' as const },
        nextFixtureTask,
      ],
    }
    const result = {
      taskId: 'task-2',
      score: 3 as const,
      correct: true,
      feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi
        .fn()
        .mockRejectedValueOnce(new InvalidApiResponseError(200))
        .mockResolvedValueOnce(result),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新提交')

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(2)
    expect(api.submitAnswer.mock.calls[1]).toEqual(api.submitAnswer.mock.calls[0])
    expect(api.getLesson).toHaveBeenCalledTimes(2)
  })

  it.each(['task_not_current', 'conflict'] as const)(
    'preserves the answer but re-syncs authority instead of resubmitting after %s',
    async (code) => {
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: [
        completedFixtureTask,
        { ...currentFixtureTask, status: 'completed' as const },
        nextFixtureTask,
      ],
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi.fn().mockRejectedValue(
        new ApiFailureError(409, { code, message: 'Task authority changed' }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('apple')
    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新同步本课')

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
      expect(wrapper.get('h2').text()).toBe('后续待答题')
    },
  )

  it('routes a completed authority snapshot after lesson_not_active without resubmitting', async () => {
    const completedAuthority = {
      ...lesson,
      session: {
        ...lesson.session,
        status: 'completed' as const,
        completedTaskCount: 3,
      },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockResolvedValueOnce(completedAuthority),
      submitAnswer: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'lesson_not_active',
          message: 'Lesson session is not active',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新同步本课')
    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('completed')).toEqual([[]])
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it('returns to the course without retrying submit when authority reports course_unavailable', async () => {
      const failure = new ApiFailureError(409, {
        code: 'course_unavailable',
        message: 'Course cannot continue',
      })
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(lesson),
        submitAnswer: vi.fn().mockRejectedValue(failure),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })
      await flushPromises()

      await wrapper.get('input').setValue('apple')
      await wrapper.get('.task-form').trigger('submit')
      await flushPromises()

      expect(api.submitAnswer).toHaveBeenCalledTimes(1)
      expect(api.getLesson).toHaveBeenCalledTimes(1)
      expect(wrapper.emitted('exit')).toEqual([[]])
      expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it.each(['validation_error', 'task_type_mismatch'] as const)(
    'shows a non-retryable task error instead of blindly resubmitting after %s',
    async (code) => {
      const failure = code === 'validation_error'
        ? new ApiFailureError(400, {
            code,
            message: 'Submission is invalid',
            details: {
              fields: [{ path: 'submission.answer', message: 'Answer is invalid' }],
            },
          })
        : new ApiFailureError(400, { code, message: 'Task type does not match' })
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(lesson),
        submitAnswer: vi.fn().mockRejectedValue(failure),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })
      await flushPromises()

      await wrapper.get('input').setValue('apple')
      await wrapper.get('.task-form').trigger('submit')
      await flushPromises()

      expect(api.submitAnswer).toHaveBeenCalledTimes(1)
      expect(api.getLesson).toHaveBeenCalledTimes(1)
      expect((wrapper.get('input').element as HTMLInputElement).value).toBe('apple')
      expect(wrapper.get('[role="alert"]').text()).toContain('当前答案无法提交')
      expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
    },
  )

  it('does not offer a blind submit retry for another definitive 4xx failure', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(lesson),
      submitAnswer: vi.fn().mockRejectedValue(
        new ApiFailureError(403, {
          code: 'forbidden_resource',
          message: 'The task is not available to this learner',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('当前请求无法安全重试')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it('does not retry an answer after a non-JSON 403 response', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(lesson),
      submitAnswer: vi.fn().mockRejectedValue(new InvalidApiResponseError(403)),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('当前请求无法安全重试')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of retrying an answer submission for %s',
    async (code) => {
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(lesson),
        submitAnswer: vi.fn().mockRejectedValue(learnerSessionFailure(code)),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })
      await flushPromises()

      await wrapper.get('input').setValue('apple')
      await wrapper.get('.task-form').trigger('submit')
      await flushPromises()

      expect(api.submitAnswer).toHaveBeenCalledTimes(1)
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('retries only the authoritative re-get when the answer was already saved', async () => {
    const result = {
      taskId: 'task-2',
      score: 3 as const,
      correct: true,
      feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
    }
    const refreshedLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 2 },
      tasks: lesson.tasks.map((task) =>
        task.id === 'task-2' ? { ...task, status: 'completed' as const } : task,
      ),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline after save')))
        .mockResolvedValueOnce(refreshedLesson),
      submitAnswer: vi.fn().mockResolvedValue(result),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('答案已保存')
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新同步')

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(3)
    expect(wrapper.get('[data-action="retry"]').text()).toBe('继续')
  })

  it('returns to the course when the post-answer authority read reports course_unavailable', async () => {
    const result = {
      taskId: 'task-2',
      score: 3 as const,
      correct: true,
      feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockRejectedValueOnce(
          new ApiFailureError(409, {
            code: 'course_unavailable',
            message: 'Course is not active',
          }),
        ),
      submitAnswer: vi.fn().mockResolvedValue(result),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('exit')).toEqual([[]])
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it('does not loop the post-answer authority read for incompatible legacy content', async () => {
    const result = {
      taskId: 'task-2',
      score: 3 as const,
      correct: true,
      feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(lesson)
        .mockRejectedValueOnce(
          new ApiFailureError(409, {
            code: 'legacy_content_incompatible',
            message: 'internal reason: unsafe apple answer',
          }),
        ),
      submitAnswer: vi.fn().mockResolvedValue(result),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('input').setValue('apple')
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    const alert = wrapper.get('[role="alert"]').text()
    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(alert).toContain('本课内容暂时无法使用')
    expect(alert).toContain('联系课程管理员')
    expect(alert).not.toContain('unsafe apple answer')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of retrying the post-answer re-get for %s',
    async (code) => {
      const result = {
        taskId: 'task-2',
        score: 3 as const,
        correct: true,
        feedback: { taskType: 'recall_word' as const, correctAnswer: 'apple' },
      }
      const api = {
        ...runnerApiNoops(),
        getLesson: vi
          .fn()
          .mockResolvedValueOnce(lesson)
          .mockRejectedValueOnce(learnerSessionFailure(code)),
        submitAnswer: vi.fn().mockResolvedValue(result),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })
      await flushPromises()

      await wrapper.get('input').setValue('apple')
      await wrapper.get('.task-form').trigger('submit')
      await flushPromises()

      expect(api.submitAnswer).toHaveBeenCalledTimes(1)
      expect(api.getLesson).toHaveBeenCalledTimes(2)
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('reveals S5 reference and 0–3 self-score only after one server preview', async () => {
    const preview = {
      taskId: 'task-s5',
      draft: 'I eat an apple every day.',
      referenceSentence: 'I eat an apple every day.',
      revealedAt: '2026-07-13T00:00:00.000Z',
    }
    let resolvePreview: ((value: typeof preview) => void) | undefined
    const pendingPreview = new Promise<typeof preview>((resolve) => {
      resolvePreview = resolve
    })
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(sentenceOutputLesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn().mockReturnValue(pendingPreview),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain('I eat an apple every day.')
    expect(wrapper.findAll('[data-self-score]')).toHaveLength(0)
    await wrapper.get('textarea').setValue('I eat an apple every day.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await wrapper.get('[data-action="preview"]').trigger('click')
    expect(api.previewSentenceOutput).toHaveBeenCalledTimes(1)
    expect(api.previewSentenceOutput).toHaveBeenCalledWith('session-s5', 'task-s5', {
      taskType: 'sentence_output',
      draft: 'I eat an apple every day.',
    })

    resolvePreview?.(preview)
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toContain('I eat an apple every day.')
    expect(wrapper.findAll('[data-self-score]')).toHaveLength(4)
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of retrying an S5 preview for %s',
    async (code) => {
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(sentenceOutputLesson),
        submitAnswer: vi.fn(),
        previewSentenceOutput: vi.fn().mockRejectedValue(learnerSessionFailure(code)),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-s5' },
      })
      await flushPromises()

      await wrapper.get('textarea').setValue('I eat an apple every day.')
      await wrapper.get('[data-action="preview"]').trigger('click')
      await flushPromises()

      expect(api.previewSentenceOutput).toHaveBeenCalledTimes(1)
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('keeps a non-session S5 preview failure on the existing retry path', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(sentenceOutputLesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('offline')),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    await wrapper.get('textarea').setValue('I eat an apple every day.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('参考句尚未读取')
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新预览')
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

  it('does not offer a blind preview retry for task_type_mismatch', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(sentenceOutputLesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn().mockRejectedValue(
        new ApiFailureError(400, {
          code: 'task_type_mismatch',
          message: 'Only sentence-output tasks support preview',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    await wrapper.get('textarea').setValue('My local draft.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await flushPromises()

    expect(api.previewSentenceOutput).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('My local draft.')
    expect(wrapper.get('[role="alert"]').text()).toContain('当前参考句无法读取')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
  })

  it('re-syncs an S5 preview conflict and remounts the same task with the authority draft', async () => {
    const authorityDraft = 'I eat the authority apple every day.'
    const authoritativeLesson = {
      ...sentenceOutputLesson,
      tasks: sentenceOutputLesson.tasks.map((task) => ({
        ...task,
        preview: {
          draft: authorityDraft,
          referenceSentence: 'I eat an apple every day.',
          revealedAt: '2026-07-13T00:00:00.000Z',
        },
      })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(sentenceOutputLesson)
        .mockResolvedValueOnce(authoritativeLesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'conflict',
          message: 'Sentence output preview is already fixed',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    await wrapper.get('textarea').setValue('My local draft.')
    await wrapper.get('[data-action="preview"]').trigger('click')
    await flushPromises()

    expect(api.previewSentenceOutput).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('My local draft.')
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新同步本课')

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.previewSentenceOutput).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(authorityDraft)
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
    expect(wrapper.get('[role="status"]').text()).toContain('I eat an apple every day.')
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of retrying an S5 self-score for %s',
    async (code) => {
      const restoredLesson = {
        ...sentenceOutputLesson,
        tasks: sentenceOutputLesson.tasks.map((task) => ({
          ...task,
          preview: {
            draft: 'I eat an apple every day.',
            referenceSentence: 'I eat an apple every day.',
            revealedAt: '2026-07-13T00:00:00.000Z',
          },
        })),
      }
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(restoredLesson),
        submitAnswer: vi.fn().mockRejectedValue(learnerSessionFailure(code)),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-s5' },
      })
      await flushPromises()

      await wrapper.get('[data-self-score="2"]').trigger('click')
      await flushPromises()

      expect(api.submitAnswer).toHaveBeenCalledTimes(1)
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('re-syncs s5_preview_required and submits only the authority draft after recovery', async () => {
    const localDraft = 'My stale local apple sentence.'
    const authorityDraft = 'My authoritative apple sentence.'
    const restoredLesson = {
      ...sentenceOutputLesson,
      tasks: sentenceOutputLesson.tasks.map((task) => ({
        ...task,
        preview: {
          draft: localDraft,
          referenceSentence: 'I eat an apple every day.',
          revealedAt: '2026-07-13T00:00:00.000Z',
        },
      })),
    }
    const authoritativeLesson = {
      ...restoredLesson,
      tasks: restoredLesson.tasks.map((task) => ({
        ...task,
        preview: { ...task.preview, draft: authorityDraft },
      })),
    }
    const pendingRescore = new Promise<never>(() => undefined)
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(restoredLesson)
        .mockResolvedValueOnce(authoritativeLesson),
      submitAnswer: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiFailureError(409, {
            code: 's5_preview_required',
            message: 'Sentence output preview must be restored',
          }),
        )
        .mockReturnValueOnce(pendingRescore),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    await wrapper.get('[data-self-score="2"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-action="retry"]').text()).toBe('重新同步本课')

    await wrapper.get('[data-action="retry"]').trigger('click')
    await flushPromises()

    expect(api.submitAnswer).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(authorityDraft)
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()

    await wrapper.get('[data-self-score="3"]').trigger('click')

    expect(api.submitAnswer).toHaveBeenCalledTimes(2)
    expect(api.submitAnswer).toHaveBeenLastCalledWith('session-s5', 'task-s5', {
      taskType: 'sentence_output',
      draft: authorityDraft,
      selfScore: 3,
    })
  })

  it('restores an authoritative S5 preview after the lesson page is reloaded', async () => {
    const restoredLesson = {
      ...sentenceOutputLesson,
      tasks: sentenceOutputLesson.tasks.map((task) => ({
        ...task,
        preview: {
          draft: 'I eat one apple every day.',
          referenceSentence: 'I eat an apple every day.',
          revealedAt: '2026-07-13T00:00:00.000Z',
        },
      })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(restoredLesson),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-s5' },
    })
    await flushPromises()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value)
      .toBe('I eat one apple every day.')
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
    expect(wrapper.find('[data-action="preview"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('I eat an apple every day.')
    expect(wrapper.findAll('[data-self-score]')).toHaveLength(4)
    expect(api.previewSentenceOutput).not.toHaveBeenCalled()
  })

  it('asks the server to complete once and emits only its CompletedLesson summary', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const completedLesson = {
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 8,
        status: 'active' as const,
      },
      session: {
        ...answeredLesson.session,
        status: 'completed' as const,
      },
    }
    let resolveComplete: ((value: typeof completedLesson) => void) | undefined
    const pendingComplete = new Promise<typeof completedLesson>((resolve) => {
      resolveComplete = resolve
    })
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(answeredLesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn(),
      completeLesson: vi.fn().mockReturnValue(pendingComplete),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    const action = wrapper.get('[data-action="complete-lesson"]')
    await action.trigger('click')
    await action.trigger('click')

    expect(api.completeLesson).toHaveBeenCalledTimes(1)
    expect(api.completeLesson).toHaveBeenCalledWith('session-7')
    expect(action.attributes('aria-busy')).toBe('true')

    resolveComplete?.(completedLesson)
    await flushPromises()

    expect(wrapper.emitted('completed')).toEqual([[completedLesson]])
  })

  it('re-gets authority instead of retrying completion after lesson_not_active', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const completedAuthority = {
      ...answeredLesson,
      session: { ...answeredLesson.session, status: 'completed' as const },
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(answeredLesson)
        .mockResolvedValueOnce(completedAuthority),
      submitAnswer: vi.fn(),
      completeLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'lesson_not_active',
          message: 'Lesson session is not active',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('[data-action="complete-lesson"]').trigger('click')
    await flushPromises()

    expect(api.completeLesson).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('completed')).toEqual([[]])
    expect(wrapper.find('[data-action="complete-lesson"]').exists()).toBe(false)
  })

  it('prioritizes the completion action over the exit action after restoring an answered lesson', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(answeredLesson),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      attachTo: document.body,
      props: { api, sessionId: 'session-7' },
    })

    try {
      await flushPromises()

      expect(document.activeElement).toBe(
        wrapper.get('[data-action="complete-lesson"]').element,
      )
    } finally {
      wrapper.unmount()
    }
  })

  it('does not loop lesson completion for incompatible legacy content', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(answeredLesson),
      submitAnswer: vi.fn(),
      completeLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'legacy_content_incompatible',
          message: 'internal unsafe content reason',
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('[data-action="complete-lesson"]').trigger('click')
    await flushPromises()

    const alert = wrapper.get('[role="alert"]').text()
    expect(api.completeLesson).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(1)
    expect(alert).toContain('本课内容暂时无法使用')
    expect(alert).toContain('联系课程管理员')
    expect(alert).not.toContain('internal unsafe content reason')
    expect(wrapper.find('[data-action="complete-lesson"]').exists()).toBe(false)
  })

  it('moves focus to the exit action after a deterministic completion failure', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(answeredLesson),
      submitAnswer: vi.fn(),
      completeLesson: vi.fn().mockRejectedValue(new InvalidApiResponseError(403)),
    }
    const wrapper = mount(LessonRunner, {
      attachTo: document.body,
      props: { api, sessionId: 'session-7' },
    })

    try {
      await flushPromises()
      const completeAction = wrapper.get('[data-action="complete-lesson"]')
      ;(completeAction.element as HTMLElement).focus()

      await completeAction.trigger('click')
      await flushPromises()

      const exitAction = wrapper.get('[data-action="exit"]')
      expect(wrapper.find('[data-action="complete-lesson"]').exists()).toBe(false)
      expect(document.activeElement).toBe(exitAction.element)
    } finally {
      wrapper.unmount()
    }
  })

  it.each(learnerSessionErrorCodes)(
    'requests a new access code instead of retrying lesson completion for %s',
    async (code) => {
      const answeredLesson = {
        ...lesson,
        session: { ...lesson.session, completedTaskCount: 3 },
        tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
      }
      const api = {
        ...runnerApiNoops(),
        getLesson: vi.fn().mockResolvedValue(answeredLesson),
        submitAnswer: vi.fn(),
        completeLesson: vi.fn().mockRejectedValue(learnerSessionFailure(code)),
      }
      const wrapper = mount(LessonRunner, {
        props: { api, sessionId: 'session-7' },
      })
      await flushPromises()

      await wrapper.get('[data-action="complete-lesson"]').trigger('click')
      await flushPromises()

      expect(api.completeLesson).toHaveBeenCalledTimes(1)
      expect(wrapper.emitted('completed')).toBeUndefined()
      expectAccessRequiredWithoutNetworkRetry(wrapper)
    },
  )

  it('keeps an unconfirmed non-session completion on the existing retry path', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi.fn().mockResolvedValue(answeredLesson),
      submitAnswer: vi.fn(),
      completeLesson: vi.fn().mockRejectedValue(
        new ApiNetworkError(new Error('offline')),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('[data-action="complete-lesson"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('完成请求尚未确认')
    expect(wrapper.get('[data-action="complete-lesson"]').text()).toBe('重新确认完成')
    expect(wrapper.emitted('access-required')).toBeUndefined()
  })

  it('shows the server lesson_incomplete block and reloads authority instead of forcing completion', async () => {
    const answeredLesson = {
      ...lesson,
      session: { ...lesson.session, completedTaskCount: 3 },
      tasks: lesson.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockResolvedValueOnce(answeredLesson)
        .mockResolvedValueOnce(lesson),
      submitAnswer: vi.fn(),
      previewSentenceOutput: vi.fn(),
      completeLesson: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'lesson_incomplete',
          message: 'Lesson completion requirements are not met',
          details: {
            completedPrimary: 2,
            totalPrimary: 3,
            pendingRequiredTaskIds: ['task-2'],
          },
        }),
      ),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    await wrapper.get('[data-action="complete-lesson"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('1 道必答任务未完成')
    expect(wrapper.get('[role="alert"]').text()).toContain('2 / 3')
    expect(wrapper.get('[data-action="complete-lesson"]').text()).toBe('重新读取本课')

    await wrapper.get('[data-action="complete-lesson"]').trigger('click')
    await flushPromises()

    expect(api.completeLesson).toHaveBeenCalledTimes(1)
    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('h2').text()).toBe('当前待答题')
  })

  it('recovers from an initial lesson read failure without trapping the learner', async () => {
    const api = {
      ...runnerApiNoops(),
      getLesson: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(lesson),
      submitAnswer: vi.fn(),
    }
    const wrapper = mount(LessonRunner, {
      props: { api, sessionId: 'session-7' },
    })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取本课')
    await wrapper.get('[data-action="reload-lesson"]').trigger('click')
    await flushPromises()

    expect(api.getLesson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('h2').text()).toBe('当前待答题')
  })
})
