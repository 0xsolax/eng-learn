import type {
  AdminOperationKind,
  RawAdminOperationToken,
} from '../../shared/security/adminOperationToken'
import type { ImportWordInput } from '../../shared/domain/content'
import {
  parseRawAccessCode,
  type RawAccessCode,
} from './credentialCrypto'

const HASH_PREFIX = 'sha256:'
const OPERATION_HASH_DOMAIN = 'eng-learn:admin-operation-token:v1'
const ACCESS_CODE_DOMAIN = 'eng-learn:admin-operation-access-code:v1'
const REQUEST_FINGERPRINT_DOMAIN = 'eng-learn:admin-operation-request:v1'
const SOURCE_VERSION_IMPORT_FINGERPRINT_DOMAIN =
  'eng-learn:admin-operation-source-version-import:v2'

export const ADMIN_ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

type HashBrand<Name extends string> = string & {
  readonly __hashBrand: Name
}

export type AdminOperationHash = HashBrand<'admin-operation-hash'>
export type AdminRequestFingerprint = HashBrand<'admin-request-fingerprint'>

export type AdminOperationRequest =
  | {
      kind: 'create_course'
      learnerName: string
      sourceVersionId: string
    }
  | {
      kind: 'create_source'
      sourceName: string
      words: Array<{
        word: string
        meaning: string
        exampleSentence: string
        partOfSpeech?: string
      }>
    }
  | {
      kind: 'rotate_access_code'
      learnerId: string
      expectedCredentialVersion: number
    }
  | {
      kind: 'reset_course_progress'
      courseId: string
      expectedLearningRunNo: number
      expectedCurrentLessonNo: number
    }

export type SourceVersionImportOperationRequest = {
  mode: 'new_source' | 'next_version'
  targetId: string
  sourceName?: string
  words: ImportWordInput[]
}

export const hashAdminOperationToken = async (
  token: RawAdminOperationToken,
): Promise<AdminOperationHash> =>
  (await hashText(`${OPERATION_HASH_DOMAIN}\0${token}`)) as AdminOperationHash

export const fingerprintAdminOperationRequest = async (
  input: AdminOperationRequest,
): Promise<AdminRequestFingerprint> => {
  const targetId = operationTargetId(input)
  const payload = operationPayload(input)

  return (await hashText(
    `${REQUEST_FINGERPRINT_DOMAIN}\0${input.kind}\0${targetId}\0${payload}`,
  )) as AdminRequestFingerprint
}

export const fingerprintSourceVersionImportRequest = async (
  input: SourceVersionImportOperationRequest,
): Promise<AdminRequestFingerprint> => {
  const payload = [
    lengthPrefixed(input.mode),
    lengthPrefixed(input.sourceName ?? ''),
    ...input.words.flatMap(serializeSourceVersionImportWord),
  ].join('\0')

  return (await hashText(
    `${SOURCE_VERSION_IMPORT_FINGERPRINT_DOMAIN}\0${input.targetId}\0${payload}`,
  )) as AdminRequestFingerprint
}

export const deriveAdminOperationAccessCode = async (
  kind: Extract<AdminOperationKind, 'create_course' | 'rotate_access_code'>,
  token: RawAdminOperationToken,
): Promise<RawAccessCode> => {
  const digest = await digestText(`${ACCESS_CODE_DOMAIN}\0${kind}\0${token}`)
  let buffer = 0
  let bufferedBits = 0
  let byteIndex = 0
  let accessCode = ''

  while (accessCode.length < 10) {
    while (bufferedBits < 5) {
      buffer = buffer * 256 + (digest[byteIndex] ?? 0)
      bufferedBits += 8
      byteIndex += 1
    }

    bufferedBits -= 5
    accessCode += ADMIN_ACCESS_CODE_ALPHABET.charAt((buffer >> bufferedBits) & 31)
    buffer &= (1 << bufferedBits) - 1
  }

  const parsed = parseRawAccessCode(accessCode)

  if (!parsed) throw new Error('Derived admin operation access code is invalid')

  return parsed
}

const operationTargetId = (input: AdminOperationRequest): string => {
  switch (input.kind) {
    case 'create_course':
      return input.sourceVersionId
    case 'create_source':
      return 'new-source'
    case 'rotate_access_code':
      return input.learnerId
    case 'reset_course_progress':
      return input.courseId
  }
}

const operationPayload = (input: AdminOperationRequest): string => {
  switch (input.kind) {
    case 'create_course':
      return `${lengthPrefixed(input.learnerName)}\0${lengthPrefixed(input.sourceVersionId)}`
    case 'create_source':
      return [
        lengthPrefixed(input.sourceName),
        ...input.words.flatMap((word) => [
          lengthPrefixed(word.word),
          lengthPrefixed(word.meaning),
          lengthPrefixed(word.exampleSentence),
          lengthPrefixed(word.partOfSpeech ?? ''),
        ]),
      ].join('\0')
    case 'rotate_access_code':
      return `${lengthPrefixed(input.learnerId)}\0${String(input.expectedCredentialVersion)}`
    case 'reset_course_progress':
      return `${lengthPrefixed(input.courseId)}\0${String(input.expectedLearningRunNo)}\0${String(input.expectedCurrentLessonNo)}`
  }
}

const lengthPrefixed = (value: string): string => `${String(value.length)}:${value}`

const serializeSourceVersionImportWord = (word: ImportWordInput): string[] =>
  Object.values({
    word: lengthPrefixed(word.word),
    meaning: lengthPrefixed(word.meaning),
    examplePhrase: lengthPrefixed(word.examplePhrase),
    exampleSentence: lengthPrefixed(word.exampleSentence),
    exampleSentenceExtended: lengthPrefixed(word.exampleSentenceExtended),
    partOfSpeech: lengthPrefixed(word.partOfSpeech ?? ''),
  } satisfies Record<keyof ImportWordInput, string>)

const hashText = async (value: string): Promise<string> => {
  const digest = await digestText(value)
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${HASH_PREFIX}${hex}`
}

const digestText = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
