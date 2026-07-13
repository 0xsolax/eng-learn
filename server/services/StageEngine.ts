import {
  isPassingReviewScore,
  type ReviewScore,
  type UserWordStateView,
} from '../../shared/domain/course'
import type { WordStage } from '../../shared/domain/content'
import type { UserWordStateRecord } from '../repositories/courseRepository'

const STAGE_ORDER: WordStage[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']

const BASE_STAGE_GAPS: Record<WordStage, number> = {
  S0: 1,
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 5,
  S5: 8,
}

export const applyAnswerScore = (
  state: UserWordStateRecord,
  input: {
    lessonNo: number
    score: ReviewScore
    updatedAt: string
  },
): UserWordStateRecord => {
  const isCorrect = isPassingReviewScore(input.score)
  const wrongStreak = isCorrect ? 0 : state.wrongStreak + 1
  const stage = isCorrect
    ? upgradeStage(state.stage)
    : input.score === 0 && wrongStreak >= 2
      ? downgradeStage(state.stage)
      : state.stage
  const easeFactor = clampEaseFactor(state.easeFactor + easeDelta(input.score))
  const nextDueLessonNo = isCorrect
    ? input.lessonNo + calculateLessonGap(stage, easeFactor, input.score)
    : input.lessonNo + 1
  const currentStreak = isCorrect ? state.currentStreak + 1 : 0

  return {
    ...state,
    stage,
    totalAttemptCount: state.totalAttemptCount + 1,
    totalCorrectCount: state.totalCorrectCount + (isCorrect ? 1 : 0),
    totalWrongCount: state.totalWrongCount + (isCorrect ? 0 : 1),
    currentStreak,
    wrongStreak,
    lapseCount: state.lapseCount + (input.score === 0 ? 1 : 0),
    easeFactor,
    masteryScore: calculateMasteryScore(stage, currentStreak),
    lastSeenLessonNo: input.lessonNo,
    nextDueLessonNo,
    status: stage === 'S5' ? 'reviewing' : 'learning',
    updatedAt: input.updatedAt,
  }
}

const upgradeStage = (stage: WordStage): WordStage => {
  const index = STAGE_ORDER.indexOf(stage)
  const nextStage = STAGE_ORDER[Math.min(index + 1, STAGE_ORDER.length - 1)]

  return nextStage ?? stage
}

const downgradeStage = (stage: WordStage): WordStage => {
  const index = STAGE_ORDER.indexOf(stage)
  const previousStage = STAGE_ORDER[Math.max(index - 1, 0)]

  return previousStage ?? stage
}

const easeDelta = (score: ReviewScore): number => {
  if (score === 3) {
    return 0.15
  }

  if (score === 0) {
    return -0.25
  }

  if (score === 1) {
    return -0.1
  }

  return 0
}

const calculateLessonGap = (
  stage: WordStage,
  easeFactor: number,
  score: ReviewScore,
): number => {
  const base = BASE_STAGE_GAPS[stage]

  if (score === 3) {
    return Math.ceil(base * Math.min(easeFactor, 1.8))
  }

  if (score === 2) {
    return base
  }

  if (score === 1) {
    return Math.max(1, Math.floor(base * 0.5))
  }

  return 1
}

const clampEaseFactor = (value: number): number => Math.max(0.5, Math.min(2, value))

const calculateMasteryScore = (stage: WordStage, currentStreak: number): number => {
  const stageScore = STAGE_ORDER.indexOf(stage) * 12
  const streakScore = Math.min(currentStreak * 3, 15)

  return Math.max(0, Math.min(100, Math.round(stageScore + streakScore)))
}

export type StageEngineState = UserWordStateView
