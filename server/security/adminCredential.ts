import { z } from 'zod'

export const ADMIN_PASSWORD_ITERATIONS = 600_000
export const ADMIN_PASSWORD_ALGORITHM = 'PBKDF2-HMAC-SHA256' as const
const NON_VISIBLE_CHARACTER_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._+@-]+$/)
  .transform((username) => username.toLocaleLowerCase('en-US'))

const base64UrlBytes = (byteLength: number) =>
  z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
    try {
      return decodeBase64Url(value).byteLength === byteLength
    } catch {
      return false
    }
  })

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !NON_VISIBLE_CHARACTER_PATTERN.test(value), {
    message: 'Admin display name must contain only visible characters',
  })
  .refine((value) => Array.from(value).length <= 64, {
    message: 'Admin display name must contain at most 64 Unicode code points',
  })

const adminAuthConfigSchema = z
  .object({
    version: z.literal(1),
    username: usernameSchema,
    displayName: displayNameSchema,
    credentialId: z.uuid(),
    algorithm: z.literal(ADMIN_PASSWORD_ALGORITHM),
    iterations: z.literal(ADMIN_PASSWORD_ITERATIONS),
    salt: base64UrlBytes(16),
    verifier: base64UrlBytes(32),
    rateLimitKey: base64UrlBytes(32),
  })
  .strict()

export type AdminAuthConfig = z.infer<typeof adminAuthConfigSchema>

export const createAdminAuthConfig = async (input: {
  username: string
  displayName: string
  password: string
}): Promise<AdminAuthConfig> => {
  const username = usernameSchema.parse(input.username)
  const displayName = displayNameSchema.parse(input.displayName)
  assertStrongAdminPassword(input.password, username, displayName)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const verifier = await derivePassword(input.password, salt, ADMIN_PASSWORD_ITERATIONS)

  return {
    version: 1,
    username,
    displayName,
    credentialId: crypto.randomUUID(),
    algorithm: ADMIN_PASSWORD_ALGORITHM,
    iterations: ADMIN_PASSWORD_ITERATIONS,
    salt: encodeBase64Url(salt),
    verifier: encodeBase64Url(verifier),
    rateLimitKey: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  }
}

export const encodeAdminAuthConfig = (input: AdminAuthConfig): string => {
  const config = adminAuthConfigSchema.parse(input)
  const canonicalJson = canonicalAdminAuthConfigJson(config)
  return `v1.${encodeBase64Url(new TextEncoder().encode(canonicalJson))}`
}

export const parseAdminAuthConfig = (encoded: string): AdminAuthConfig => {
  if (!encoded.startsWith('v1.')) {
    throw new Error('Unsupported admin authentication configuration version')
  }

  const payload = encoded.slice(3)
  const decodedBytes = decodeBase64Url(payload)
  let decodedJson: string
  try {
    decodedJson = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes)
  } catch {
    throw new Error('Admin authentication configuration is not valid UTF-8')
  }

  let candidate: unknown
  try {
    candidate = JSON.parse(decodedJson)
  } catch {
    throw new Error('Admin authentication configuration is not valid JSON')
  }

  const config = adminAuthConfigSchema.parse(candidate)
  if (canonicalAdminAuthConfigJson(config) !== decodedJson) {
    throw new Error('Admin authentication configuration is not canonical')
  }

  return config
}

export const verifyAdminCredential = async (
  config: AdminAuthConfig,
  candidateUsername: string,
  candidatePassword: string,
): Promise<boolean> => {
  const validatedConfig = adminAuthConfigSchema.parse(config)
  const normalizedCandidate = candidateUsername.trim().toLocaleLowerCase('en-US')
  const [candidateUsernameDigest, expectedUsernameDigest, candidateVerifier] =
    await Promise.all([
      sha256(new TextEncoder().encode(normalizedCandidate)),
      sha256(new TextEncoder().encode(validatedConfig.username)),
      derivePassword(
        candidatePassword,
        decodeBase64Url(validatedConfig.salt),
        validatedConfig.iterations,
      ),
    ])

  const usernameMatches = constantTimeBytesEqual(
    candidateUsernameDigest,
    expectedUsernameDigest,
  )
  const passwordMatches = constantTimeBytesEqual(
    candidateVerifier,
    decodeBase64Url(validatedConfig.verifier),
  )
  return usernameMatches && passwordMatches
}

export const assertStrongAdminPassword = (
  password: string,
  username: string,
  displayName: string,
): void => {
  const codePointLength = Array.from(password).length
  if (codePointLength < 15 || codePointLength > 128) {
    throw new Error('Admin password must contain 15 to 128 Unicode code points')
  }

  const normalizedPassword = password.toLocaleLowerCase('en-US')
  const blockedValues = new Set([
    username.toLocaleLowerCase('en-US'),
    displayName.toLocaleLowerCase('en-US'),
    'eng-learn',
    'eng learn',
    'password',
    'password123456',
    'admin123456789',
    '123456789012345',
    'qwertyuiopasdfg',
  ])
  if (blockedValues.has(normalizedPassword)) {
    throw new Error('Admin password is not allowed')
  }
}

const canonicalAdminAuthConfigJson = (config: AdminAuthConfig): string =>
  JSON.stringify({
    version: config.version,
    username: config.username,
    displayName: config.displayName,
    credentialId: config.credentialId,
    algorithm: config.algorithm,
    iterations: config.iterations,
    salt: config.salt,
    verifier: config.verifier,
    rateLimitKey: config.rateLimitKey,
  })

const derivePassword = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      iterations,
    },
    passwordKey,
    256,
  )
  return new Uint8Array(derived)
}

const sha256 = async (value: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(value),
    ),
  )

const constantTimeBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(
      first: ArrayBuffer | ArrayBufferView,
      second: ArrayBuffer | ArrayBufferView,
    ): boolean
  }
  return subtle.timingSafeEqual(left, right)
}

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

const encodeBase64Url = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Invalid base64url value')
  }
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(
    (4 - (value.length % 4)) % 4,
  )}`
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== value) {
    throw new Error('Non-canonical base64url value')
  }
  return bytes
}
