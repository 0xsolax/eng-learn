import { describe, expect, it } from 'vitest'
import {
  hashLearnerPin,
  parseLearnerPinHash,
  verifyLearnerPin,
} from '../../server/security/learnerPinCrypto'

describe('learner PIN crypto', () => {
  it('stores a six-digit PIN as a salted PBKDF2 credential and verifies it', async () => {
    const credential = await hashLearnerPin('123456')

    expect(credential).toMatch(/^pbkdf2-sha256:100000:[0-9a-f]{32}:[0-9a-f]{64}$/)
    expect(credential).not.toContain('123456')
    await expect(verifyLearnerPin('123456', credential)).resolves.toBe(true)
    await expect(verifyLearnerPin('654321', credential)).resolves.toBe(false)
  })

  it('uses an independent random salt for the same PIN', async () => {
    const first = await hashLearnerPin('123456')
    const second = await hashLearnerPin('123456')

    expect(second).not.toBe(first)
    await expect(verifyLearnerPin('123456', second)).resolves.toBe(true)
  })

  it('rejects malformed and legacy fast hashes at the PIN boundary', () => {
    expect(parseLearnerPinHash('sha256:' + 'a'.repeat(64))).toBeUndefined()
    expect(parseLearnerPinHash('pbkdf2-sha256:1:abcd:abcd')).toBeUndefined()
    expect(
      parseLearnerPinHash(`pbkdf2-sha256:600000:${'a'.repeat(32)}:${'b'.repeat(64)}`),
    ).toBeUndefined()
  })
})
