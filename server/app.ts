import {
  adminLoginRequestSchema,
  adminSessionSchema,
} from '../shared/api/adminAuthSchemas'
import {
  createCourseRequestSchema,
  courseProgressResetRequestSchema,
  enterCourseByAccessCodeRequestSchema,
  rotateAccessCodeRequestSchema,
} from '../shared/api/schemas'
import {
  previewSentenceOutputRequestSchema,
  submitTaskAnswerRequestSchema,
  taskAnswerResultSchema,
} from '../shared/api/taskSchemas'
import { createD1ContentRepository } from './repositories/d1ContentRepository'
import { createD1CourseRepository } from './repositories/d1CourseRepository'
import { createD1LessonReplayRepository } from './repositories/d1LessonReplayRepository'
import { createD1SessionRepository } from './repositories/d1SessionRepository'
import { createD1AdminSessionRepository } from './repositories/d1AdminSessionRepository'
import { createInMemoryContentRepository } from './repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from './repositories/inMemoryCourseRepository'
import { createInMemoryLessonReplayRepository } from './repositories/inMemoryLessonReplayRepository'
import { createInMemorySessionRepository } from './repositories/inMemorySessionRepository'
import { createInMemoryAdminSessionRepository } from './repositories/inMemoryAdminSessionRepository'
import type { CourseRecord, CourseRepository } from './repositories/courseRepository'
import { getCourseRunLessonNo } from './repositories/courseRepository'
import {
  createD1AdminOperationLedger,
  createInMemoryAdminOperationLedger,
} from './repositories/adminOperationLedger'
import {
  createCloudflareAccessAuthenticator,
  createServiceTokenAuthenticator,
  type AdminAuthenticator,
  type AdminIdentity,
} from './security/adminAuthentication'
import {
  clearLearnerSessionCookie,
  createLearnerSessionCookie,
  readLearnerSessionCookie,
} from './security/learnerHttpSecurity'
import {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasAdminSessionCookie,
  readAdminSessionCookie,
} from './security/adminHttpSecurity'
import {
  parseAdminAuthConfig,
  type AdminAuthConfig,
} from './security/adminCredential'
import { createContentBuilder, type ContentBuilder } from './services/ContentBuilder'
import {
  createCourseRuntime,
  parseLessonFlowWriteMode,
  parseLessonQueueWriteMode,
  type CourseRuntime,
} from './services/CourseRuntime'
import {
  createCourseQueryService,
  type CourseQueryService,
} from './services/CourseQueryService'
import {
  createLearnerSessionService,
  type LearnerSessionService,
} from './services/LearnerSessionService'
import {
  createAdminSessionService,
  type AdminSessionService,
} from './services/AdminSessionService'
import {
  createLearningProgressService,
  type LearningProgressService,
} from './services/LearningProgressService'
import {
  createLessonReplayService,
  type LessonReplayService,
} from './services/LessonReplayService'
import {
  requireAdminIdentity,
  requireExactWriteOrigin,
  requireLearnerPrincipal,
  type AdminAuthenticationBoundary,
} from './http/authentication'
import { routeAdminContentRequest } from './http/adminRoutes'
import { apiJson, apiOk, toApiErrorResponse } from './http/apiResponse'
import { parseJsonRequest } from './http/request'
import { DomainError, isDomainError } from './errors/DomainError'
import {
  isPassingReviewScore,
  type SubmittedTaskAnswer,
} from '../shared/domain/course'

export type WorkerApp = {
  fetch(request: Request): Promise<Response>
}

export type WorkerEnv = {
  DB: D1Database
  ASSETS?: { fetch(request: Request): Promise<Response> }
  ADMIN_API_TOKEN?: string
  ADMIN_AUTH_CONFIG?: string
  ADMIN_BROWSER_AUTH_MODE?: string
  APP_ORIGIN?: string
  CF_ACCESS_ISSUER?: string
  CF_ACCESS_AUDIENCE?: string
  LESSON_QUEUE_WRITE_MODE?: string
  LESSON_FLOW_WRITE_MODE?: string
}

export type CreateWorkerAppInput = {
  contentBuilder: ContentBuilder
  courseRuntime: CourseRuntime
  courseQueryService: CourseQueryService
  courseRepository: CourseRepository
  lessonReplayService: LessonReplayService
  learningProgressService: LearningProgressService
  learnerSessionService: LearnerSessionService
  adminAuthentication: AdminAuthenticationBoundary
  assets?: { fetch(request: Request): Promise<Response> }
}

export const createWorkerApp = (input: CreateWorkerAppInput): WorkerApp => ({
  async fetch(request: Request): Promise<Response> {
    try {
      return await routeRequest(request, input)
    } catch (error) {
      return toApiErrorResponse(error)
    }
  },
})

export const createTestWorkerApp = (
  input: {
    adminIdentity?: { id: string; email?: string }
    adminAuthConfig?: AdminAuthConfig
    adminSessionService?: AdminSessionService
    adminToken?: string
    allowedOrigin?: string
    assets?: { fetch(request: Request): Promise<Response> }
    browserMode?: 'application_session' | 'cloudflare_access'
    now?: () => Date
  } = {},
): WorkerApp => {
  const now = input.now ?? (() => new Date('2026-07-13T00:00:00.000Z'))
  const operationLedger = createInMemoryAdminOperationLedger()
  const contentRepository = createInMemoryContentRepository({ ledger: operationLedger })
  const courseRepository = createInMemoryCourseRepository({ ledger: operationLedger })
  const replayRepository = createInMemoryLessonReplayRepository()
  const sessionRepository = createInMemorySessionRepository({
    credentialPort: courseRepository,
    ledger: operationLedger,
  })
  const adminSessionRepository = createInMemoryAdminSessionRepository()
  const adminSessionService =
    input.adminSessionService ??
    (input.adminAuthConfig
      ? createAdminSessionService({
          sessionRepository: adminSessionRepository,
          rateLimitRepository: adminSessionRepository,
          config: input.adminAuthConfig,
          now,
        })
      : undefined)
  const adminIdentity = input.adminIdentity
  const accessAuthenticator: AdminAuthenticator | undefined = adminIdentity
    ? {
        authenticate: () =>
          Promise.resolve({
            source: 'cloudflare_access',
            subject: adminIdentity.id,
            ...(adminIdentity.email ? { email: adminIdentity.email } : {}),
          }),
      }
    : undefined

  return createWorkerApp({
    contentBuilder: createContentBuilder({
      repository: contentRepository,
      operationLedger,
      now,
    }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      operationLedger,
      now,
      queueWriteMode: 'v2',
      flowWriteMode: 'rolling_v2',
    }),
    courseQueryService: createCourseQueryService({
      contentRepository,
      courseRepository,
      flowWriteMode: 'rolling_v2',
    }),
    courseRepository,
    lessonReplayService: createLessonReplayService({
      courseRepository,
      replayRepository,
      now,
    }),
    learningProgressService: createLearningProgressService({
      courseRepository,
      operationLedger,
      now,
    }),
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger,
      now,
    }),
    adminAuthentication: {
      ...(accessAuthenticator ? { accessAuthenticator } : {}),
      ...(adminSessionService ? { applicationSessionService: adminSessionService } : {}),
      ...(input.adminToken
        ? {
            serviceAuthenticator: createServiceTokenAuthenticator({
              token: input.adminToken,
              subject: 'test-service-token',
            }),
          }
        : {}),
      allowedOrigin: input.allowedOrigin ?? 'https://eng-learn.test',
      browserMode:
        input.browserMode ?? (adminIdentity ? 'cloudflare_access' : 'application_session'),
    },
    ...(input.assets ? { assets: input.assets } : {}),
  })
}

export const createDefaultWorkerApp = (env: WorkerEnv): WorkerApp => {
  const now = () => new Date()
  const operationLedger = createD1AdminOperationLedger(env.DB, {
    includeProgressResets: true,
  })
  const contentRepository = createD1ContentRepository(env.DB)
  const courseRepository = createD1CourseRepository(env.DB)
  const replayRepository = createD1LessonReplayRepository(env.DB)
  const sessionRepository = createD1SessionRepository(env.DB)
  const adminSessionRepository = createD1AdminSessionRepository(env.DB)
  const adminAuthConfig = readAdminAuthConfig(env.ADMIN_AUTH_CONFIG)
  const adminSessionService = adminAuthConfig
    ? createAdminSessionService({
        sessionRepository: adminSessionRepository,
        rateLimitRepository: adminSessionRepository,
        config: adminAuthConfig,
        now,
      })
    : undefined
  const accessAuthenticator = createAccessAuthenticator(env)
  const serviceAuthenticator = env.ADMIN_API_TOKEN
    ? createServiceTokenAuthenticator({
        token: env.ADMIN_API_TOKEN,
        subject: 'operations-service-token',
      })
    : undefined

  return createWorkerApp({
    contentBuilder: createContentBuilder({
      repository: contentRepository,
      operationLedger,
      now,
    }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      operationLedger,
      now,
      queueWriteMode: parseLessonQueueWriteMode(env.LESSON_QUEUE_WRITE_MODE),
      flowWriteMode: parseLessonFlowWriteMode(env.LESSON_FLOW_WRITE_MODE),
    }),
    courseQueryService: createCourseQueryService({
      contentRepository,
      courseRepository,
      flowWriteMode: parseLessonFlowWriteMode(env.LESSON_FLOW_WRITE_MODE),
    }),
    courseRepository,
    lessonReplayService: createLessonReplayService({
      courseRepository,
      replayRepository,
      now,
    }),
    learningProgressService: createLearningProgressService({
      courseRepository,
      operationLedger,
      now,
    }),
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger,
      now,
    }),
    adminAuthentication: {
      ...(accessAuthenticator ? { accessAuthenticator } : {}),
      ...(adminSessionService ? { applicationSessionService: adminSessionService } : {}),
      ...(serviceAuthenticator ? { serviceAuthenticator } : {}),
      allowedOrigin: env.APP_ORIGIN ?? 'https://configuration.invalid',
      browserMode: parseAdminBrowserAuthMode(env.ADMIN_BROWSER_AUTH_MODE),
    },
    ...(env.ASSETS ? { assets: env.ASSETS } : {}),
  })
}

const routeRequest = async (
  request: Request,
  input: CreateWorkerAppInput,
): Promise<Response> => {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const isAdminApi = path[0] === 'api' && path[1] === 'admin'
  const isAdminDocument = path[0] === 'admin'

  if (
    input.adminAuthentication.browserMode === 'application_session' &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    url.pathname === '/admin/login'
  ) {
    return fetchAdminAsset(request, input.assets)
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/auth/login') {
    if (input.adminAuthentication.browserMode !== 'application_session') {
      return notFound()
    }
    requireExactWriteOrigin(request, input.adminAuthentication.allowedOrigin)
    const service = input.adminAuthentication.applicationSessionService
    if (!service) {
      throw new DomainError(
        'admin_not_configured',
        'Administrator authentication is not configured',
      )
    }
    const command = await parseJsonRequest(request, adminLoginRequestSchema, {
      maxBytes: 4 * 1024,
    })
    const established = await service.login({
      ...command,
      clientIdentifier: request.headers.get('cf-connecting-ip') ?? 'missing-client-ip',
    })
    return apiOk(established.session, 200, {
      'set-cookie': createAdminSessionCookie(established.token),
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/auth/logout') {
    if (input.adminAuthentication.browserMode !== 'application_session') {
      return notFound()
    }
    requireExactWriteOrigin(request, input.adminAuthentication.allowedOrigin)
    const token = readAdminSessionCookie(request.headers.get('cookie'))
    if (token) {
      const service = input.adminAuthentication.applicationSessionService
      if (!service) {
        throw new DomainError(
          'admin_not_configured',
          'Administrator authentication is not configured',
        )
      }
      await service.logout(token)
    }
    return apiOk({ loggedOut: true }, 200, {
      'set-cookie': clearAdminSessionCookie(),
    })
  }

  if (isAdminApi || isAdminDocument) {
    if (isAdminDocument) {
      if (request.headers.has('x-admin-token')) {
        throw new DomainError(
          'admin_identity_invalid',
          'Service tokens cannot load administrator documents',
        )
      }

      try {
        const identity = await requireAdminIdentity(request, input.adminAuthentication, {
          allowServiceToken: false,
        })
        const expectedBrowserSource =
          input.adminAuthentication.browserMode === 'application_session'
            ? 'application_session'
            : 'cloudflare_access'
        if (identity.source !== expectedBrowserSource) {
          throw new DomainError(
            'admin_identity_invalid',
            'Admin identity does not match the configured browser mode',
          )
        }
      } catch (error) {
        if (
          input.adminAuthentication.browserMode === 'application_session' &&
          isAdminDocumentAuthenticationError(error)
        ) {
          return redirectToAdminLogin(request, hasAdminSessionCookie(request.headers.get('cookie')))
        }
        throw error
      }

      return fetchAdminAsset(request, input.assets)
    }

    const identity = await requireAdminIdentity(request, input.adminAuthentication)

    if (request.method === 'GET' && url.pathname === '/api/admin/session') {
      return apiOk(toAdminSession(identity))
    }

    const contentResponse = await routeAdminContentRequest(
      request,
      url,
      input.contentBuilder,
    )

    if (contentResponse) return contentResponse

    if (request.method === 'POST' && url.pathname === '/api/admin/courses') {
      const command = await parseJsonRequest(request, createCourseRequestSchema)

      return apiOk(await input.courseRuntime.createCourseIdempotently(command))
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/courses') {
      return apiOk(await input.courseQueryService.listAdminCourses())
    }

    if (
      request.method === 'POST' &&
      path.length === 6 &&
      path[2] === 'courses' &&
      path[4] === 'learning-progress' &&
      path[5] === 'reset'
    ) {
      const courseId = requirePathSegment(path, 3)
      const command = await parseJsonRequest(request, courseProgressResetRequestSchema)

      return apiOk(
        await input.learningProgressService.resetCourseProgress(courseId, command, identity),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 6 &&
      path[2] === 'learners' &&
      path[4] === 'access-code' &&
      path[5] === 'rotate'
    ) {
      const learnerId = requirePathSegment(path, 3)
      const command = await parseJsonRequest(request, rotateAccessCodeRequestSchema)
      const rotated = await input.learnerSessionService.rotateAccessCodeIdempotently(
        learnerId,
        command,
      )

      if (!rotated) throw new DomainError('not_found', 'Learner is missing')

      return apiOk(rotated)
    }

    return notFound()
  }

  if (request.method === 'GET' && url.pathname === '/api/app/health') {
    return apiOk({ scope: 'app' })
  }

  if (path[0] === 'api' && path[1] === 'app') {
    requireExactWriteOrigin(request, input.adminAuthentication.allowedOrigin)

    if (request.method === 'POST' && url.pathname === '/api/app/session/by-code') {
      const command = await parseJsonRequest(request, enterCourseByAccessCodeRequestSchema)
      const established = await input.learnerSessionService.exchangeAccessCode(command.accessCode)

      if (!established) {
        throw new DomainError('invalid_access_code', 'Learning code is invalid')
      }

      return apiOk(established.identity, 200, {
        'set-cookie': createLearnerSessionCookie(established.token),
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/app/session/logout') {
      const token = readLearnerSessionCookie(request.headers.get('cookie'))

      if (token) await input.learnerSessionService.revoke(token)

      return apiOk({ loggedOut: true }, 200, {
        'set-cookie': clearLearnerSessionCookie(),
      })
    }

    const principal = await requireLearnerPrincipal(request, input.learnerSessionService)

    if (request.method === 'GET' && url.pathname === '/api/app/session') {
      const course = await input.courseRepository.getCourseForLearner({
        courseId: principal.courseId,
        learnerId: principal.learnerId,
      })

      if (!course) throw new DomainError('forbidden_resource', 'Course access is forbidden')
      if (course.status !== 'active') {
        throw new DomainError('course_unavailable', 'Course is not active')
      }

      return apiOk({ learner: { id: principal.learnerId }, course: toCourseView(course) })
    }

    if (request.method === 'GET' && url.pathname === '/api/app/course') {
      return apiOk(
        await input.courseQueryService.getCourseHome({
          learnerId: principal.learnerId,
          courseId: principal.courseId,
        }),
      )
    }

    if (
      request.method === 'GET' &&
      path.length === 5 &&
      path[2] === 'courses' &&
      path[4] === 'completed-lessons'
    ) {
      const courseId = requirePathSegment(path, 3)
      requireCourseOwnership(courseId, principal.courseId)
      const rawLimit = url.searchParams.get('limit') ?? '20'
      const limit = Number(rawLimit)
      const cursor = url.searchParams.get('cursor') ?? undefined

      return apiOk(
        await input.lessonReplayService.listCompletedLessons(principal, {
          ...(cursor ? { cursor } : {}),
          limit,
        }),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 5 &&
      path[2] === 'lessons' &&
      path[4] === 'replays'
    ) {
      const sourceSessionId = requirePathSegment(path, 3)

      return apiOk(
        await input.lessonReplayService.startReplay(principal, sourceSessionId),
      )
    }

    if (
      request.method === 'GET' &&
      path.length === 4 &&
      path[2] === 'lesson-replays'
    ) {
      const replaySessionId = requirePathSegment(path, 3)

      return apiOk(
        await input.lessonReplayService.getReplay(principal, replaySessionId),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 7 &&
      path[2] === 'lesson-replays' &&
      path[4] === 'tasks' &&
      path[6] === 'preview'
    ) {
      const replaySessionId = requirePathSegment(path, 3)
      const taskId = requirePathSegment(path, 5)
      const preview = await parseJsonRequest(request, previewSentenceOutputRequestSchema)

      return apiOk(
        await input.lessonReplayService.previewSentenceOutput(principal, {
          replaySessionId,
          taskId,
          preview,
        }),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 7 &&
      path[2] === 'lesson-replays' &&
      path[4] === 'tasks' &&
      path[6] === 'answer'
    ) {
      const replaySessionId = requirePathSegment(path, 3)
      const taskId = requirePathSegment(path, 5)
      const submission = await parseJsonRequest(request, submitTaskAnswerRequestSchema)

      return apiOk(
        taskAnswerResultSchema.parse(
          await input.lessonReplayService.submitAnswer(principal, {
            replaySessionId,
            taskId,
            submission,
          }),
        ),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 5 &&
      path[2] === 'lesson-replays' &&
      path[4] === 'complete'
    ) {
      const replaySessionId = requirePathSegment(path, 3)

      return apiOk(
        await input.lessonReplayService.completeReplay(principal, replaySessionId),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 6 &&
      path[2] === 'courses' &&
      path[4] === 'lessons' &&
      path[5] === 'start'
    ) {
      const courseId = requirePathSegment(path, 3)
      requireCourseOwnership(courseId, principal.courseId)

      return apiOk(await input.courseRuntime.startLesson(courseId))
    }

    if (
      request.method === 'GET' &&
      path.length === 5 &&
      path[2] === 'lessons' &&
      path[4] === 'report'
    ) {
      const sessionId = requirePathSegment(path, 3)

      return apiOk(
        await input.courseQueryService.getLessonReport(
          { learnerId: principal.learnerId, courseId: principal.courseId },
          sessionId,
        ),
      )
    }

    if (
      request.method === 'GET' &&
      path.length === 4 &&
      path[2] === 'lessons'
    ) {
      const sessionId = requirePathSegment(path, 3)
      await requireSessionOwnership(input.courseRepository, sessionId, principal.courseId)

      return apiOk(await input.courseRuntime.getLesson(sessionId))
    }

    if (
      request.method === 'POST' &&
      path.length === 7 &&
      path[2] === 'lessons' &&
      path[4] === 'tasks' &&
      path[6] === 'preview'
    ) {
      const sessionId = requirePathSegment(path, 3)
      const taskId = requirePathSegment(path, 5)
      await requireTaskOwnership(input.courseRepository, sessionId, taskId, principal.courseId)
      const preview = await parseJsonRequest(request, previewSentenceOutputRequestSchema)

      return apiOk(
        await input.courseRuntime.previewSentenceOutput({ sessionId, taskId, preview }),
      )
    }

    if (
      request.method === 'POST' &&
      path.length === 7 &&
      path[2] === 'lessons' &&
      path[4] === 'tasks' &&
      path[6] === 'answer'
    ) {
      const sessionId = requirePathSegment(path, 3)
      const taskId = requirePathSegment(path, 5)
      await requireTaskOwnership(input.courseRepository, sessionId, taskId, principal.courseId)
      const submission = await parseJsonRequest(request, submitTaskAnswerRequestSchema)

      const result = await input.courseRuntime.submitAnswer({ sessionId, taskId, submission })

      return apiOk(taskAnswerResultSchema.parse(toTaskAnswerResult(taskId, result)))
    }

    if (
      request.method === 'POST' &&
      path.length === 5 &&
      path[2] === 'lessons' &&
      path[4] === 'complete'
    ) {
      const sessionId = requirePathSegment(path, 3)
      await requireSessionOwnership(input.courseRepository, sessionId, principal.courseId)

      return apiOk(await input.courseRuntime.completeLesson(sessionId))
    }

    return notFound()
  }

  return notFound()
}

const createAccessAuthenticator = (env: WorkerEnv): AdminAuthenticator | undefined => {
  if (!env.CF_ACCESS_ISSUER || !env.CF_ACCESS_AUDIENCE) return undefined

  return createCloudflareAccessAuthenticator({
    issuer: env.CF_ACCESS_ISSUER,
    audience: env.CF_ACCESS_AUDIENCE,
  })
}

const readAdminAuthConfig = (encoded: string | undefined): AdminAuthConfig | undefined => {
  if (!encoded) return undefined
  try {
    return parseAdminAuthConfig(encoded)
  } catch {
    return undefined
  }
}

const parseAdminBrowserAuthMode = (
  value: string | undefined,
): 'application_session' | 'cloudflare_access' => {
  if (!value || value === 'application_session') return 'application_session'
  if (value === 'cloudflare_access') return 'cloudflare_access'
  throw new Error('ADMIN_BROWSER_AUTH_MODE is invalid')
}

const requireCourseOwnership = (requestedCourseId: string, principalCourseId: string): void => {
  if (requestedCourseId !== principalCourseId) {
    throw new DomainError('forbidden_resource', 'Course access is forbidden')
  }
}

const requireSessionOwnership = async (
  repository: CourseRepository,
  sessionId: string,
  courseId: string,
) => {
  const session = await repository.getLessonSessionForCourse({ sessionId, courseId })

  if (!session) throw new DomainError('forbidden_resource', 'Lesson access is forbidden')

  return session
}

const requireTaskOwnership = async (
  repository: CourseRepository,
  sessionId: string,
  taskId: string,
  courseId: string,
): Promise<void> => {
  await requireSessionOwnership(repository, sessionId, courseId)
  const task = await repository.getLessonTaskForResource({ sessionId, taskId, courseId })

  if (!task) throw new DomainError('forbidden_resource', 'Task access is forbidden')
}

const requirePathSegment = (path: string[], index: number): string => {
  const segment = path[index]

  if (!segment) throw new DomainError('not_found', 'Route parameter is missing')

  return segment
}

const toAdminSession = (identity: AdminIdentity) => {
  const fallbackDisplayName =
    identity.source === 'service_token'
      ? '运维服务'
      : identity.source === 'cloudflare_access'
        ? 'Cloudflare Access 管理员'
        : '管理员'
  const accessEmail =
    identity.source === 'cloudflare_access' &&
    identity.email &&
    adminSessionSchema.shape.email.safeParse(identity.email).success
      ? identity.email
      : undefined
  const displayNameCandidates =
    identity.source === 'application_session'
      ? [identity.displayName, fallbackDisplayName]
      : identity.source === 'cloudflare_access'
        ? [accessEmail, identity.subject, fallbackDisplayName]
        : [fallbackDisplayName]
  let displayName = fallbackDisplayName

  for (const candidate of displayNameCandidates) {
    if (!candidate) continue
    const parsed = adminSessionSchema.shape.displayName.safeParse(
      Array.from(candidate.trim()).slice(0, 64).join(''),
    )
    if (parsed.success) {
      displayName = parsed.data
      break
    }
  }

  const base = adminSessionSchema.parse({
    id: identity.subject.trim() || `${identity.source}-administrator`,
    source: identity.source,
    displayName,
  })
  return accessEmail ? adminSessionSchema.parse({ ...base, email: accessEmail }) : base
}

const toCourseView = (course: CourseRecord) => ({
  id: course.id,
  learnerId: course.learnerId,
  sourceVersionId: course.sourceVersionId,
  currentLessonNo: getCourseRunLessonNo(course),
  status: course.status,
})

const toTaskAnswerResult = (taskId: string, result: SubmittedTaskAnswer) => ({
  taskId,
  score: result.reviewLog.score,
  correct: isPassingReviewScore(result.reviewLog.score),
  feedback: result.feedback,
})

const notFound = (): Response =>
  apiJson(
    {
      ok: false,
      error: { code: 'not_found', message: 'Route not found' },
    },
    404,
  )

const fetchAdminAsset = async (
  request: Request,
  assets: CreateWorkerAppInput['assets'],
): Promise<Response> => {
  if (!assets) return notFound()
  const response = await assets.fetch(request)
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const redirectToAdminLogin = (request: Request, clearCookie: boolean): Response => {
  const url = new URL(request.url)
  const returnTo = `${url.pathname}${url.search}`
  const headers = new Headers({
    'cache-control': 'no-store',
    location: `/admin/login?returnTo=${encodeURIComponent(returnTo)}`,
  })
  if (clearCookie) headers.set('set-cookie', clearAdminSessionCookie())
  return new Response(null, { status: 302, headers })
}

const isAdminDocumentAuthenticationError = (error: unknown): boolean =>
  isDomainError(error) &&
  (error.code === 'admin_session_required' ||
    error.code === 'admin_session_expired' ||
    error.code === 'admin_session_revoked' ||
    error.code === 'admin_identity_invalid' ||
    error.code === 'admin_disabled')
