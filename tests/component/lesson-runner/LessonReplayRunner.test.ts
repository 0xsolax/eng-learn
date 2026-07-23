import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LessonReplayRunner from '@/features/lesson-runner/LessonReplayRunner.vue'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LessonReplayRunner', () => {
  it.each([
    {
      label: 'correct',
      answer: 'apple',
      score: 3 as const,
      correct: true,
      correctCount: 1,
      wrongCount: 0,
      source: '/sounds/answer-feedback-correct.wav',
    },
    {
      label: 'wrong',
      answer: 'wrong',
      score: 0 as const,
      correct: false,
      correctCount: 0,
      wrongCount: 1,
      source: '/sounds/answer-feedback-wrong.wav',
    },
  ])('plays the selected feedback sound after a replay answer is confirmed $label', async (scenario) => {
    const pendingReplay = {
      session: {
        id: 'replay-1',
        courseId: 'course-1',
        sourceSessionId: 'session-1',
        learningRunNo: 1,
        lessonNo: 1,
        status: 'started' as const,
        taskCount: 1,
        completedTaskCount: 0,
        correctCount: 0,
        wrongCount: 0,
      },
      tasks: [
        {
          id: 'replay-task-1',
          sessionId: 'replay-1',
          courseId: 'course-1',
          wordId: 'word-1',
          stage: 'S1' as const,
          taskType: 'recall_word' as const,
          prompt: { meaning: '苹果' },
          orderIndex: 1,
          status: 'pending' as const,
          role: 'primary' as const,
          required: true,
        },
      ],
    }
    const completedTaskReplay = {
      ...pendingReplay,
      session: {
        ...pendingReplay.session,
        completedTaskCount: 1,
        correctCount: scenario.correctCount,
        wrongCount: scenario.wrongCount,
      },
      tasks: pendingReplay.tasks.map((task) => ({ ...task, status: 'completed' as const })),
    }
    const play = vi.fn().mockResolvedValue(undefined)
    const AudioBoundary = vi.fn(function AudioBoundaryMock() {
      return { play, volume: 1 }
    })
    vi.stubGlobal('Audio', AudioBoundary)
    const api = {
      getLessonReplay: vi
        .fn()
        .mockResolvedValueOnce(pendingReplay)
        .mockResolvedValueOnce(completedTaskReplay),
      previewReplaySentenceOutput: vi.fn(),
      submitReplayAnswer: vi.fn().mockResolvedValue({
        taskId: 'replay-task-1',
        score: scenario.score,
        correct: scenario.correct,
        feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
      }),
      completeLessonReplay: vi.fn(),
    }
    const wrapper = mount(LessonReplayRunner, {
      props: { api, replaySessionId: 'replay-1' },
    })
    await flushPromises()

    await wrapper.get('input').setValue(scenario.answer)
    await wrapper.get('.task-form').trigger('submit')
    await flushPromises()

    expect(AudioBoundary).toHaveBeenCalledWith(scenario.source)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('completes through the replay ledger and never requires formal lesson writes', async () => {
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
          stage: 'S0' as const,
          taskType: 'recognize_meaning' as const,
          prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I eat an apple.' },
          orderIndex: 1,
          status: 'completed' as const,
          role: 'primary' as const,
          required: true,
        },
      ],
    }
    const api = {
      getLessonReplay: vi.fn().mockResolvedValue(replay),
      previewReplaySentenceOutput: vi.fn(),
      submitReplayAnswer: vi.fn(),
      completeLessonReplay: vi.fn().mockResolvedValue({
        ...replay,
        session: { ...replay.session, status: 'completed' as const },
      }),
    }
    const wrapper = mount(LessonReplayRunner, {
      props: { api, replaySessionId: 'replay-1' },
    })
    await flushPromises()

    expect(api.getLessonReplay).toHaveBeenCalledWith('replay-1')
    expect(wrapper.get('h1').text()).toBe('第 1 课')
    expect(wrapper.text()).not.toMatch(/重复练习|再练一次/u)
    expect(wrapper.text()).toContain('本次结果不会改变当前课程进度')
    expect(wrapper.get('[data-action="complete-replay"]').text()).toBe('完成第 1 课')
    await wrapper.get('[data-action="complete-replay"]').trigger('click')
    await flushPromises()

    expect(api.completeLessonReplay).toHaveBeenCalledWith('replay-1')
    expect(wrapper.text()).toContain('本次答对 1 / 1 道')
    expect(wrapper.get('h1').text()).toBe('第 1 课')
    expect(wrapper.text()).not.toMatch(/重复练习|再练一次/u)
    expect(wrapper.emitted('completed')).toBeUndefined()

    await wrapper.get('[data-action="return-to-course"]').trigger('click')

    expect(wrapper.emitted('completed')).toHaveLength(1)
  })
})
