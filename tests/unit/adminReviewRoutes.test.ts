import { describe, expect, it } from 'vitest'
import { routeAdminContentRequest } from '../../server/http/adminRoutes'
import { toApiErrorResponse } from '../../server/http/apiResponse'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'
import { exerciseReviewWindowSchema } from '../../shared/api/contentSchemas'
import { apiResponseSchema } from '../../shared/api/schemas'

const ORIGIN = 'https://eng-learn.test'

describe('admin exercise review routes', () => {
  it('reads prompt-only content, evaluates, previews S5, and approves without app routes', async () => {
    const builder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-17T01:02:03.000Z'),
    })
    const draft = await builder.importNewSourceIdempotently({
      operationToken: generateAdminOperationToken(),
      sourceName: 'Route review source',
      words: Array.from({ length: 5 }, (_, index) => ({
        word: `word-${String(index + 1)}`,
        meaning: `meaning-${String(index + 1)}`,
        examplePhrase: `word-${String(index + 1)}`,
        exampleSentence: `I use word-${String(index + 1)}.`,
        exampleSentenceExtended: `I can use word-${String(index + 1)} every day.`,
      })),
    })
    await builder.buildExerciseItems(draft.versionId)

    const firstResponse = await fetchRoute(
      builder,
      `/api/admin/source-versions/${draft.versionId}/review`,
    )
    const firstPayload = apiResponseSchema(exerciseReviewWindowSchema).parse(
      await firstResponse.json(),
    )
    expect(firstResponse.status).toBe(200)
    expect(firstPayload.ok).toBe(true)
    if (!firstPayload.ok) throw new Error('Expected successful review response')
    expect(JSON.stringify(firstPayload)).not.toContain('"answer"')
    const itemId = firstPayload.data.current?.id
    if (!itemId) throw new Error('Expected first review item')

    const evaluateResponse = await fetchRoute(
      builder,
      `/api/admin/exercise-items/${itemId}/review/evaluate`,
      {
        expectedContentRevision: firstPayload.data.contentRevision,
        submission: { taskType: 'recognize_meaning', response: 'known' },
      },
    )
    expect(evaluateResponse.status).toBe(200)
    await expect(evaluateResponse.json()).resolves.toMatchObject({
      ok: true,
      data: { exerciseItemId: itemId, score: 2, correct: true },
    })

    const s5 = (await builder.listExerciseItems(draft.versionId)).find(
      (item) => item.word === 'word-1' && item.taskType === 'sentence_output',
    )
    if (!s5) throw new Error('Expected S5 review item')
    const previewResponse = await fetchRoute(
      builder,
      `/api/admin/exercise-items/${s5.id}/review/preview`,
      {
        expectedContentRevision: firstPayload.data.contentRevision,
        taskType: 'sentence_output',
        draft: 'I wrote a sentence.',
      },
    )
    expect(previewResponse.status).toBe(200)
    await expect(previewResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        exerciseItemId: s5.id,
        referenceSentence: 'I can use word-1 every day.',
      },
    })

    const decisionResponse = await fetchRoute(
      builder,
      `/api/admin/exercise-items/${itemId}/review/decision`,
      { action: 'approve', expectedContentRevision: firstPayload.data.contentRevision },
    )
    expect(decisionResponse.status).toBe(200)
    await expect(decisionResponse.json()).resolves.toMatchObject({
      ok: true,
      data: { action: 'approve', status: 'approved', contentRevision: 2 },
    })
  })
})

const fetchRoute = async (
  builder: ReturnType<typeof createContentBuilder>,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const request = new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })

  try {
    return (
      (await routeAdminContentRequest(request, new URL(request.url), builder)) ??
      new Response(null, { status: 404 })
    )
  } catch (error) {
    return toApiErrorResponse(error)
  }
}
