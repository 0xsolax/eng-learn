import type {
  AdminAuthenticator,
  AdminIdentity,
} from '../security/adminAuthentication'
import {
  hasExactWriteOrigin,
  readLearnerSessionCookie,
} from '../security/learnerHttpSecurity'
import type {
  LearnerSessionPrincipal,
  LearnerSessionService,
} from '../services/LearnerSessionService'
import type { AdminSessionService } from '../services/AdminSessionService'
import { DomainError } from '../errors/DomainError'
import {
  hasAdminSessionCookie,
  readAdminSessionCookie,
} from '../security/adminHttpSecurity'

export type AdminAuthenticationBoundary = {
  accessAuthenticator?: AdminAuthenticator
  applicationSessionService?: AdminSessionService
  serviceAuthenticator?: AdminAuthenticator
  browserMode?: 'application_session' | 'cloudflare_access'
  allowedOrigin: string
}

export const requireAdminIdentity = async (
  request: Request,
  boundary: AdminAuthenticationBoundary,
  options: { allowServiceToken?: boolean } = {},
): Promise<AdminIdentity> => {
  const hasAccessAssertion = request.headers.has('cf-access-jwt-assertion')
  const hasServiceToken = request.headers.has('x-admin-token')
  const cookieHeader = request.headers.get('cookie')
  const hasApplicationCookie = hasAdminSessionCookie(cookieHeader)
  const browserMode = boundary.browserMode ?? 'cloudflare_access'
  let identity: AdminIdentity | undefined

  if (hasAccessAssertion) {
    identity = await boundary.accessAuthenticator?.authenticate(request)
  } else if (browserMode === 'application_session' && hasApplicationCookie) {
    const token = readAdminSessionCookie(cookieHeader)
    if (!token) {
      throw new DomainError('admin_session_required', 'Administrator session is required')
    }
    const result = await boundary.applicationSessionService?.resolve(token)
    if (result?.status === 'active') {
      identity = {
        source: 'application_session',
        subject: result.session.id,
        displayName: result.session.displayName,
      }
    } else if (result?.status === 'expired') {
      throw new DomainError('admin_session_expired', 'Administrator session has expired')
    } else if (result?.status === 'revoked') {
      throw new DomainError('admin_session_revoked', 'Administrator session has been revoked')
    } else {
      throw new DomainError('admin_session_required', 'Administrator session is required')
    }
  } else if (hasServiceToken && (options.allowServiceToken ?? true)) {
    identity = await boundary.serviceAuthenticator?.authenticate(request)
  } else if (
    !boundary.accessAuthenticator &&
    !boundary.applicationSessionService &&
    !boundary.serviceAuthenticator
  ) {
    throw new DomainError('admin_disabled', 'Admin access is not configured')
  } else {
    throw new DomainError(
      browserMode === 'application_session'
        ? 'admin_session_required'
        : 'unauthorized',
      'Admin authorization is required',
    )
  }

  if (!identity) {
    throw new DomainError('admin_identity_invalid', 'Admin identity is invalid')
  }

  if (
    (identity.source === 'cloudflare_access' ||
      identity.source === 'application_session') &&
    !hasExactWriteOrigin(request, boundary.allowedOrigin)
  ) {
    throw new DomainError('origin_forbidden', 'Request origin is not allowed')
  }

  return identity
}

export const requireExactWriteOrigin = (request: Request, allowedOrigin: string): void => {
  if (!hasExactWriteOrigin(request, allowedOrigin)) {
    throw new DomainError('origin_forbidden', 'Request origin is not allowed')
  }
}

export const requireLearnerPrincipal = async (
  request: Request,
  sessionService: LearnerSessionService,
): Promise<LearnerSessionPrincipal> => {
  const token = readLearnerSessionCookie(request.headers.get('cookie'))

  if (!token) {
    throw new DomainError('learner_session_required', 'Learner session is required')
  }

  const result = await sessionService.resolve(token)

  if (result.status === 'active') {
    return result.principal
  }

  if (result.status === 'expired') {
    throw new DomainError('learner_session_expired', 'Learner session has expired')
  }

  if (result.status === 'revoked') {
    throw new DomainError('learner_session_revoked', 'Learner session has been revoked')
  }

  throw new DomainError('learner_session_required', 'Learner session is required')
}
