export type LearnerLoginAttemptReservation =
  | {
      status: 'reserved'
      attemptNumber: number
      blockedUntil?: string
    }
  | {
      status: 'blocked'
      blockedUntil: string
    }

export type LearnerLoginAttemptRepository = {
  reserveAttempt(input: {
    keyHash: string
    now: string
    resetBefore: string
    blockedUntil: string
    maximumAttempts: number
  }): Promise<LearnerLoginAttemptReservation>
  clear(keyHash: string): Promise<void>
}
