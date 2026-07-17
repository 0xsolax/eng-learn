import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestWorkerApp, type WorkerApp } from '../../server/app'
import { routeAdminContentRequest } from '../../server/http/adminRoutes'
import { toApiErrorResponse } from '../../server/http/apiResponse'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createContentBuilder, type ContentBuilder } from '../../server/services/ContentBuilder'
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

  it('fails closed at edit, approve, coverage and publish boundaries for S5 owning-word leaks', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-13T00:00:00.000Z'),
    })
    const app = createAdminContentBoundaryApp(contentBuilder)
    const sourceWords = words(5)

    sourceWords[0] = {
      word: 'apple',
      meaning: '苹果',
      examplePhrase: 'an apple',
      exampleSentence: 'I ate an apple.',
      exampleSentenceExtended: 'I ate an apple after lunch.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'S5 owning-word boundary source',
      words: sourceWords,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)
    const item = items.find(
      (candidate) => candidate.word === 'apple' && candidate.taskType === 'sentence_output',
    )

    if (!item) throw new Error('Expected an S5 exercise item')

    const editResponse = await app.fetch(
      request(`/api/admin/exercise-items/${item.id}`, {
        method: 'PUT',
        body: {
          content: {
            stage: 'S5',
            taskType: 'sentence_output',
            prompt: {
              meaning: '请使用 ap\u200Bple 完成一句话',
              instruction: 'Write one complete English sentence.',
            },
            answer: { referenceSentence: 'I ate an apple.' },
          },
        },
      }),
    )
    const editPayload = await editResponse.json()

    expect(editResponse.status).toBe(400)
    expect(editPayload).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    })
    expect(JSON.stringify(editPayload)).not.toContain('ap\u200Bple')
    expect(await contentBuilder.getExerciseItem(item.id)).toEqual(item)

    await contentBuilder.approveExerciseItems(
      items.filter((candidate) => candidate.id !== item.id).map((candidate) => candidate.id),
    )

    let snapshot = await repository.getSourceVersion(draft.versionId)
    let storedItem = await repository.getExerciseItem(item.id)

    if (!snapshot || !storedItem) throw new Error('Expected the stored S5 exercise item')

    await repository.updateExerciseItems(
      draft.versionId,
      [
        {
          ...storedItem,
          prompt: {
            meaning: '苹果',
            instruction: 'Write one sentence with ａｐｐｌｅ.',
          },
        },
      ],
      snapshot.version.contentRevision,
    )

    const approveResponse = await app.fetch(
      request(`/api/admin/exercise-items/${item.id}/approve`, { method: 'POST' }),
    )
    const approvePayload = await approveResponse.json()

    expect(approveResponse.status).toBe(400)
    expect(approvePayload).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    })
    expect(JSON.stringify(approvePayload)).not.toContain('ａｐｐｌｅ')

    const coverage = await success(
      await app.fetch(request(`/api/admin/source-versions/${draft.versionId}/coverage`)),
      buildCoverageSchema,
    )

    expect(coverage.cells).toContainEqual(
      expect.objectContaining({
        word: 'apple',
        stage: 'S5',
        taskType: 'sentence_output',
        status: 'draft',
        reason: 'exercise_item_invalid',
      }),
    )

    snapshot = await repository.getSourceVersion(draft.versionId)
    storedItem = await repository.getExerciseItem(item.id)

    if (!snapshot || !storedItem) throw new Error('Expected the stored S5 exercise item')

    await repository.updateExerciseItems(
      draft.versionId,
      [{ ...storedItem, status: 'approved' }],
      snapshot.version.contentRevision,
    )

    const publishResponse = await app.fetch(
      request(`/api/admin/source-versions/${draft.versionId}/publish`, { method: 'POST' }),
    )
    const publishPayload = await publishResponse.json()

    expect(publishResponse.status).toBe(409)
    expect(publishPayload).toMatchObject({
      ok: false,
      error: { code: 'coverage_incomplete' },
    })
    expect((await repository.getSourceVersion(draft.versionId))?.version.status).toBe('draft')
  })
})

const createAdminTestApp = (): WorkerApp =>
  createTestWorkerApp({
    adminIdentity: { id: 'admin-1', email: 'admin@example.test' },
    allowedOrigin: ORIGIN,
  })

const createAdminContentBoundaryApp = (contentBuilder: ContentBuilder): WorkerApp => ({
  async fetch(request) {
    try {
      return (
        (await routeAdminContentRequest(request, new URL(request.url), contentBuilder)) ??
        new Response(null, { status: 404 })
      )
    } catch (error) {
      return toApiErrorResponse(error)
    }
  },
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
    examplePhrase: `word-${String(index + 1)}`,
    exampleSentence: `I use word-${String(index + 1)} here.`,
    exampleSentenceExtended: `I use word-${String(index + 1)} here every day.`,
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
