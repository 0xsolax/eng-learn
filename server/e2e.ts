import { createWorkerApp, type WorkerApp } from './app'
import { createD1ContentRepository } from './repositories/d1ContentRepository'
import { createD1CourseRepository } from './repositories/d1CourseRepository'
import { createD1SessionRepository } from './repositories/d1SessionRepository'
import { createD1AdminSessionRepository } from './repositories/d1AdminSessionRepository'
import { createContentBuilder } from './services/ContentBuilder'
import { createCourseRuntime } from './services/CourseRuntime'
import { createCourseQueryService } from './services/CourseQueryService'
import { createLearnerSessionService } from './services/LearnerSessionService'
import { createAdminSessionService } from './services/AdminSessionService'
import { parseAdminAuthConfig } from './security/adminCredential'
import { createD1AdminOperationLedger } from './repositories/adminOperationLedger'

type E2EEnv = {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  APP_ORIGIN: string
  E2E_ENVIRONMENT: string
  E2E_RUN_ID: string
  ADMIN_AUTH_CONFIG: string
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

    if (url.pathname === '/api/e2e/import-evidence') {
      const sourceId = url.searchParams.get('sourceId')

      if (url.searchParams.has('sourceId') && !sourceId) {
        return Response.json(
          { ok: false, error: { code: 'validation_error', message: 'sourceId is required' } },
          { status: 400 },
        )
      }

      return Response.json(
        { ok: true, data: await readImportEvidence(env.DB, sourceId ?? undefined) },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    if (url.pathname === '/api/e2e/review-runtime-evidence') {
      return Response.json(
        { ok: true, data: await readReviewRuntimeEvidence(env.DB) },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    if (!application || applicationRunId !== env.E2E_RUN_ID) {
      application = createE2EApplication(env)
      applicationRunId = env.E2E_RUN_ID
    }

    return application.fetch(request)
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

const readImportEvidence = async (db: D1Database, sourceId?: string) => {
  if (!sourceId) {
    const [sourceCount, versionCount, wordCount, groupCount, operationCount] =
      await Promise.all([
        countRows(db, 'SELECT COUNT(*) AS row_count FROM word_sources'),
        countRows(db, 'SELECT COUNT(*) AS row_count FROM source_versions'),
        countRows(db, 'SELECT COUNT(*) AS row_count FROM words'),
        countRows(db, 'SELECT COUNT(*) AS row_count FROM word_groups'),
        countRows(
          db,
          "SELECT COUNT(*) AS row_count FROM admin_operations WHERE kind = 'create_source'",
        ),
      ])

    return { sourceCount, versionCount, wordCount, groupCount, operationCount }
  }

  const [sourceCount, versionCount, wordCount, groupCount, operationCount] =
    await Promise.all([
      countRows(db, 'SELECT COUNT(*) AS row_count FROM word_sources WHERE id = ?', sourceId),
      countRows(
        db,
        'SELECT COUNT(*) AS row_count FROM source_versions WHERE source_id = ?',
        sourceId,
      ),
      countRows(
        db,
        'SELECT COUNT(*) AS row_count FROM words WHERE source_version_id IN (SELECT id FROM source_versions WHERE source_id = ?)',
        sourceId,
      ),
      countRows(
        db,
        'SELECT COUNT(*) AS row_count FROM word_groups WHERE source_version_id IN (SELECT id FROM source_versions WHERE source_id = ?)',
        sourceId,
      ),
      countRows(
        db,
        "SELECT COUNT(*) AS row_count FROM admin_operations WHERE kind = 'create_source' AND outcome_source_id = ?",
        sourceId,
      ),
    ])

  return { sourceCount, versionCount, wordCount, groupCount, operationCount }
}

const countRows = async (db: D1Database, query: string, ...bindings: unknown[]) => {
  const statement = bindings.length > 0 ? db.prepare(query).bind(...bindings) : db.prepare(query)
  const row = await statement.first<{ row_count: number }>()

  return row?.row_count ?? 0
}

const readReviewRuntimeEvidence = async (db: D1Database) => {
  const [courses, lessonSessions, lessonTasks, reviewLogs, userWordStates] =
    await Promise.all([
      readOrderedRows(db, 'courses'),
      readOrderedRows(db, 'lesson_sessions'),
      readOrderedRows(db, 'lesson_tasks'),
      readOrderedRows(db, 'review_logs'),
      readOrderedRows(db, 'user_word_states'),
    ])

  return { courses, lessonSessions, lessonTasks, reviewLogs, userWordStates }
}

const readOrderedRows = async (db: D1Database, table: string) => {
  const result = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()

  return result.results
}

const createE2EApplication = (env: E2EEnv): WorkerApp => {
  const now = () => new Date()
  const operationLedger = createD1AdminOperationLedger(env.DB)
  const contentRepository = createD1ContentRepository(env.DB)
  const courseRepository = createD1CourseRepository(env.DB)
  const sessionRepository = createD1SessionRepository(env.DB)
  const adminSessionRepository = createD1AdminSessionRepository(env.DB)
  const adminSessionService = createAdminSessionService({
    sessionRepository: adminSessionRepository,
    rateLimitRepository: adminSessionRepository,
    config: parseAdminAuthConfig(env.ADMIN_AUTH_CONFIG),
    now,
  })

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
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger,
      now,
    }),
    adminAuthentication: {
      applicationSessionService: adminSessionService,
      allowedOrigin: env.APP_ORIGIN,
      browserMode: 'application_session',
    },
    assets: env.ASSETS,
  })
}
