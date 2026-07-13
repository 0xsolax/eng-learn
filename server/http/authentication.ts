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
import { DomainError } from '../errors/DomainError'

export type AdminAuthenticationBoundary = {
  accessAuthenticator?: AdminAuthenticator
  serviceAuthenticator?: AdminAuthenticator
  allowedOrigin: string
}

export const requireAdminIdentity = async (
  request: Request,
  boundary: AdminAuthenticationBoundary,
): Promise<AdminIdentity> => {
  const hasAccessAssertion = request.headers.has('cf-access-jwt-assertion')
  const hasServiceToken = request.headers.has('x-admin-token')
  let identity: AdminIdentity | undefined

  if (hasAccessAssertion) {
    identity = await boundary.accessAuthenticator?.authenticate(request)
  } else if (hasServiceToken) {
    identity = await boundary.serviceAuthenticator?.authenticate(request)
  } else if (!boundary.accessAuthenticator && !boundary.serviceAuthenticator) {
    throw new DomainError('admin_disabled', 'Admin access is not configured')
  } else {
    throw new DomainError('unauthorized', 'Admin authorization is required')
  }

  if (!identity) {
    throw new DomainError('admin_identity_invalid', 'Admin identity is invalid')
  }

  if (
    identity.source === 'cloudflare_access' &&
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
