const PIN_PATTERN = /^\d{6}$/
const HASH_PATTERN = /^pbkdf2-sha256:(\d+):([0-9a-f]{32}):([0-9a-f]{64})$/
const DEFAULT_ITERATIONS = 100_000
const MINIMUM_ITERATIONS = 100_000
const MAXIMUM_ITERATIONS = 100_000

type CredentialBrand<Name extends string> = string & {
  readonly __credentialBrand: Name
}

export type LearnerPinHash = CredentialBrand<'learner-pin-hash'>

type ParsedLearnerPinHash = {
  iterations: number
  salt: Uint8Array
  derived: Uint8Array
}

export const parseLearnerPinHash = (value: string): LearnerPinHash | undefined =>
  parseCredential(value) ? (value as LearnerPinHash) : undefined

export const hashLearnerPin = async (pin: string): Promise<LearnerPinHash> => {
  if (!PIN_PATTERN.test(pin)) {
    throw new Error('Learner PIN must contain exactly six digits')
  }

  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const derived = await derivePin(pin, salt, DEFAULT_ITERATIONS)

  return `pbkdf2-sha256:${String(DEFAULT_ITERATIONS)}:${toHex(salt)}:${toHex(derived)}` as LearnerPinHash
}

export const verifyLearnerPin = async (
  pin: string,
  credential: LearnerPinHash,
): Promise<boolean> => {
  if (!PIN_PATTERN.test(pin)) return false

  const parsed = parseCredential(credential)

  if (!parsed) return false

  const candidate = await derivePin(pin, parsed.salt, parsed.iterations)

  return fixedTimeEqual(candidate, parsed.derived)
}

const parseCredential = (value: string): ParsedLearnerPinHash | undefined => {
  const match = HASH_PATTERN.exec(value)

  if (!match) return undefined

  const [, rawIterations, rawSalt, rawDerived] = match

  if (!rawIterations || !rawSalt || !rawDerived) return undefined

  const iterations = Number(rawIterations)

  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MINIMUM_ITERATIONS ||
    iterations > MAXIMUM_ITERATIONS
  ) {
    return undefined
  }

  return {
    iterations,
    salt: fromHex(rawSalt),
    derived: fromHex(rawDerived),
  }
}

const derivePin = async (
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    key,
    256,
  )

  return new Uint8Array(derived)
}

const fixedTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false

  let difference = 0

  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return difference === 0
}

const toHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16))

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
