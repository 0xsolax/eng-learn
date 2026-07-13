import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
} from 'jose'
import { describe, expect, it } from 'vitest'
import {
  createCloudflareAccessAuthenticator,
  createServiceTokenAuthenticator,
} from '../../server/security/adminAuthentication'

const ISSUER = 'https://eng-learn.cloudflareaccess.com'
const AUDIENCE = 'eng-learn-admin-audience'
const NOW = new Date('2026-07-13T00:00:00.000Z')

const createSigningFixture = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  const kid = 'access-key-1'
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: 'RS256', kid, use: 'sig' }],
  } satisfies JSONWebKeySet)
  const sign = async (
    input: {
      audience?: string
      expiresAt?: number
      issuer?: string
      omitExpiry?: boolean
    } = {},
  ) => {
    let token = new SignJWT({ email: 'admin@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(input.issuer ?? ISSUER)
      .setAudience(input.audience ?? AUDIENCE)
      .setSubject('access-user-1')
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))

    if (!input.omitExpiry) {
      token = token.setExpirationTime(
        input.expiresAt ?? Math.floor(NOW.getTime() / 1000) + 300,
      )
    }

    return token.sign(privateKey)
  }

  return { jwks, sign }
}

describe('admin authentication', () => {
  it('accepts a signed Cloudflare Access assertion with the expected issuer and audience', async () => {
    const { jwks, sign } = await createSigningFixture()
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      now: () => NOW,
    })
    const request = new Request('https://learn.example.com/api/admin/health', {
      headers: { 'cf-access-jwt-assertion': await sign() },
    })

    await expect(authenticator.authenticate(request)).resolves.toEqual({
      source: 'cloudflare_access',
      subject: 'access-user-1',
      email: 'admin@example.com',
    })
  })

  it('rejects an assertion signed by an untrusted key', async () => {
    const trusted = await createSigningFixture()
    const attacker = await createSigningFixture()
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: trusted.jwks,
      now: () => NOW,
    })
    const request = new Request('https://learn.example.com/api/admin/health', {
      headers: { 'cf-access-jwt-assertion': await attacker.sign() },
    })

    await expect(authenticator.authenticate(request)).resolves.toBeUndefined()
  })

  it('rejects an assertion for another Access application audience', async () => {
    const { jwks, sign } = await createSigningFixture()
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      now: () => NOW,
    })
    const request = new Request('https://learn.example.com/api/admin/health', {
      headers: { 'cf-access-jwt-assertion': await sign({ audience: 'other-application' }) },
    })

    await expect(authenticator.authenticate(request)).resolves.toBeUndefined()
  })

  it('rejects an assertion from another issuer or past its expiry', async () => {
    const { jwks, sign } = await createSigningFixture()
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      now: () => NOW,
    })
    const wrongIssuer = new Request('https://learn.example.com/api/admin/health', {
      headers: {
        'cf-access-jwt-assertion': await sign({
          issuer: 'https://attacker.cloudflareaccess.com',
        }),
      },
    })
    const expired = new Request('https://learn.example.com/api/admin/health', {
      headers: {
        'cf-access-jwt-assertion': await sign({
          expiresAt: Math.floor(NOW.getTime() / 1000) - 1,
        }),
      },
    })

    await expect(authenticator.authenticate(wrongIssuer)).resolves.toBeUndefined()
    await expect(authenticator.authenticate(expired)).resolves.toBeUndefined()
  })

  it('rejects a signed assertion that omits its expiry claim', async () => {
    const { jwks, sign } = await createSigningFixture()
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      now: () => NOW,
    })
    const request = new Request('https://learn.example.com/api/admin/health', {
      headers: { 'cf-access-jwt-assertion': await sign({ omitExpiry: true }) },
    })

    await expect(authenticator.authenticate(request)).resolves.toBeUndefined()
  })

  it('keeps a separate service-token authenticator for non-browser callers', async () => {
    const authenticator = createServiceTokenAuthenticator({
      token: 'service-secret-1',
      subject: 'deployment-smoke',
    })

    await expect(
      authenticator.authenticate(
        new Request('https://learn.example.com/api/admin/health', {
          headers: { 'x-admin-token': 'service-secret-1' },
        }),
      ),
    ).resolves.toEqual({
      source: 'service_token',
      subject: 'deployment-smoke',
    })
    await expect(
      authenticator.authenticate(
        new Request('https://learn.example.com/api/admin/health', {
          headers: { 'x-admin-token': 'wrong-secret' },
        }),
      ),
    ).resolves.toBeUndefined()
  })
})
