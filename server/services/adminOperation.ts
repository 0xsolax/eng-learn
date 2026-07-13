import {
  parseAdminOperationToken,
  type RawAdminOperationToken,
} from '../../shared/security/adminOperationToken'
import type {
  AdminOperationLedgerReader,
  AdminOperationRecord,
} from '../repositories/adminOperationLedger'
import {
  fingerprintAdminOperationRequest,
  hashAdminOperationToken,
  type AdminOperationHash,
  type AdminOperationRequest,
  type AdminRequestFingerprint,
} from '../security/adminOperationCrypto'
import { DomainError } from '../errors/DomainError'

export type PreparedAdminOperation = {
  token: RawAdminOperationToken
  operationHash: AdminOperationHash
  requestFingerprint: AdminRequestFingerprint
}

export const prepareAdminOperation = async (
  operationToken: string,
  request: AdminOperationRequest,
): Promise<PreparedAdminOperation> => {
  const token = parseAdminOperationToken(operationToken)

  if (!token) {
    throw new DomainError('bad_request', 'Admin operation token is invalid')
  }

  const [operationHash, requestFingerprint] = await Promise.all([
    hashAdminOperationToken(token),
    fingerprintAdminOperationRequest(request),
  ])

  return { token, operationHash, requestFingerprint }
}

export const findExactAdminOperation = async (
  ledger: AdminOperationLedgerReader,
  prepared: PreparedAdminOperation,
  expected: {
    kind: AdminOperationRecord['kind']
    targetId: string
  },
): Promise<AdminOperationRecord | undefined> => {
  const existing = await ledger.get(prepared.operationHash)

  if (!existing) return undefined

  if (
    existing.kind !== expected.kind ||
    existing.targetId !== expected.targetId ||
    existing.requestFingerprint !== prepared.requestFingerprint
  ) {
    throw new DomainError(
      'idempotency_conflict',
      'Admin operation token was already used for a different request',
    )
  }

  return existing
}
