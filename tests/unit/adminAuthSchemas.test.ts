import { describe, expect, it } from 'vitest'
import {
  adminLoginRequestSchema,
  adminSessionSchema,
  adminLogoutResultSchema,
} from '@shared/api/adminAuthSchemas'
import { apiErrorSchema } from '@shared/api/schemas'

describe('admin authentication contracts', () => {
  it('normalizes only the username and preserves password code points exactly', () => {
    expect(
      adminLoginRequestSchema.parse({
        username: '  Admin.Example  ',
        password: '  密码 with spaces  ',
      }),
    ).toEqual({
      username: 'admin.example',
      password: '  密码 with spaces  ',
    })
  })

  it('rejects unknown fields and oversized login input', () => {
    expect(
      adminLoginRequestSchema.safeParse({
        username: 'admin',
        password: 'a'.repeat(129),
        rememberMe: true,
      }).success,
    ).toBe(false)
  })

  it('supports application sessions with a server-owned display name', () => {
    expect(
      adminSessionSchema.parse({
        id: 'admin-credential-1',
        source: 'application_session',
        displayName: '内容管理员',
      }),
    ).toEqual({
      id: 'admin-credential-1',
      source: 'application_session',
      displayName: '内容管理员',
    })
  })

  it('measures display names in Unicode code points', () => {
    expect(
      adminSessionSchema.parse({
        id: 'admin-credential-1',
        source: 'application_session',
        displayName: '😀'.repeat(64),
      }).displayName,
    ).toBe('😀'.repeat(64))
    expect(
      adminSessionSchema.safeParse({
        id: 'admin-credential-1',
        source: 'application_session',
        displayName: '😀'.repeat(65),
      }).success,
    ).toBe(false)
    expect(
      adminSessionSchema.safeParse({
        id: 'admin-credential-1',
        source: 'application_session',
        displayName: 'Visible\tName',
      }).success,
    ).toBe(false)
    expect(
      adminSessionSchema.safeParse({
        id: 'admin-credential-1',
        source: 'application_session',
        displayName: 'Visible\u200BName',
      }).success,
    ).toBe(false)
  })

  it('requires a retry delay on the stable login cooldown error', () => {
    expect(
      apiErrorSchema.parse({
        code: 'admin_login_rate_limited',
        message: 'Too many login attempts',
        details: { retryAfterSeconds: 900 },
      }),
    ).toEqual({
      code: 'admin_login_rate_limited',
      message: 'Too many login attempts',
      details: { retryAfterSeconds: 900 },
    })

    expect(
      apiErrorSchema.safeParse({
        code: 'admin_login_rate_limited',
        message: 'Too many login attempts',
      }).success,
    ).toBe(false)
  })

  it('keeps logout success free of session or credential data', () => {
    expect(adminLogoutResultSchema.parse({ loggedOut: true })).toEqual({ loggedOut: true })
    expect(
      adminLogoutResultSchema.safeParse({ loggedOut: true, sessionToken: 'secret' }).success,
    ).toBe(false)
  })
})
