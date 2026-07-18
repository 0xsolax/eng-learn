import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import LessonReplayRunner from '@/features/lesson-runner/LessonReplayRunner.vue'

describe('LessonReplayRunner', () => {
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
    expect(wrapper.text()).toContain('重复练习')
    expect(wrapper.text()).toContain('第 1 课')
    await wrapper.get('[data-action="complete-replay"]').trigger('click')
    await flushPromises()

    expect(api.completeLessonReplay).toHaveBeenCalledWith('replay-1')
    expect(wrapper.text()).toContain('本次答对 1 / 1 道')
    expect(wrapper.emitted('completed')).toBeUndefined()

    await wrapper.get('[data-action="return-to-course"]').trigger('click')

    expect(wrapper.emitted('completed')).toHaveLength(1)
  })
})
