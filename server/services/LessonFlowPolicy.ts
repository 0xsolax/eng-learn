import type { WordStage } from '../../shared/domain/content'

export type LessonFlowWordState = {
  wordId: string
  stage: WordStage
  nextDueLessonNo: number
  wrongStreak: number
  masteryScore: number
  lastSeenLessonNo?: number
  sourceOrderIndex: number
  status: 'new' | 'learning' | 'reviewing' | 'mastered' | 'suspended'
}

export type LessonFlowNewWord = {
  wordId: string
  sourceOrderIndex: number
}

export const LESSON_FLOW_BUDGETS = Object.freeze({
  targetNewWordsPerGroup: 5,
  maxPrimaryWithNewGroup: 15,
  normalVisibleTaskBudget: 18,
  reviewOnlyPrimaryBudget: 18,
  hardVisibleTaskCap: 24,
})

export type LessonFlowPrimarySelection<
  TState extends LessonFlowWordState = LessonFlowWordState,
  TNewWord extends LessonFlowNewWord = LessonFlowNewWord,
> =
  | { kind: 'due'; word: TState }
  | { kind: 'new'; word: TNewWord }

export type RollingLessonFlowPlan<
  TState extends LessonFlowWordState = LessonFlowWordState,
  TNewWord extends LessonFlowNewWord = LessonFlowNewWord,
> = {
  lessonKind: 'with_new_group' | 'review_only' | 'empty'
  shouldActivateNewGroup: boolean
  selectedDue: TState[]
  selectedNewWords: TNewWord[]
  primarySequence: Array<LessonFlowPrimarySelection<TState, TNewWord>>
}

export const planRollingLessonFlow = <
  TState extends LessonFlowWordState,
  TNewWord extends LessonFlowNewWord,
>(input: {
  currentLessonNo: number
  wordStates: readonly TState[]
  nextGroupWords: readonly TNewWord[]
}): RollingLessonFlowPlan<TState, TNewWord> => {
  const sortedDue = input.wordStates
    .filter(
      (state) =>
        state.status !== 'suspended' &&
        state.nextDueLessonNo <= input.currentLessonNo,
    )
    .sort(compareDueCandidates)
  const sortedNewWords = [...input.nextGroupWords].sort(compareNewWords)
  const urgentDueCount = sortedDue.filter((state) => state.stage !== 'S5').length
  const reviewSlotsWithNewGroup =
    LESSON_FLOW_BUDGETS.maxPrimaryWithNewGroup - sortedNewWords.length
  const shouldActivateNewGroup =
    sortedNewWords.length > 0 &&
    reviewSlotsWithNewGroup >= 0 &&
    urgentDueCount <= reviewSlotsWithNewGroup
  const selectedDue = sortedDue.slice(
    0,
    shouldActivateNewGroup
      ? reviewSlotsWithNewGroup
      : LESSON_FLOW_BUDGETS.reviewOnlyPrimaryBudget,
  )
  const selectedNewWords = shouldActivateNewGroup ? sortedNewWords : []

  return {
    lessonKind: shouldActivateNewGroup
      ? 'with_new_group'
      : selectedDue.length > 0
        ? 'review_only'
        : 'empty',
    shouldActivateNewGroup,
    selectedDue,
    selectedNewWords,
    primarySequence: alternatePrimarySelections(selectedDue, selectedNewWords),
  }
}

const compareDueCandidates = (
  left: LessonFlowWordState,
  right: LessonFlowWordState,
): number =>
  duePriority(left) - duePriority(right) ||
  left.nextDueLessonNo - right.nextDueLessonNo ||
  right.wrongStreak - left.wrongStreak ||
  left.masteryScore - right.masteryScore ||
  compareOptionalLessonNo(left.lastSeenLessonNo, right.lastSeenLessonNo) ||
  left.sourceOrderIndex - right.sourceOrderIndex ||
  compareText(left.wordId, right.wordId)

const duePriority = (state: LessonFlowWordState): number =>
  state.stage === 'S5' ? 1 : 0

const compareNewWords = (
  left: LessonFlowNewWord,
  right: LessonFlowNewWord,
): number =>
  left.sourceOrderIndex - right.sourceOrderIndex ||
  compareText(left.wordId, right.wordId)

const alternatePrimarySelections = <
  TState extends LessonFlowWordState,
  TNewWord extends LessonFlowNewWord,
>(
  due: readonly TState[],
  newWords: readonly TNewWord[],
): Array<LessonFlowPrimarySelection<TState, TNewWord>> => {
  const selections: Array<LessonFlowPrimarySelection<TState, TNewWord>> = []
  const length = Math.max(due.length, newWords.length)

  for (let index = 0; index < length; index += 1) {
    const dueWord = due[index]
    const newWord = newWords[index]

    if (dueWord) selections.push({ kind: 'due', word: dueWord })
    if (newWord) selections.push({ kind: 'new', word: newWord })
  }

  return selections
}

const compareOptionalLessonNo = (
  left: number | undefined,
  right: number | undefined,
): number => {
  if (left === undefined) return right === undefined ? 0 : -1
  if (right === undefined) return 1
  return left - right
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
