import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export type AdminIdentity = {
  source: 'cloudflare_access' | 'application_session' | 'service_token'
  subject: string
  displayName?: string
  email?: string
}

export type AdminAuthenticator = {
  authenticate(request: Request): Promise<AdminIdentity | undefined>
}

export const createCloudflareAccessAuthenticator = (input: {
  issuer: string
  audience: string
  jwks?: JWTVerifyGetKey
  jwksUrl?: URL
  now?: () => Date
}): AdminAuthenticator => {
  const issuer = new URL(input.issuer).origin
  const jwks =
    input.jwks ??
    createRemoteJWKSet(input.jwksUrl ?? new URL('/cdn-cgi/access/certs', `${issuer}/`))
  const now = input.now ?? (() => new Date())

  return {
    async authenticate(request) {
      const token = request.headers.get('cf-access-jwt-assertion')

      if (!token) {
        return undefined
      }

      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: input.audience,
          algorithms: ['RS256'],
          currentDate: now(),
          requiredClaims: ['exp', 'sub'],
        })

        if (!payload.sub) {
          return undefined
        }

        return {
          source: 'cloudflare_access',
          subject: payload.sub,
          ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        }
      } catch {
        return undefined
      }
    },
  }
}

export const createServiceTokenAuthenticator = (input: {
  token: string
  subject?: string
}): AdminAuthenticator => {
  if (!input.token) {
    throw new Error('Service token must not be empty')
  }

  return {
    async authenticate(request) {
      const candidate = request.headers.get('x-admin-token')

      if (!candidate || !(await constantTimeSecretEqual(candidate, input.token))) {
        return undefined
      }

      return {
        source: 'service_token',
        subject: input.subject ?? 'service-token',
      }
    },
  }
}

const constantTimeSecretEqual = async (candidate: string, expected: string): Promise<boolean> => {
  const encoder = new TextEncoder()
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const candidateBytes = new Uint8Array(candidateDigest)
  const expectedBytes = new Uint8Array(expectedDigest)
  let difference = candidate.length === expected.length ? 0 : 1

  for (let index = 0; index < candidateBytes.length; index += 1) {
    difference |= (candidateBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0)
  }

  return difference === 0
}
