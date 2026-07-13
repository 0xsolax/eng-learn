const HASH_PREFIX = 'sha256:'
const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ACCESS_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

type CredentialBrand<Name extends string> = string & {
  readonly __credentialBrand: Name
}

export type RawAccessCode = CredentialBrand<'raw-access-code'>
export type AccessCodeHash = CredentialBrand<'access-code-hash'>
export type RawSessionToken = CredentialBrand<'raw-session-token'>
export type SessionTokenHash = CredentialBrand<'session-token-hash'>

export const normalizeAccessCode = (accessCode: string): string => accessCode.trim().toUpperCase()

export const parseRawAccessCode = (accessCode: string): RawAccessCode | undefined => {
  const normalized = normalizeAccessCode(accessCode)

  return ACCESS_CODE_PATTERN.test(normalized) ? (normalized as RawAccessCode) : undefined
}

export const parseRawSessionToken = (token: string): RawSessionToken | undefined =>
  SESSION_TOKEN_PATTERN.test(token) ? (token as RawSessionToken) : undefined

export const parseAccessCodeHash = (value: string): AccessCodeHash | undefined =>
  HASH_PATTERN.test(value) ? (value as AccessCodeHash) : undefined

export const parseSessionTokenHash = (value: string): SessionTokenHash | undefined =>
  HASH_PATTERN.test(value) ? (value as SessionTokenHash) : undefined

export const hashAccessCode = async (accessCode: RawAccessCode): Promise<AccessCodeHash> =>
  (await hashCredential(accessCode)) as AccessCodeHash

export const hashSessionToken = async (token: RawSessionToken): Promise<SessionTokenHash> =>
  (await hashCredential(token)) as SessionTokenHash

export const generateOpaqueToken = (): RawSessionToken => {
  const values = new Uint8Array(32)
  crypto.getRandomValues(values)

  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('') as RawSessionToken
}

export const generateAccessCode = (): RawAccessCode => {
  const values = new Uint8Array(10)
  crypto.getRandomValues(values)

  return Array.from(values, (value) =>
    ACCESS_CODE_ALPHABET.charAt(value % ACCESS_CODE_ALPHABET.length),
  ).join('') as RawAccessCode
}

const hashCredential = async (credential: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')

  return `${HASH_PREFIX}${hex}`
}
