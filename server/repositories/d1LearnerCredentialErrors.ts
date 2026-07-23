export const isLoginAccountUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error &&
  /UNIQUE constraint failed: learners\.login_account/u.test(error.message)
