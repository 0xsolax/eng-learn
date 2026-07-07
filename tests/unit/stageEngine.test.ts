import { describe, expect, it } from 'vitest'
import { applyAnswerScore } from '../../server/services/StageEngine'
import type { UserWordStateRecord } from '../../server/repositories/courseRepository'

const createState = (overrides: Partial<UserWordStateRecord> = {}): UserWordStateRecord => ({
  id: 'state-1',
  courseId: 'course-1',
  wordId: 'word-1',
  groupId: 'group-1',
  stage: 'S0',
  totalAttemptCount: 0,
  totalCorrectCount: 0,
  totalWrongCount: 0,
  currentStreak: 0,
  wrongStreak: 0,
  lapseCount: 0,
  easeFactor: 1,
  masteryScore: 0,
  firstLessonNo: 1,
  nextDueLessonNo: 1,
  status: 'new',
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
  ...overrides,
})

describe('stage engine', () => {
  it('score three increases ease and stretches the next lesson gap', () => {
    const state = applyAnswerScore(createState(), {
      lessonNo: 1,
      score: 3,
      updatedAt: '2026-07-06T00:00:00.000Z',
    })

    expect(state).toMatchObject({
      stage: 'S1',
      totalAttemptCount: 1,
      totalCorrectCount: 1,
      currentStreak: 1,
      wrongStreak: 0,
      easeFactor: 1.15,
      nextDueLessonNo: 3,
    })
  })

  it('score zero records lapse and downgrades after two consecutive wrong answers', () => {
    const state = applyAnswerScore(
      createState({
        stage: 'S2',
        wrongStreak: 1,
      }),
      {
        lessonNo: 8,
        score: 0,
        updatedAt: '2026-07-06T00:00:00.000Z',
      },
    )

    expect(state).toMatchObject({
      stage: 'S1',
      totalAttemptCount: 1,
      totalWrongCount: 1,
      currentStreak: 0,
      wrongStreak: 2,
      lapseCount: 1,
      easeFactor: 0.75,
      nextDueLessonNo: 9,
    })
  })
})
