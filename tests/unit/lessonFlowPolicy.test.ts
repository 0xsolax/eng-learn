import { describe, expect, it } from 'vitest'
import {
  LESSON_FLOW_BUDGETS,
  planRollingLessonFlow,
  type LessonFlowNewWord,
  type LessonFlowWordState,
} from '../../server/services/LessonFlowPolicy'

describe('lesson flow policy v2', () => {
  it('exports the frozen visible-task and per-word budgets', () => {
    expect(LESSON_FLOW_BUDGETS).toEqual({
      targetNewWordsPerGroup: 5,
      maxPrimaryWithNewGroup: 15,
      normalVisibleTaskBudget: 18,
      reviewOnlyPrimaryBudget: 18,
      hardVisibleTaskCap: 24,
    })
    expect(Object.isFrozen(LESSON_FLOW_BUDGETS)).toBe(true)
  })

  it('sorts urgent due before maintenance with deterministic tie-breaks', () => {
    const candidates: LessonFlowWordState[] = [
      due('maintenance', { stage: 'S5', nextDueLessonNo: 1 }),
      due('later-due', { nextDueLessonNo: 3 }),
      due('lower-wrong', { wrongStreak: 1 }),
      due('higher-mastery', { wrongStreak: 2, masteryScore: 30 }),
      due('seen-later', { wrongStreak: 2, masteryScore: 10, lastSeenLessonNo: 5 }),
      due('source-later', {
        wrongStreak: 2,
        masteryScore: 10,
        lastSeenLessonNo: 4,
        sourceOrderIndex: 7,
      }),
      due('word-b', {
        wrongStreak: 2,
        masteryScore: 10,
        lastSeenLessonNo: 4,
        sourceOrderIndex: 6,
      }),
      due('word-a', {
        wrongStreak: 2,
        masteryScore: 10,
        lastSeenLessonNo: 4,
        sourceOrderIndex: 6,
      }),
      due('never-seen', { wrongStreak: 2, masteryScore: 10 }),
      due('most-overdue', { nextDueLessonNo: 1 }),
    ]

    const plan = planRollingLessonFlow({
      currentLessonNo: 3,
      wordStates: candidates,
      nextGroupWords: [],
    })

    expect(plan.selectedDue.map((candidate) => candidate.wordId)).toEqual([
      'most-overdue',
      'never-seen',
      'word-a',
      'word-b',
      'source-later',
      'seen-later',
      'higher-mastery',
      'lower-wrong',
      'later-due',
      'maintenance',
    ])
    expect(candidates[0]?.wordId).toBe('maintenance')
  })

  it('selects only non-suspended states due by the current lesson', () => {
    const plan = planRollingLessonFlow({
      currentLessonNo: 4,
      wordStates: [
        due('due-now', { nextDueLessonNo: 4 }),
        due('overdue', { nextDueLessonNo: 2 }),
        due('future', { nextDueLessonNo: 5 }),
        due('suspended', { nextDueLessonNo: 1, status: 'suspended' }),
      ],
      nextGroupWords: [],
    })

    expect(plan.selectedDue.map((candidate) => candidate.wordId)).toEqual([
      'overdue',
      'due-now',
    ])
  })

  it('admits a whole five-word group beside ten urgent due tasks and alternates primary tasks', () => {
    const plan = planRollingLessonFlow({
      currentLessonNo: 4,
      wordStates: Array.from({ length: 10 }, (_, index) =>
        due(numberedWordId('due', index), { sourceOrderIndex: index + 1 }),
      ),
      nextGroupWords: Array.from({ length: 5 }, (_, index) =>
        newWord(numberedWordId('new', index), index + 11),
      ),
    })

    expect(plan.lessonKind).toBe('with_new_group')
    expect(plan.shouldActivateNewGroup).toBe(true)
    expect(plan.selectedDue).toHaveLength(10)
    expect(plan.selectedNewWords).toHaveLength(5)
    expect(
      plan.primarySequence.map((selection) =>
        `${selection.kind}:${selection.word.wordId}`,
      ),
    ).toEqual([
      'due:due-1', 'new:new-1',
      'due:due-2', 'new:new-2',
      'due:due-3', 'new:new-3',
      'due:due-4', 'new:new-4',
      'due:due-5', 'new:new-5',
      'due:due-6', 'due:due-7', 'due:due-8', 'due:due-9', 'due:due-10',
    ])
  })

  it('blocks the whole new group when urgent due exceeds its ten review slots', () => {
    const plan = planRollingLessonFlow({
      currentLessonNo: 8,
      wordStates: Array.from({ length: 20 }, (_, index) =>
        due(numberedWordId('urgent', index), { sourceOrderIndex: index + 1 }),
      ),
      nextGroupWords: Array.from({ length: 5 }, (_, index) =>
        newWord(numberedWordId('new', index), index + 21),
      ),
    })

    expect(plan).toMatchObject({
      lessonKind: 'review_only',
      shouldActivateNewGroup: false,
      selectedNewWords: [],
    })
    expect(plan.selectedDue).toHaveLength(18)
    expect(plan.primarySequence).toHaveLength(18)
  })

  it('admits new words despite an S5 backlog and fills the remaining review slot', () => {
    const urgent = Array.from({ length: 9 }, (_, index) =>
      due(numberedWordId('urgent', index), { sourceOrderIndex: index + 1 }),
    )
    const plan = planRollingLessonFlow({
      currentLessonNo: 8,
      wordStates: [
        ...urgent,
        due('maintenance-newer', {
          stage: 'S5',
          nextDueLessonNo: 2,
          sourceOrderIndex: 10,
        }),
        due('maintenance-oldest', {
          stage: 'S5',
          nextDueLessonNo: 1,
          sourceOrderIndex: 11,
        }),
      ],
      nextGroupWords: Array.from({ length: 5 }, (_, index) =>
        newWord(numberedWordId('new', index), index + 12),
      ),
    })

    expect(plan.shouldActivateNewGroup).toBe(true)
    expect(plan.selectedDue.map((state) => state.wordId)).toEqual([
      ...urgent.map((state) => state.wordId),
      'maintenance-oldest',
    ])
  })

  it.each([
    { urgentCount: 12, admitted: true, selectedNewCount: 3 },
    { urgentCount: 13, admitted: false, selectedNewCount: 0 },
  ])(
    'treats a three-word tail group atomically with $urgentCount urgent due',
    ({ urgentCount, admitted, selectedNewCount }) => {
      const plan = planRollingLessonFlow({
        currentLessonNo: 9,
        wordStates: Array.from({ length: urgentCount }, (_, index) =>
          due(numberedWordId('urgent', index), { sourceOrderIndex: index + 1 }),
        ),
        nextGroupWords: [
          newWord('tail-3', 118),
          newWord('tail-1', 116),
          newWord('tail-2', 117),
        ],
      })

      expect(plan.shouldActivateNewGroup).toBe(admitted)
      expect(plan.selectedNewWords.map((word) => word.wordId)).toEqual(
        selectedNewCount === 0 ? [] : ['tail-1', 'tail-2', 'tail-3'],
      )
      expect(plan.primarySequence).toHaveLength(
        urgentCount + selectedNewCount,
      )
    },
  )

  it('allows S5 starvation during sustained urgent overload and admits new words on recovery', () => {
    const nextGroupWords = Array.from({ length: 5 }, (_, index) =>
      newWord(numberedWordId('new', index), index + 30),
    )
    const maintenance = Array.from({ length: 5 }, (_, index) =>
      due(numberedWordId('maintenance', index), {
        stage: 'S5',
        nextDueLessonNo: 1,
        sourceOrderIndex: index + 20,
      }),
    )

    for (let lessonNo = 1; lessonNo <= 4; lessonNo += 1) {
      const plan = planRollingLessonFlow({
        currentLessonNo: lessonNo,
        wordStates: [
          ...Array.from({ length: 18 }, (_, index) =>
            due(numberedWordId('urgent', index), {
              nextDueLessonNo: 1,
              sourceOrderIndex: index + 1,
            }),
          ),
          ...maintenance,
        ],
        nextGroupWords,
      })

      expect(plan.shouldActivateNewGroup).toBe(false)
      expect(plan.selectedDue).toHaveLength(18)
      expect(plan.selectedDue.every((state) => state.stage !== 'S5')).toBe(true)
    }

    const recovered = planRollingLessonFlow({
      currentLessonNo: 5,
      wordStates: [
        ...Array.from({ length: 10 }, (_, index) =>
          due(numberedWordId('urgent', index), {
            nextDueLessonNo: 1,
            sourceOrderIndex: index + 1,
          }),
        ),
        ...maintenance,
      ],
      nextGroupWords,
    })

    expect(recovered.shouldActivateNewGroup).toBe(true)
    expect(recovered.selectedNewWords).toHaveLength(5)
    expect(recovered.selectedDue.every((state) => state.stage !== 'S5')).toBe(true)
  })

  it('keeps the frozen 118-word score-2 model bounded and eventually serves its backlog', () => {
    expect(simulateFixedScoreTwoModel()).toEqual({
      lastGroupActivationLesson: 42,
      firstBacklogClearLessonAfterActivation: 50,
      peakUnservedDueCount: 39,
      maximumS5OverdueAtEntry: 6,
      maximumUnservedUrgentCount: 0,
      maximumPrimaryCount: 18,
    })
  })
})

const due = (
  wordId: string,
  overrides: Partial<LessonFlowWordState> = {},
): LessonFlowWordState => ({
  wordId,
  stage: 'S2',
  nextDueLessonNo: 2,
  wrongStreak: 0,
  masteryScore: 50,
  sourceOrderIndex: 5,
  status: 'learning',
  ...overrides,
})

const newWord = (wordId: string, sourceOrderIndex: number): LessonFlowNewWord => ({
  wordId,
  sourceOrderIndex,
})

const numberedWordId = (prefix: string, zeroBasedIndex: number): string =>
  `${prefix}-${String(zeroBasedIndex + 1)}`

type SimulationState = LessonFlowWordState & {
  currentStreak: number
}

const simulateFixedScoreTwoModel = () => {
  const groups = Array.from({ length: 24 }, (_, groupIndex) =>
    Array.from({ length: groupIndex === 23 ? 3 : 5 }, (_, wordIndex) => {
      const sourceOrderIndex = groupIndex * 5 + wordIndex + 1

      return newWord(`word-${String(sourceOrderIndex)}`, sourceOrderIndex)
    }),
  )
  const states: SimulationState[] = []
  let nextGroupIndex = 0
  let lastGroupActivationLesson = 0
  let firstBacklogClearLessonAfterActivation: number | undefined
  let peakUnservedDueCount = 0
  let maximumS5OverdueAtEntry = 0
  let maximumUnservedUrgentCount = 0
  let maximumPrimaryCount = 0

  for (let lessonNo = 1; lessonNo <= 50; lessonNo += 1) {
    const nextGroupWords = groups[nextGroupIndex] ?? []
    const dueAtEntry = states.filter(
      (state) =>
        state.status !== 'suspended' && state.nextDueLessonNo <= lessonNo,
    )
    const plan = planRollingLessonFlow({
      currentLessonNo: lessonNo,
      wordStates: states,
      nextGroupWords,
    })
    const selectedIds = new Set(plan.selectedDue.map((state) => state.wordId))
    const unservedDue = dueAtEntry.filter((state) => !selectedIds.has(state.wordId))

    peakUnservedDueCount = Math.max(peakUnservedDueCount, unservedDue.length)
    maximumUnservedUrgentCount = Math.max(
      maximumUnservedUrgentCount,
      unservedDue.filter((state) => state.stage !== 'S5').length,
    )
    maximumPrimaryCount = Math.max(maximumPrimaryCount, plan.primarySequence.length)

    for (const state of dueAtEntry) {
      if (state.stage === 'S5') {
        maximumS5OverdueAtEntry = Math.max(
          maximumS5OverdueAtEntry,
          lessonNo - state.nextDueLessonNo,
        )
      }
    }

    const activatedStates = plan.selectedNewWords.map<SimulationState>((word) => ({
      wordId: word.wordId,
      stage: 'S0',
      nextDueLessonNo: lessonNo,
      wrongStreak: 0,
      masteryScore: 0,
      sourceOrderIndex: word.sourceOrderIndex,
      status: 'new',
      currentStreak: 0,
    }))

    if (plan.shouldActivateNewGroup) {
      states.push(...activatedStates)
      nextGroupIndex += 1
      lastGroupActivationLesson = lessonNo
    }

    for (const state of [...plan.selectedDue, ...activatedStates]) {
      applyFixedScoreTwo(state, lessonNo)
    }

    if (
      nextGroupIndex === groups.length &&
      firstBacklogClearLessonAfterActivation === undefined &&
      unservedDue.length === 0
    ) {
      firstBacklogClearLessonAfterActivation = lessonNo
    }
  }

  return {
    lastGroupActivationLesson,
    firstBacklogClearLessonAfterActivation,
    peakUnservedDueCount,
    maximumS5OverdueAtEntry,
    maximumUnservedUrgentCount,
    maximumPrimaryCount,
  }
}

const SCORE_TWO_STAGE_GAPS = {
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 5,
  S5: 8,
} as const

const STAGE_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const

const applyFixedScoreTwo = (state: SimulationState, lessonNo: number): void => {
  const currentStageIndex = STAGE_ORDER.indexOf(state.stage)
  const nextStage =
    STAGE_ORDER[Math.min(currentStageIndex + 1, STAGE_ORDER.length - 1)]

  if (!nextStage || nextStage === 'S0') {
    throw new Error('The score-2 model must advance to S1-S5')
  }

  state.stage = nextStage
  state.currentStreak += 1
  state.wrongStreak = 0
  state.masteryScore = Math.min(
    100,
    STAGE_ORDER.indexOf(nextStage) * 12 + Math.min(state.currentStreak * 3, 15),
  )
  state.lastSeenLessonNo = lessonNo
  state.nextDueLessonNo = lessonNo + SCORE_TWO_STAGE_GAPS[nextStage]
  state.status = nextStage === 'S5' ? 'reviewing' : 'learning'
}
