import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'
import {
  adminExerciseItemListSchema,
  buildCoverageSchema,
  importedSourceVersionSchema,
  sourceVersionListSchema,
} from '../../shared/api/contentSchemas'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const ORIGIN = 'https://eng-learn.test'

describe('worker admin content lifecycle contract', () => {
  it('keeps build items draft until explicit approval and makes publish immutable', async () => {
    const app = createAdminTestApp()
    const imported = await success(
      await app.fetch(
        request('/api/admin/source-versions/import', {
          method: 'POST',
          body: {
            mode: 'new_source',
            operationToken: generateAdminOperationToken(),
            sourceName: 'Lifecycle source',
            words: words(5),
          },
        }),
      ),
      importedSourceVersionSchema,
    )

    const built = await success(
      await app.fetch(
        request(`/api/admin/source-versions/${imported.versionId}/build`, { method: 'POST' }),
      ),
      buildCoverageSchema,
    )
    expect(built.readyToPublish).toBe(false)
    expect(built.missingItems.every((item) => item.reason === 'exercise_item_draft')).toBe(true)

    const exerciseItems = await success(
      await app.fetch(request(`/api/admin/source-versions/${imported.versionId}/exercises`)),
      adminExerciseItemListSchema,
    )
    expect(exerciseItems).toHaveLength(30)

    await success(
      await app.fetch(
        request('/api/admin/exercise-items/batch-approve', {
          method: 'POST',
          body: { itemIds: exerciseItems.map((item) => item.id) },
        }),
      ),
      z.object({ approvedCount: z.number().int().positive() }).strict(),
    )
    const coverage = await success(
      await app.fetch(request(`/api/admin/source-versions/${imported.versionId}/coverage`)),
      buildCoverageSchema,
    )
    expect(coverage.readyToPublish).toBe(true)

    await success(
      await app.fetch(
        request(`/api/admin/source-versions/${imported.versionId}/publish`, { method: 'POST' }),
      ),
      z.object({ sourceVersionId: z.string(), status: z.literal('published') }).strict(),
    )
    const editAfterPublish = await app.fetch(
      request(`/api/admin/exercise-items/${exerciseItems[0]?.id ?? ''}`, {
        method: 'PUT',
        body: {
          content: {
            stage: 'S0',
            taskType: 'recognize_meaning',
            prompt: { word: 'changed', meaning: 'changed', exampleSentence: '' },
            answer: { word: 'changed', expectedResponse: 'known' },
          },
        },
      }),
    )

    expect(editAfterPublish.status).toBe(409)
    await expect(errorCode(editAfterPublish)).resolves.toBe('source_version_immutable')
  })

  it('requires explicit next-version intent and allows a discarded draft to be replaced', async () => {
    const app = createAdminTestApp()
    const first = await importVersion(app, {
      mode: 'new_source',
      sourceName: 'Versioned source',
      words: words(3),
    })
    await publishFixtureVersion(app, first.versionId)
    const second = await importVersion(app, {
      mode: 'next_version',
      sourceId: first.sourceId,
      words: words(3),
    })

    expect(second.versionNo).toBe(2)
    const duplicateDraft = await app.fetch(
      request('/api/admin/source-versions/import', {
        method: 'POST',
        body: { mode: 'next_version', sourceId: first.sourceId, words: words(3) },
      }),
    )
    expect(duplicateDraft.status).toBe(409)
    await expect(errorCode(duplicateDraft)).resolves.toBe('source_draft_exists')

    await success(
      await app.fetch(
        request(`/api/admin/source-versions/${second.versionId}/discard`, { method: 'POST' }),
      ),
      z.object({ sourceVersionId: z.string(), sourceId: z.string(), status: z.literal('archived') }).strict(),
    )
    const third = await importVersion(app, {
      mode: 'next_version',
      sourceId: first.sourceId,
      words: words(3),
    })
    expect(third.versionNo).toBe(3)

    const versions = await success(
      await app.fetch(request('/api/admin/source-versions')),
      sourceVersionListSchema,
    )
    expect(versions.map((version) => version.versionNo)).toEqual([3, 2, 1])
  })
})

const createAdminTestApp = (): WorkerApp =>
  createTestWorkerApp({
    adminIdentity: { id: 'admin-1', email: 'admin@example.test' },
    allowedOrigin: ORIGIN,
  })

const importVersion = (
  app: WorkerApp,
  body:
    | { mode: 'new_source'; sourceName: string; words: ReturnType<typeof words> }
    | { mode: 'next_version'; sourceId: string; words: ReturnType<typeof words> },
) =>
  app
    .fetch(
      request('/api/admin/source-versions/import', {
        method: 'POST',
        body:
          body.mode === 'new_source'
            ? { ...body, operationToken: generateAdminOperationToken() }
            : body,
      }),
    )
    .then((response) => success(response, importedSourceVersionSchema))

const publishFixtureVersion = async (app: WorkerApp, versionId: string): Promise<void> => {
  await success(
    await app.fetch(
      request(`/api/admin/source-versions/${versionId}/build`, { method: 'POST' }),
    ),
    buildCoverageSchema,
  )
  const items = await success(
    await app.fetch(request(`/api/admin/source-versions/${versionId}/exercises`)),
    adminExerciseItemListSchema,
  )
  await success(
    await app.fetch(
      request('/api/admin/exercise-items/batch-approve', {
        method: 'POST',
        body: { itemIds: items.map((item) => item.id) },
      }),
    ),
    z.object({ approvedCount: z.number().int().positive() }).strict(),
  )
  await success(
    await app.fetch(
      request(`/api/admin/source-versions/${versionId}/publish`, { method: 'POST' }),
    ),
    z.object({ sourceVersionId: z.string(), status: z.literal('published') }).strict(),
  )
}

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    word: `word-${String(index + 1)}`,
    meaning: `meaning-${String(index + 1)}`,
    exampleSentence: `I use word-${String(index + 1)} here.`,
  }))

const request = (
  path: string,
  input: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {},
): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.method && input.method !== 'GET' ? { origin: ORIGIN } : {}),
      ...(path.startsWith('/api/admin/')
        ? { 'cf-access-jwt-assertion': 'controlled-test-assertion' }
        : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })

const success = async <TSchema extends z.ZodType>(
  response: Response,
  dataSchema: TSchema,
): Promise<z.output<TSchema>> => {
  const body = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .strict()
    .parse(await response.json())

  expect(response.status, JSON.stringify(body)).toBe(200)

  const data: z.output<TSchema> = dataSchema.parse(body.data)

  return data
}

const errorCode = async (response: Response): Promise<string> => {
  const body = z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict()
    .parse(await response.json())

  return body.error.code
}
