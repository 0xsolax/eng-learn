import { parseSessionTokenHash } from '../security/credentialCrypto'
import type { LearnerSessionLookup, SessionRepository } from './sessionRepository'

type LearnerSessionRow = {
  id: string
  token_hash: string
  learner_id: string
  course_id: string
  created_at: string
  expires_at: string
  credential_version: number
  current_credential_version: number
  revoked_at: string | null
}

export const createD1SessionRepository = (db: D1Database): SessionRepository => ({
  async create(session) {
    const result = await db
      .prepare(
        "INSERT INTO learner_sessions (id, token_hash, learner_id, course_id, created_at, expires_at, revoked_at, credential_version) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM learners INNER JOIN courses ON courses.id = ? AND courses.learner_id = learners.id WHERE learners.id = ? AND learners.credential_version = ? AND courses.status = 'active')",
      )
      .bind(
        session.id,
        session.tokenHash,
        session.learnerId,
        session.courseId,
        session.createdAt,
        session.expiresAt,
        session.revokedAt ?? null,
        session.credentialVersion,
        session.courseId,
        session.learnerId,
        session.credentialVersion,
      )
      .run()

    return result.meta.changes > 0 ? session : undefined
  },

  async getByTokenHash(tokenHash) {
    const row = await db
      .prepare(
        'SELECT learner_sessions.*, learners.credential_version AS current_credential_version FROM learner_sessions INNER JOIN learners ON learners.id = learner_sessions.learner_id WHERE learner_sessions.token_hash = ?',
      )
      .bind(tokenHash)
      .first<LearnerSessionRow>()

    return row ? mapLearnerSession(row) : undefined
  },

  async revokeById(sessionId, revokedAt) {
    const existing = await db
      .prepare('SELECT * FROM learner_sessions WHERE id = ?')
      .bind(sessionId)
      .first<LearnerSessionRow>()

    if (!existing) {
      return false
    }

    if (!existing.revoked_at) {
      await db
        .prepare('UPDATE learner_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(revokedAt, sessionId)
        .run()
    }

    return true
  },

  async revokeAllForLearner(learnerId, revokedAt) {
    const result = await db
      .prepare(
        'UPDATE learner_sessions SET revoked_at = ? WHERE learner_id = ? AND revoked_at IS NULL',
      )
      .bind(revokedAt, learnerId)
      .run()

    return result.meta.changes
  },

  async rotateLearnerCredential(input) {
    const [learnerUpdate, sessionUpdate] = await db.batch([
      db
        .prepare(
          'UPDATE learners SET access_code = ?, credential_version = credential_version + 1 WHERE id = ?',
        )
        .bind(input.accessCodeHash, input.learnerId),
      db
        .prepare(
          'UPDATE learner_sessions SET revoked_at = ? WHERE learner_id = ? AND revoked_at IS NULL',
        )
        .bind(input.revokedAt, input.learnerId),
    ])

    return learnerUpdate?.meta.changes === 1 ? (sessionUpdate?.meta.changes ?? 0) : undefined
  },

  async rotateLearnerCredentialIdempotently(input) {
    const operation = input.adminOperation
    const [operationInsert, sessionUpdate, learnerUpdate] = await db.batch([
      db
        .prepare(
          "INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) SELECT ?, 'rotate_access_code', ?, ?, NULL, NULL, learners.id, NULL, ?, (SELECT COUNT(*) FROM learner_sessions WHERE learner_id = learners.id AND revoked_at IS NULL), ? FROM learners WHERE learners.id = ? AND learners.credential_version = ?",
        )
        .bind(
          operation.operationHash,
          operation.targetId,
          operation.requestFingerprint,
          operation.outcomeCredentialVersion,
          operation.createdAt,
          input.learnerId,
          input.expectedCredentialVersion,
        ),
      db
        .prepare(
          'UPDATE learner_sessions SET revoked_at = ? WHERE learner_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM learners WHERE id = ? AND credential_version = ?) AND EXISTS (SELECT 1 FROM admin_operations WHERE operation_hash = ? AND kind = ? AND request_fingerprint = ? AND outcome_learner_id = ? AND outcome_credential_version = ?)',
        )
        .bind(
          input.revokedAt,
          input.learnerId,
          input.learnerId,
          input.expectedCredentialVersion,
          operation.operationHash,
          operation.kind,
          operation.requestFingerprint,
          input.learnerId,
          operation.outcomeCredentialVersion,
        ),
      db
        .prepare(
          'UPDATE learners SET access_code = ?, credential_version = ? WHERE id = ? AND credential_version = ? AND EXISTS (SELECT 1 FROM admin_operations WHERE operation_hash = ? AND kind = ? AND request_fingerprint = ? AND outcome_learner_id = ? AND outcome_credential_version = ?)',
        )
        .bind(
          input.accessCodeHash,
          operation.outcomeCredentialVersion,
          input.learnerId,
          input.expectedCredentialVersion,
          operation.operationHash,
          operation.kind,
          operation.requestFingerprint,
          input.learnerId,
          operation.outcomeCredentialVersion,
        ),
    ])

    if (operationInsert?.meta.changes !== 1 || learnerUpdate?.meta.changes !== 1) {
      return undefined
    }

    return {
      credentialVersion: operation.outcomeCredentialVersion,
      revokedSessionCount: sessionUpdate?.meta.changes ?? 0,
    }
  },
})

const mapLearnerSession = (row: LearnerSessionRow): LearnerSessionLookup => {
  const tokenHash = parseSessionTokenHash(row.token_hash)

  if (!tokenHash) {
    throw new Error('Stored learner session token hash is invalid')
  }

  return {
    id: row.id,
    tokenHash,
    learnerId: row.learner_id,
    courseId: row.course_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    credentialVersion: row.credential_version,
    currentCredentialVersion: row.current_credential_version,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  }
}
