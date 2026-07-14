export type AdminSessionRecord = {
  id: string
  tokenHash: string
  credentialId: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
}

export type AdminSessionRepository = {
  create(session: AdminSessionRecord): Promise<AdminSessionRecord>
  getByTokenHash(tokenHash: string): Promise<AdminSessionRecord | undefined>
  revokeById(sessionId: string, revokedAt: string): Promise<boolean>
}

export type AdminLoginReservation =
  | {
      status: 'reserved'
      attemptNumber: number
      blockedUntil?: string
    }
  | {
      status: 'blocked'
      blockedUntil: string
    }

export type AdminLoginRateLimitRepository = {
  reserveAttempt(input: {
    keyHash: string
    now: string
    resetBefore: string
    blockedUntil: string
    maximumAttempts: number
  }): Promise<AdminLoginReservation>
  clear(keyHash: string): Promise<void>
}
