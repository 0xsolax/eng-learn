import { createWorkerApp, type WorkerApp } from './app'
import { createD1ContentRepository } from './repositories/d1ContentRepository'
import { createD1CourseRepository } from './repositories/d1CourseRepository'
import { createD1SessionRepository } from './repositories/d1SessionRepository'
import { createContentBuilder } from './services/ContentBuilder'
import { createCourseRuntime } from './services/CourseRuntime'
import { createCourseQueryService } from './services/CourseQueryService'
import { createLearnerSessionService } from './services/LearnerSessionService'
import type { AdminAuthenticator } from './security/adminAuthentication'
import { createD1AdminOperationLedger } from './repositories/adminOperationLedger'

type E2EEnv = {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  APP_ORIGIN: string
  E2E_ENVIRONMENT: string
  E2E_RUN_ID: string
}

let application: WorkerApp | undefined
let applicationRunId: string | undefined

export default {
  async fetch(request: Request, env: E2EEnv): Promise<Response> {
    if (!isLocalE2ERequest(request, env)) {
      return disabledResponse()
    }

    const url = new URL(request.url)
    const sentinelMatches = await hasMatchingDatabaseSentinel(env)

    if (!sentinelMatches) {
      return disabledResponse()
    }

    if (url.pathname === '/api/e2e/identity') {
      return Response.json(
        {
          ok: true,
          data: {
            workerName: 'eng-learn-e2e-local',
            environment: env.E2E_ENVIRONMENT,
            dbSentinel: env.E2E_RUN_ID,
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    if (!application || applicationRunId !== env.E2E_RUN_ID) {
      application = createE2EApplication(env)
      applicationRunId = env.E2E_RUN_ID
    }

    return application.fetch(withControlledAdminIdentity(request))
  },
} satisfies ExportedHandler<E2EEnv>

const disabledResponse = (): Response =>
  Response.json(
    { ok: false, error: { code: 'dependency_failure', message: 'E2E environment is disabled' } },
    { status: 503 },
  )

const isLocalE2ERequest = (request: Request, env: E2EEnv): boolean => {
  if (env.E2E_ENVIRONMENT !== 'local-e2e' || env.E2E_RUN_ID.length === 0) {
    return false
  }

  const url = new URL(request.url)

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return false
  }

  try {
    return new URL(env.APP_ORIGIN).origin === url.origin
  } catch {
    return false
  }
}

const hasMatchingDatabaseSentinel = async (env: E2EEnv): Promise<boolean> => {
  try {
    const row = await env.DB
      .prepare("SELECT value FROM e2e_guard WHERE key = 'db_sentinel'")
      .first<{ value: string }>()

    return row?.value === env.E2E_RUN_ID
  } catch {
    return false
  }
}

const createE2EApplication = (env: E2EEnv): WorkerApp => {
  const now = () => new Date()
  const operationLedger = createD1AdminOperationLedger(env.DB)
  const contentRepository = createD1ContentRepository(env.DB)
  const courseRepository = createD1CourseRepository(env.DB)
  const sessionRepository = createD1SessionRepository(env.DB)
  const accessAuthenticator: AdminAuthenticator = {
    authenticate: () =>
      Promise.resolve({
        source: 'cloudflare_access',
        subject: 'e2e-admin',
        email: 'e2e-admin@example.test',
      }),
  }

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
    }),
    courseQueryService: createCourseQueryService({ contentRepository, courseRepository }),
    courseRepository,
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger,
      now,
    }),
    adminAuthentication: {
      accessAuthenticator,
      allowedOrigin: env.APP_ORIGIN,
    },
    assets: env.ASSETS,
  })
}

const withControlledAdminIdentity = (request: Request): Request => {
  const path = new URL(request.url).pathname

  if (!path.startsWith('/admin') && !path.startsWith('/api/admin/')) return request

  const headers = new Headers(request.headers)
  headers.set('cf-access-jwt-assertion', 'controlled-local-e2e-identity')

  return new Request(request, { headers })
}
