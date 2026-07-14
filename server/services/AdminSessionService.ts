import type { AdminSessionDto } from '../../shared/api/adminAuthSchemas'
import { DomainError } from '../errors/DomainError'
import type {
  AdminLoginRateLimitRepository,
  AdminSessionRepository,
} from '../repositories/adminSessionRepository'
import {
  verifyAdminCredential,
  type AdminAuthConfig,
} from '../security/adminCredential'

const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const MAXIMUM_LOGIN_ATTEMPTS = 5
const RAW_TOKEN_PATTERN = /^[0-9a-f]{64}$/

export type AdminSessionService = {
  login(input: {
    username: string
    password: string
    clientIdentifier: string
  }): Promise<{ token: string; session: AdminSessionDto }>
  resolve(token: string): Promise<
    | { status: 'active'; session: AdminSessionDto }
    | { status: 'expired' | 'invalid' | 'revoked' }
  >
  logout(token: string): Promise<boolean>
}

export const createAdminSessionService = (input: {
  sessionRepository: AdminSessionRepository
  rateLimitRepository: AdminLoginRateLimitRepository
  config: AdminAuthConfig
  now: () => Date
  generateToken?: () => string
  verifyCredential?: typeof verifyAdminCredential
}): AdminSessionService => {
  const generateToken = input.generateToken ?? generateOpaqueAdminToken
  const verifyCredential = input.verifyCredential ?? verifyAdminCredential

  return {
    async login(command) {
      const now = input.now()
      const nowIso = now.toISOString()
      const keyHash = await createClientRateLimitHash(
        input.config.rateLimitKey,
        command.clientIdentifier,
      )
      const reservation = await input.rateLimitRepository.reserveAttempt({
        keyHash,
        now: nowIso,
        resetBefore: new Date(now.getTime() - RATE_LIMIT_WINDOW_MS).toISOString(),
        blockedUntil: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS).toISOString(),
        maximumAttempts: MAXIMUM_LOGIN_ATTEMPTS,
      })

      if (reservation.status === 'blocked') {
        throw createRateLimitError(now, reservation.blockedUntil)
      }

      const credentialMatches = await verifyCredential(
        input.config,
        command.username,
        command.password,
      )
      if (!credentialMatches) {
        if (reservation.blockedUntil) {
          throw createRateLimitError(now, reservation.blockedUntil)
        }
        throw new DomainError(
          'invalid_admin_credentials',
          'Administrator credentials are invalid',
        )
      }

      await input.rateLimitRepository.clear(keyHash)
      const token = generateToken()
      if (!RAW_TOKEN_PATTERN.test(token)) {
        throw new Error('Admin session token generator returned an invalid token')
      }
      await input.sessionRepository.create({
        id: crypto.randomUUID(),
        tokenHash: await hashToken(token),
        credentialId: input.config.credentialId,
        createdAt: nowIso,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      })
      return {
        token,
        session: toSessionDto(input.config),
      }
    },

    async resolve(token) {
      if (!RAW_TOKEN_PATTERN.test(token)) return { status: 'invalid' }
      const session = await input.sessionRepository.getByTokenHash(await hashToken(token))
      if (!session) return { status: 'invalid' }
      if (session.revokedAt) return { status: 'revoked' }
      if (session.credentialId !== input.config.credentialId) return { status: 'revoked' }
      const expiresAt = Date.parse(session.expiresAt)
      if (!Number.isFinite(expiresAt)) return { status: 'invalid' }
      if (expiresAt <= input.now().getTime()) return { status: 'expired' }
      return { status: 'active', session: toSessionDto(input.config) }
    },

    async logout(token) {
      if (!RAW_TOKEN_PATTERN.test(token)) return false
      const session = await input.sessionRepository.getByTokenHash(await hashToken(token))
      if (!session) return false
      return input.sessionRepository.revokeById(session.id, input.now().toISOString())
    },
  }
}

const toSessionDto = (config: AdminAuthConfig): AdminSessionDto => ({
  id: config.credentialId,
  source: 'application_session',
  displayName: config.displayName,
})

const generateOpaqueAdminToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

const hashToken = async (token: string): Promise<string> =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
  )

const createClientRateLimitHash = async (
  encodedKey: string,
  clientIdentifier: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(decodeBase64Url(encodedKey)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(clientIdentifier)),
    ),
  )
}

const createRateLimitError = (now: Date, blockedUntil: string): DomainError => {
  const remainingMilliseconds = Math.max(1_000, Date.parse(blockedUntil) - now.getTime())
  return new DomainError(
    'admin_login_rate_limited',
    'Administrator login is temporarily rate limited',
    { retryAfterSeconds: Math.ceil(remainingMilliseconds / 1_000) },
  )
}

const decodeBase64Url = (value: string): Uint8Array => {
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(
    (4 - (value.length % 4)) % 4,
  )}`
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
