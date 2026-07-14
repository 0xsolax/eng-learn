import { ApiFailureError, InvalidApiResponseError } from './errors'

export const isLearnerSessionAccessError = (
  error: unknown,
): error is ApiFailureError | InvalidApiResponseError =>
  (error instanceof ApiFailureError && error.status === 401) ||
  (error instanceof InvalidApiResponseError && error.status === 401)
