import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  useLearnerApi,
  type LearnerApiPort,
} from '@/features/learner-course/learnerApiPort'

const createFallback = (): LearnerApiPort => ({
  exchangeAccessCode: vi.fn(),
  restoreSession: vi.fn(),
  logout: vi.fn(),
  getCourseHome: vi.fn(),
  startLesson: vi.fn(),
  getLesson: vi.fn(),
  previewSentenceOutput: vi.fn(),
  submitAnswer: vi.fn(),
  completeLesson: vi.fn(),
  getLessonReport: vi.fn(),
})

describe('learner API port', () => {
  it('uses the production fallback without logging a missing injection warning', () => {
    const fallback = createFallback()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const Probe = defineComponent({
      setup: () => {
        const api = useLearnerApi(() => fallback)
        return () => h('output', api === fallback ? 'fallback' : 'provided')
      },
    })

    try {
      const wrapper = mount(Probe)

      expect(wrapper.text()).toBe('fallback')
      expect(
        warning.mock.calls.some((call) => String(call[0]).includes('injection')),
      ).toBe(false)
    } finally {
      warning.mockRestore()
    }
  })
})
