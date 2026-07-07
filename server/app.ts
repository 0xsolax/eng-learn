import { ZodError } from 'zod'
import type { z } from 'zod'
import {
  createCourseRequestSchema,
  enterCourseByAccessCodeRequestSchema,
  importSourceVersionRequestSchema,
  submitAnswerRequestSchema,
  type ApiSuccess,
} from '../shared/api/schemas'
import { createInMemoryContentRepository } from './repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from './repositories/inMemoryCourseRepository'
import { createD1ContentRepository } from './repositories/d1ContentRepository'
import { createD1CourseRepository } from './repositories/d1CourseRepository'
import { createContentBuilder, type ContentBuilder } from './services/ContentBuilder'
import { createCourseRuntime, type CourseRuntime } from './services/CourseRuntime'
import type { ImportWordInput } from '../shared/domain/content'

export type WorkerApp = {
  fetch(request: Request): Promise<Response>
}

export type WorkerEnv = {
  DB: D1Database
  ADMIN_API_TOKEN?: string
}

export type CreateWorkerAppInput = {
  contentBuilder: ContentBuilder
  courseRuntime: CourseRuntime
  adminToken?: string
}

export const createWorkerApp = ({
  contentBuilder,
  courseRuntime,
  adminToken,
}: CreateWorkerAppInput): WorkerApp => ({
  async fetch(request: Request): Promise<Response> {
    try {
      return await routeRequest(request, contentBuilder, courseRuntime, adminToken)
    } catch (error) {
      return toErrorResponse(error)
    }
  },
})

export const createTestWorkerApp = (input: { adminToken?: string } = {}): WorkerApp => {
  const now = () => new Date('2026-07-06T00:00:00.000Z')
  const contentRepository = createInMemoryContentRepository()
  const courseRepository = createInMemoryCourseRepository()

  return createWorkerApp({
    contentBuilder: createContentBuilder({
      repository: contentRepository,
      now,
    }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      now,
    }),
    ...(input.adminToken ? { adminToken: input.adminToken } : {}),
  })
}

export const createDefaultWorkerApp = (env: WorkerEnv): WorkerApp => {
  const now = () => new Date()
  const contentRepository = createD1ContentRepository(env.DB)
  const courseRepository = createD1CourseRepository(env.DB)

  return createWorkerApp({
    contentBuilder: createContentBuilder({
      repository: contentRepository,
      now,
    }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      now,
    }),
    ...(env.ADMIN_API_TOKEN ? { adminToken: env.ADMIN_API_TOKEN } : {}),
  })
}

const routeRequest = async (
  request: Request,
  contentBuilder: ContentBuilder,
  courseRuntime: CourseRuntime,
  adminToken: string | undefined,
): Promise<Response> => {
  const url = new URL(request.url)
  const path = url.pathname.split('/').filter(Boolean)
  const isAdminPath = path[0] === 'api' && path[1] === 'admin'

  if (isAdminPath) {
    requireAdmin(request, adminToken)
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/health') {
    return ok({ scope: 'admin' })
  }

  if (request.method === 'GET' && url.pathname === '/api/app/health') {
    return ok({ scope: 'app' })
  }

  if (
    request.method === 'POST' &&
    path.length === 4 &&
    path[0] === 'api' &&
    path[1] === 'admin' &&
    path[2] === 'source-versions' &&
    path[3] === 'import'
  ) {
    const input = await parseJson(request, importSourceVersionRequestSchema)

    return ok(
      await contentBuilder.importWords({
        sourceName: input.sourceName,
        words: toImportWords(input.words),
      }),
    )
  }

  if (
    request.method === 'POST' &&
    path.length === 5 &&
    path[0] === 'api' &&
    path[1] === 'admin' &&
    path[2] === 'source-versions' &&
    path[4] === 'build'
  ) {
    return ok(await contentBuilder.buildExerciseItems(path[3] ?? ''))
  }

  if (
    request.method === 'POST' &&
    path.length === 5 &&
    path[0] === 'api' &&
    path[1] === 'admin' &&
    path[2] === 'source-versions' &&
    path[4] === 'publish'
  ) {
    return ok(await contentBuilder.publishVersion(path[3] ?? ''))
  }

  if (
    request.method === 'POST' &&
    path.length === 3 &&
    path[0] === 'api' &&
    path[1] === 'admin' &&
    path[2] === 'courses'
  ) {
    const input = await parseJson(request, createCourseRequestSchema)

    return ok(await courseRuntime.createCourse(input))
  }

  if (
    request.method === 'POST' &&
    path.length === 4 &&
    path[0] === 'api' &&
    path[1] === 'app' &&
    path[2] === 'session' &&
    path[3] === 'by-code'
  ) {
    const input = await parseJson(request, enterCourseByAccessCodeRequestSchema)

    return ok(await courseRuntime.enterCourseByAccessCode(input.accessCode))
  }

  if (
    request.method === 'POST' &&
    path.length === 6 &&
    path[0] === 'api' &&
    path[1] === 'app' &&
    path[2] === 'courses' &&
    path[4] === 'lessons' &&
    path[5] === 'start'
  ) {
    return ok(await courseRuntime.startLesson(path[3] ?? ''))
  }

  if (
    request.method === 'POST' &&
    path.length === 7 &&
    path[0] === 'api' &&
    path[1] === 'app' &&
    path[2] === 'lessons' &&
    path[4] === 'tasks' &&
    path[6] === 'answer'
  ) {
    const input = await parseJson(request, submitAnswerRequestSchema)

    return ok(
      await courseRuntime.submitAnswer({
        sessionId: path[3] ?? '',
        taskId: path[5] ?? '',
        userAnswer: input.userAnswer,
      }),
    )
  }

  if (
    request.method === 'POST' &&
    path.length === 5 &&
    path[0] === 'api' &&
    path[1] === 'app' &&
    path[2] === 'lessons' &&
    path[4] === 'complete'
  ) {
    return ok(await courseRuntime.completeLesson(path[3] ?? ''))
  }

  return json(
    {
      ok: false,
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    },
    404,
  )
}

const requireAdmin = (request: Request, adminToken: string | undefined): void => {
  if (!adminToken) {
    throw new ApiHttpError(403, 'admin_disabled', 'Admin API is not configured')
  }

  if (request.headers.get('x-admin-token') !== adminToken) {
    throw new ApiHttpError(401, 'unauthorized', 'Admin authorization is required')
  }
}

const parseJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> => {
  let payload: unknown

  try {
    payload = await request.json()
  } catch {
    throw new ApiHttpError(400, 'bad_request', 'Request body must be valid JSON')
  }

  try {
    return schema.parse(payload)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiHttpError(400, 'bad_request', error.issues[0]?.message ?? 'Invalid request')
    }

    throw error
  }
}

const toImportWords = (words: Array<z.infer<typeof importSourceVersionRequestSchema>['words'][number]>): ImportWordInput[] =>
  words.map((word) => ({
    word: word.word,
    meaning: word.meaning,
    exampleSentence: word.exampleSentence,
    ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech } : {}),
  }))

const ok = (data: unknown): Response => json({ ok: true, data } satisfies ApiSuccess<unknown>, 200)

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })

class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const toErrorResponse = (error: unknown): Response => {
  if (error instanceof ApiHttpError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      error.status,
    )
  }

  const message = error instanceof Error ? error.message : 'Unexpected server error'

  return json(
    {
      ok: false,
      error: {
        code: 'conflict',
        message,
      },
    },
    409,
  )
}
