import {
  isPassingReviewScore,
  type ReviewScore,
} from '../../shared/domain/course'
import type {
  ExerciseItemContent,
  SubmitTaskAnswerRequest,
  TaskAnswerFeedback,
} from '../../shared/api/taskSchemas'
import { canonicalizeLearningText } from '../../shared/api/taskContentSafety'
import { DomainError } from '../errors/DomainError'

export type TaskEvaluation = {
  score: ReviewScore
  logCorrectAnswer: string
  feedback: TaskAnswerFeedback
}

export const evaluateTaskSubmission = (
  content: ExerciseItemContent,
  submission: SubmitTaskAnswerRequest,
): TaskEvaluation => {
  if (content.taskType !== submission.taskType) {
    return mismatchedSubmission()
  }

  switch (content.taskType) {
    case 'recognize_meaning': {
      if (submission.taskType !== 'recognize_meaning') return mismatchedSubmission()

      return {
        score: submission.response === 'known' ? 2 : 0,
        logCorrectAnswer: content.answer.expectedResponse,
        feedback: createTaskFeedback(
          content,
          submission.response === 'known' ? 2 : 0,
        ),
      }
    }
    case 'recall_word':
    case 'multiple_choice':
    case 'fill_blank': {
      if (
        submission.taskType !== 'recall_word' &&
        submission.taskType !== 'multiple_choice' &&
        submission.taskType !== 'fill_blank'
      ) {
        return mismatchedSubmission()
      }

      const correctAnswer = content.answer.word

      return {
        score:
          canonicalizeLearningText(submission.answer) ===
          canonicalizeLearningText(correctAnswer)
            ? 2
            : 0,
        logCorrectAnswer: correctAnswer,
        feedback: createTaskFeedback(
          content,
          canonicalizeLearningText(submission.answer) ===
            canonicalizeLearningText(correctAnswer)
            ? 2
            : 0,
        ),
      }
    }
    case 'sentence_build': {
      if (submission.taskType !== 'sentence_build') return mismatchedSubmission()

      const correctPieceIds = content.answer.pieceIds

      return {
        score: arraysEqual(submission.pieceIds, correctPieceIds) ? 2 : 0,
        logCorrectAnswer: JSON.stringify(correctPieceIds),
        feedback: createTaskFeedback(
          content,
          arraysEqual(submission.pieceIds, correctPieceIds) ? 2 : 0,
        ),
      }
    }
    case 'sentence_output': {
      if (submission.taskType !== 'sentence_output') return mismatchedSubmission()
      const selfScore = toReviewScore(submission.selfScore)

      return {
        score: selfScore,
        logCorrectAnswer: content.answer.referenceSentence,
        feedback: createTaskFeedback(content, selfScore),
      }
    }
  }
}

export const createTaskFeedback = (
  content: ExerciseItemContent,
  score: ReviewScore,
): TaskAnswerFeedback => {
  switch (content.taskType) {
    case 'recognize_meaning':
      return {
        taskType: content.taskType,
        response: isPassingReviewScore(score) ? 'known' : 'learning',
      }
    case 'recall_word':
    case 'multiple_choice':
    case 'fill_blank':
      return {
        taskType: content.taskType,
        correctAnswer: content.answer.word,
      }
    case 'sentence_build':
      return {
        taskType: content.taskType,
        correctPieceIds: content.answer.pieceIds,
        referenceSentence: content.answer.referenceSentence,
      }
    case 'sentence_output':
      return {
        taskType: content.taskType,
        referenceSentence: content.answer.referenceSentence,
        selfScore: toReviewScore(score),
      }
  }
}

const arraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const toReviewScore = (value: number): ReviewScore => {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value

  throw new Error('Review score must be between zero and three')
}

const mismatchedSubmission = (): never => {
  throw new DomainError(
    'task_type_mismatch',
    'Task submission type does not match the task snapshot',
  )
}
