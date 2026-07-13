import { describe, expect, it } from 'vitest'
import {
  generateAccessCode,
  generateOpaqueToken,
  hashAccessCode,
  hashSessionToken,
  parseRawAccessCode,
  parseRawSessionToken,
} from '../../server/security/credentialCrypto'

describe('credential crypto', () => {
  it('brands only normalized ten-character access codes from the approved alphabet', () => {
    expect(parseRawAccessCode(' abcdefgh23 ')).toBe('ABCDEFGH23')
    expect(parseRawAccessCode('ABCDEFIO23')).toBeUndefined()
    expect(parseRawAccessCode('SHORT23')).toBeUndefined()
  })

  it('brands only canonical 256-bit session tokens', () => {
    expect(parseRawSessionToken('a'.repeat(64))).toBe('a'.repeat(64))
    expect(parseRawSessionToken('A'.repeat(64))).toBeUndefined()
    expect(parseRawSessionToken('short-token')).toBeUndefined()
  })

  it('normalizes and hashes an access code without retaining the raw credential', async () => {
    const accessCode = parseRawAccessCode(' abcdefgh23 ')

    if (!accessCode) {
      throw new Error('Test access code is invalid')
    }

    await expect(hashAccessCode(accessCode)).resolves.toBe(
      'sha256:17190666e16f8d07ca35531be8ac05a695b08ec80bc1ef7303ebf76bba91be49',
    )
  })

  it('hashes an opaque session token with the same non-reversible storage format', async () => {
    const token = parseRawSessionToken('a'.repeat(64))

    if (!token) {
      throw new Error('Test session token is invalid')
    }

    await expect(hashSessionToken(token)).resolves.toBe(
      'sha256:ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
  })

  it('generates independent 256-bit opaque tokens safe for cookie transport', () => {
    const first = generateOpaqueToken()
    const second = generateOpaqueToken()

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
  })

  it('generates a ten-character access code from the unambiguous alphabet', () => {
    expect(generateAccessCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
  })
})
