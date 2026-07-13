import { ApiFailureError } from './errors'

export const isLearnerSessionAccessError = (
  error: unknown,
): error is ApiFailureError =>
  error instanceof ApiFailureError &&
  (error.code === 'learner_session_required' ||
    error.code === 'learner_session_expired' ||
    error.code === 'learner_session_revoked')
