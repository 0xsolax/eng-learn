import { describe, expect, it } from 'vitest'
import {
  completedLessonPageSchema,
  courseProgressResetResultSchema,
  lessonReplaySchema,
} from '../../shared/api/courseSchemas'
import { courseProgressResetRequestSchema } from '../../shared/api/schemas'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const course = {
  id: 'course-1',
  learnerId: 'learner-1',
  sourceVersionId: 'version-1',
  currentLessonNo: 1,
  status: 'active' as const,
}

describe('lesson replay and learning-run API schemas', () => {
  it('accepts a paged completed-lesson list with explicit learning-run identity', () => {
    expect(
      completedLessonPageSchema.parse({
        currentLearningRunNo: 2,
        lessons: [
          {
            sourceSessionId: 'lesson-session-1',
            learningRunNo: 1,
            lessonNo: 1,
            taskCount: 8,
            completedAt: '2026-07-18T01:00:00.000Z',
          },
        ],
        nextCursor: 'cursor-1',
      }),
    ).toMatchObject({
      currentLearningRunNo: 2,
      lessons: [{ learningRunNo: 1, lessonNo: 1 }],
    })
  })

  it('keeps replay tasks prompt-only while exposing persisted replay progress', () => {
    const replay = lessonReplaySchema.parse({
      session: {
        id: 'replay-1',
        courseId: course.id,
        sourceSessionId: 'lesson-session-1',
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
          id: 'replay-task-1',
          sessionId: 'replay-1',
          courseId: course.id,
          wordId: 'word-1',
          orderIndex: 1,
          status: 'pending',
          role: 'primary',
          required: true,
          stage: 'S5',
          taskType: 'sentence_output',
          prompt: { meaning: '苹果', instruction: 'Write one sentence.' },
        },
      ],
    })

    expect(replay.tasks[0]).not.toHaveProperty('answer')
    expect(replay.tasks[0]).not.toHaveProperty('preview')
  })

  it('requires reset CAS fields and returns an explicit preserved-history result', () => {
    const command = courseProgressResetRequestSchema.parse({
      operationToken: generateAdminOperationToken(),
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 7,
    })

    expect(command).toMatchObject({
      expectedLearningRunNo: 1,
      expectedCurrentLessonNo: 7,
    })
    expect(
      courseProgressResetResultSchema.parse({
        course,
        learningRunNo: 2,
        abandonedSessionCount: 1,
        historyPreserved: true,
      }),
    ).toMatchObject({ learningRunNo: 2, historyPreserved: true })
  })

  it('rejects unknown reset fields instead of silently widening the operation', () => {
    expect(() =>
      courseProgressResetRequestSchema.parse({
        operationToken: generateAdminOperationToken(),
        expectedLearningRunNo: 1,
        expectedCurrentLessonNo: 7,
        deleteHistory: true,
      }),
    ).toThrow()
  })
})
