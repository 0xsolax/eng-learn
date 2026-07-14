import { describe, expect, it, vi } from 'vitest'
import {
  createAdminAuthConfig,
  encodeAdminAuthConfig,
  parseAdminAuthConfig,
  verifyAdminCredential,
} from '../../server/security/adminCredential'

const LEGACY_V1_CONFIG =
  'v1.eyJ2ZXJzaW9uIjoxLCJ1c2VybmFtZSI6ImxlZ2FjeS5hZG1pbiIsImRpc3BsYXlOYW1lIjoiTGVnYWN5IEFkbWluIiwiY3JlZGVudGlhbElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiYWxnb3JpdGhtIjoiUEJLREYyLUhNQUMtU0hBMjU2IiwiaXRlcmF0aW9ucyI6NjAwMDAwLCJzYWx0IjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsInZlcmlmaWVyIjoiOGF6QnNFOEFpUWdBa051R2hNVnNLcXZxZFJHcHMxc2FzbW9RbjlmbFk0NCIsInJhdGVMaW1pdEtleSI6IkJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVEifQ'

const encodeCandidate = (version: 1 | 2 | 3, candidate: unknown): string =>
  `v${String(version)}.${Buffer.from(JSON.stringify(candidate), 'utf8').toString('base64url')}`

describe('admin credential configuration', () => {
  it('accepts a 10-code-point administrator password', async () => {
    await expect(
      createAdminAuthConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: 'ten-chars!',
      }),
    ).resolves.toMatchObject({ username: 'admin', displayName: 'Solazhu' })
  })

  it('rejects a 9-code-point administrator password', async () => {
    await expect(
      createAdminAuthConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: 'nine-char',
      }),
    ).rejects.toThrow('Admin password must contain 10 to 128 Unicode code points')
  })

  it('round-trips only the canonical versioned configuration', async () => {
    const generated = await createAdminAuthConfig({
      username: 'Admin.Example',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const encoded = encodeAdminAuthConfig(generated)

    expect(generated).toMatchObject({ version: 2, iterations: 100_000 })
    expect(encoded).toMatch(/^v2\.[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain('correct horse battery staple')
    expect(parseAdminAuthConfig(encoded)).toEqual(generated)
  })

  it('preserves and verifies the exact legacy v1 and 600000-iteration meaning', async () => {
    const legacy = parseAdminAuthConfig(LEGACY_V1_CONFIG)

    expect(legacy).toEqual({
      version: 1,
      username: 'legacy.admin',
      displayName: 'Legacy Admin',
      credentialId: '00000000-0000-4000-8000-000000000001',
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: 600_000,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      verifier: '8azBsE8AiQgAkNuGhMVsKqvqdRGps1sasmoQn9flY44',
      rateLimitKey: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
    })
    await expect(
      verifyAdminCredential(legacy, 'legacy.admin', 'compatibility password 2026'),
    ).resolves.toBe(true)
  })

  it('accepts only matching prefix, JSON version, and iteration tuples', async () => {
    const generated = await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const canonical = encodeAdminAuthConfig(generated)
    const legacy = parseAdminAuthConfig(LEGACY_V1_CONFIG)

    expect(() => parseAdminAuthConfig(`v1.${canonical.slice(3)}`)).toThrow()
    expect(() => parseAdminAuthConfig(`v2.${LEGACY_V1_CONFIG.slice(3)}`)).toThrow()
    expect(() =>
      parseAdminAuthConfig(encodeCandidate(1, { ...legacy, iterations: 100_000 })),
    ).toThrow()
    expect(() =>
      parseAdminAuthConfig(encodeCandidate(2, { ...generated, iterations: 600_000 })),
    ).toThrow()
    expect(() => parseAdminAuthConfig(`v3.${canonical.slice(3)}`)).toThrow()
  })

  it('fails closed for duplicate, reordered, padded, unknown, and non-canonical data', async () => {
    const generated = await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const canonical = encodeAdminAuthConfig(generated)
    const decoded = Buffer.from(canonical.slice(3), 'base64url').toString('utf8')
    const duplicateVersion = decoded.replace('"version":2,', '"version":2,"version":2,')
    const reordered = JSON.stringify({ username: generated.username, ...generated })

    expect(() =>
      parseAdminAuthConfig(
        `v2.${Buffer.from(duplicateVersion, 'utf8').toString('base64url')}`,
      ),
    ).toThrow()
    expect(() =>
      parseAdminAuthConfig(`v2.${Buffer.from(reordered, 'utf8').toString('base64url')}`),
    ).toThrow()
    expect(() => parseAdminAuthConfig(`${canonical}=`)).toThrow()
    expect(() =>
      parseAdminAuthConfig(
        `v2.${Buffer.from(decoded.replace(/}$/, ',"extra":true}')).toString('base64url')}`,
      ),
    ).toThrow()
    expect(() =>
      parseAdminAuthConfig(
        `v2.${Buffer.from(` ${decoded}`).toString('base64url')}`,
      ),
    ).toThrow()
  })

  it('verifies the exact password and normalized username without exposing which one failed', async () => {
    const generated = await createAdminAuthConfig({
      username: 'Admin.Example',
      displayName: 'Solazhu',
      password: '  密码 with spaces  ',
    })

    await expect(
      verifyAdminCredential(generated, ' admin.example ', '  密码 with spaces  '),
    ).resolves.toBe(true)
    await expect(
      verifyAdminCredential(generated, 'unknown-user', '  密码 with spaces  '),
    ).resolves.toBe(false)
    await expect(
      verifyAdminCredential(generated, 'admin.example', '密码 with spaces'),
    ).resolves.toBe(false)
  })

  it('still derives the password and performs both fixed-length comparisons for a wrong username', async () => {
    const generated = await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const subtle = crypto.subtle as SubtleCrypto & {
      timingSafeEqual(
        first: ArrayBuffer | ArrayBufferView,
        second: ArrayBuffer | ArrayBufferView,
      ): boolean
    }
    const deriveBits = vi.spyOn(subtle, 'deriveBits')
    const timingSafeEqual = vi.spyOn(subtle, 'timingSafeEqual')

    try {
      await expect(
        verifyAdminCredential(
          generated,
          'unknown-user',
          'correct horse battery staple',
        ),
      ).resolves.toBe(false)
      expect(deriveBits).toHaveBeenCalledTimes(1)
      expect(deriveBits.mock.calls[0]?.[0]).toMatchObject({
        name: 'PBKDF2',
        iterations: 100_000,
      })
      expect(timingSafeEqual).toHaveBeenCalledTimes(2)
    } finally {
      deriveBits.mockRestore()
      timingSafeEqual.mockRestore()
    }
  })

  it('rotates credential and rate-limit identifiers on every reset', async () => {
    const input = {
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    }
    const first = await createAdminAuthConfig(input)
    const second = await createAdminAuthConfig(input)

    expect(second.credentialId).not.toBe(first.credentialId)
    expect(second.salt).not.toBe(first.salt)
    expect(second.rateLimitKey).not.toBe(first.rateLimitKey)
  })

  it('rejects non-visible and bidirectional-control display-name code points', async () => {
    for (const displayName of ['Visible\u200BName', 'Visible\u202EName']) {
      await expect(
        createAdminAuthConfig({
          username: 'admin',
          displayName,
          password: 'correct horse battery staple',
        }),
      ).rejects.toThrow()
    }
  })
})
