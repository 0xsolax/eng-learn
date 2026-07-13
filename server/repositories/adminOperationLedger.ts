import type {
  AdminOperationHash,
  AdminRequestFingerprint,
} from '../security/adminOperationCrypto'

type AdminOperationBase = {
  operationHash: AdminOperationHash
  targetId: string
  requestFingerprint: AdminRequestFingerprint
  createdAt: string
}

export type CreateSourceAdminOperation = AdminOperationBase & {
  kind: 'create_source'
  outcomeSourceId: string
  outcomeSourceVersionId: string
}

export type CreateCourseAdminOperation = AdminOperationBase & {
  kind: 'create_course'
  outcomeLearnerId: string
  outcomeCourseId: string
  outcomeCredentialVersion: number
}

export type RotateAccessCodeAdminOperation = AdminOperationBase & {
  kind: 'rotate_access_code'
  outcomeLearnerId: string
  outcomeCredentialVersion: number
  revokedSessionCount: number
}

export type AdminOperationRecord =
  | CreateSourceAdminOperation
  | CreateCourseAdminOperation
  | RotateAccessCodeAdminOperation

export type AdminOperationLedgerReader = {
  get(operationHash: AdminOperationHash): Promise<AdminOperationRecord | undefined>
}

export type InMemoryAdminOperationLedger = AdminOperationLedgerReader & {
  runExclusive<T>(callback: () => Promise<T>): Promise<T>
  insert(operation: AdminOperationRecord): void
}

type AdminOperationRow = {
  operation_hash: string
  kind: AdminOperationRecord['kind']
  target_id: string
  request_fingerprint: string
  outcome_source_id: string | null
  outcome_source_version_id: string | null
  outcome_learner_id: string | null
  outcome_course_id: string | null
  outcome_credential_version: number | null
  revoked_session_count: number | null
  created_at: string
}

export const createInMemoryAdminOperationLedger = (): InMemoryAdminOperationLedger => {
  const records = new Map<AdminOperationHash, AdminOperationRecord>()
  let pending = Promise.resolve()

  return {
    get(operationHash) {
      return Promise.resolve(records.get(operationHash))
    },

    async runExclusive(callback) {
      const previous = pending
      let release = (): void => undefined
      pending = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous

      try {
        return await callback()
      } finally {
        release()
      }
    },

    insert(operation) {
      if (records.has(operation.operationHash)) {
        throw new Error('Admin operation already exists')
      }

      records.set(operation.operationHash, operation)
    },
  }
}

export const createD1AdminOperationLedger = (
  db: D1Database,
): AdminOperationLedgerReader => ({
  get: (operationHash) => getD1AdminOperation(db, operationHash),
})

export const getD1AdminOperation = async (
  db: D1Database,
  operationHash: AdminOperationHash,
): Promise<AdminOperationRecord | undefined> => {
  const row = await db
    .prepare('SELECT * FROM admin_operations WHERE operation_hash = ?')
    .bind(operationHash)
    .first<AdminOperationRow>()

  return row ? mapAdminOperation(row) : undefined
}

export const createD1AdminOperationInsert = (
  db: D1Database,
  operation: AdminOperationRecord,
): D1PreparedStatement => {
  const values = toOutcomeColumns(operation)

  return db
    .prepare(
      'INSERT INTO admin_operations (operation_hash, kind, target_id, request_fingerprint, outcome_source_id, outcome_source_version_id, outcome_learner_id, outcome_course_id, outcome_credential_version, revoked_session_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      operation.operationHash,
      operation.kind,
      operation.targetId,
      operation.requestFingerprint,
      values.outcomeSourceId,
      values.outcomeSourceVersionId,
      values.outcomeLearnerId,
      values.outcomeCourseId,
      values.outcomeCredentialVersion,
      values.revokedSessionCount,
      operation.createdAt,
    )
}

const mapAdminOperation = (row: AdminOperationRow): AdminOperationRecord => {
  const base: AdminOperationBase = {
    operationHash: row.operation_hash as AdminOperationHash,
    targetId: row.target_id,
    requestFingerprint: row.request_fingerprint as AdminRequestFingerprint,
    createdAt: row.created_at,
  }

  switch (row.kind) {
    case 'create_source':
      if (!row.outcome_source_id || !row.outcome_source_version_id) {
        throw new Error('Stored create-source operation outcome is incomplete')
      }

      return {
        ...base,
        kind: row.kind,
        outcomeSourceId: row.outcome_source_id,
        outcomeSourceVersionId: row.outcome_source_version_id,
      }
    case 'create_course':
      if (
        !row.outcome_learner_id ||
        !row.outcome_course_id ||
        row.outcome_credential_version === null
      ) {
        throw new Error('Stored create-course operation outcome is incomplete')
      }

      return {
        ...base,
        kind: row.kind,
        outcomeLearnerId: row.outcome_learner_id,
        outcomeCourseId: row.outcome_course_id,
        outcomeCredentialVersion: row.outcome_credential_version,
      }
    case 'rotate_access_code':
      if (
        !row.outcome_learner_id ||
        row.outcome_credential_version === null ||
        row.revoked_session_count === null
      ) {
        throw new Error('Stored access-code rotation outcome is incomplete')
      }

      return {
        ...base,
        kind: row.kind,
        outcomeLearnerId: row.outcome_learner_id,
        outcomeCredentialVersion: row.outcome_credential_version,
        revokedSessionCount: row.revoked_session_count,
      }
  }
}

const toOutcomeColumns = (operation: AdminOperationRecord) => {
  switch (operation.kind) {
    case 'create_source':
      return {
        outcomeSourceId: operation.outcomeSourceId,
        outcomeSourceVersionId: operation.outcomeSourceVersionId,
        outcomeLearnerId: null,
        outcomeCourseId: null,
        outcomeCredentialVersion: null,
        revokedSessionCount: null,
      }
    case 'create_course':
      return {
        outcomeSourceId: null,
        outcomeSourceVersionId: null,
        outcomeLearnerId: operation.outcomeLearnerId,
        outcomeCourseId: operation.outcomeCourseId,
        outcomeCredentialVersion: operation.outcomeCredentialVersion,
        revokedSessionCount: null,
      }
    case 'rotate_access_code':
      return {
        outcomeSourceId: null,
        outcomeSourceVersionId: null,
        outcomeLearnerId: operation.outcomeLearnerId,
        outcomeCourseId: null,
        outcomeCredentialVersion: operation.outcomeCredentialVersion,
        revokedSessionCount: operation.revokedSessionCount,
      }
  }
}
