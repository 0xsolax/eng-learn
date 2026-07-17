import { importSourceVersionCommandSchema } from '@shared/api/schemas'
import type { z } from 'zod'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'

export const PENDING_SOURCE_VERSION_IMPORT_KEY =
  'eng-learn:pending-source-version-import:v1'
export const PENDING_SOURCE_VERSION_IMPORT_MAX_CHARS = 512 * 1024

export type PendingSourceVersionImport = z.output<
  typeof importSourceVersionCommandSchema
>

export type RestoredSourceVersionImport =
  | { status: 'empty' }
  | { status: 'invalid' }
  | { status: 'ready'; command: PendingSourceVersionImport }

export const persistPendingSourceVersionImport = (
  command: unknown,
  storage: Storage = window.sessionStorage,
): PendingSourceVersionImport => {
  const parsed = importSourceVersionCommandSchema.parse(command)
  const serialized = JSON.stringify(parsed)

  if (serialized.length > PENDING_SOURCE_VERSION_IMPORT_MAX_CHARS) {
    throw new Error('Pending source-version import is too large')
  }

  storage.setItem(PENDING_SOURCE_VERSION_IMPORT_KEY, serialized)

  return parsed
}

export const restorePendingSourceVersionImport = (
  storage: Storage = window.sessionStorage,
): RestoredSourceVersionImport => {
  let serialized: string | null

  try {
    serialized = storage.getItem(PENDING_SOURCE_VERSION_IMPORT_KEY)
  } catch {
    return { status: 'invalid' }
  }

  if (serialized === null) return { status: 'empty' }

  if (serialized.length > PENDING_SOURCE_VERSION_IMPORT_MAX_CHARS) {
    clearPendingSourceVersionImport(storage)
    return { status: 'invalid' }
  }

  try {
    const parsed = importSourceVersionCommandSchema.safeParse(JSON.parse(serialized))

    if (parsed.success) {
      return { status: 'ready', command: parsed.data }
    }
  } catch {
    // Invalid recovery data is cleared below.
  }

  clearPendingSourceVersionImport(storage)

  return { status: 'invalid' }
}

export const clearPendingSourceVersionImport = (
  storage: Storage = window.sessionStorage,
): void => {
  try {
    storage.removeItem(PENDING_SOURCE_VERSION_IMPORT_KEY)
  } catch {
    // A terminal import result must not be replaced by a storage cleanup error.
  }
}

export const requiresSourceVersionImportConfirmation = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  error instanceof InvalidApiResponseError ||
  (error instanceof ApiFailureError && error.code === 'import_reconcile_required')

const CONFIRMATION_DELAYS_MS = [0, 1_000, 5_000, 15_000, 30_000] as const

export const getSourceVersionImportConfirmationDelay = (attempt: number): number =>
  CONFIRMATION_DELAYS_MS[
    Math.min(Math.max(attempt, 0), CONFIRMATION_DELAYS_MS.length - 1)
  ] ?? 30_000
