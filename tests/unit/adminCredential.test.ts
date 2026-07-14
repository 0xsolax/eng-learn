import { describe, expect, it } from 'vitest'
import {
  createAdminAuthConfig,
  encodeAdminAuthConfig,
  parseAdminAuthConfig,
  verifyAdminCredential,
} from '../../server/security/adminCredential'

describe('admin credential configuration', () => {
  it('round-trips only the canonical versioned configuration', async () => {
    const generated = await createAdminAuthConfig({
      username: 'Admin.Example',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const encoded = encodeAdminAuthConfig(generated)

    expect(encoded).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain('correct horse battery staple')
    expect(parseAdminAuthConfig(encoded)).toEqual(generated)
  })

  it('fails closed for unknown versions, unknown fields, and non-canonical JSON', async () => {
    const generated = await createAdminAuthConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
    })
    const canonical = encodeAdminAuthConfig(generated)
    const decoded = Buffer.from(canonical.slice(3), 'base64url').toString('utf8')

    expect(() => parseAdminAuthConfig(`v2.${canonical.slice(3)}`)).toThrow()
    expect(() =>
      parseAdminAuthConfig(
        `v1.${Buffer.from(decoded.replace(/}$/, ',"extra":true}')).toString('base64url')}`,
      ),
    ).toThrow()
    expect(() =>
      parseAdminAuthConfig(
        `v1.${Buffer.from(` ${decoded}`).toString('base64url')}`,
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
