import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DomainError } from '../../server/errors/DomainError'
import { toApiErrorResponse } from '../../server/http/apiResponse'

describe('API error responses', () => {
  it('treats an uncaught Zod error as an internal output-contract failure', async () => {
    const schema = z.object({ words: z.array(z.object({ meaning: z.string().min(1) })) })
    const result = schema.safeParse({ words: [{ meaning: '' }] })

    if (result.success) throw new Error('Expected validation to fail')
    const response = toApiErrorResponse(result.error)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Unexpected server error',
      },
    })
  })

  it('preserves validated lesson blockers while mapping the status', async () => {
    const response = toApiErrorResponse(
      new DomainError('lesson_incomplete', 'Required practice remains', {
        completedPrimary: 5,
        totalPrimary: 5,
        pendingRequiredTaskIds: ['reflux-1'],
      }),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'lesson_incomplete',
        details: { pendingRequiredTaskIds: ['reflux-1'] },
      },
    })
  })

  it('maps an unfinished report to a stable conflict response', async () => {
    const response = toApiErrorResponse(
      new DomainError('report_unavailable', 'Lesson report is not available'),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'report_unavailable' },
    })
  })

  it('maps writes against a closed lesson to a stable conflict response', async () => {
    const response = toApiErrorResponse(
      new DomainError('lesson_not_active', 'Lesson session is not active'),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'lesson_not_active' },
    })
  })

  it('maps bounded-body rejection to HTTP 413', async () => {
    const response = toApiErrorResponse(
      new DomainError('payload_too_large', 'Request body exceeds the allowed size'),
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'payload_too_large' },
    })
  })

  it('never exposes unknown error messages or invalid declared details', async () => {
    const databaseResponse = toApiErrorResponse(
      new Error('D1_ERROR: UNIQUE constraint failed: learner_sessions.token_hash'),
    )
    const invalidDetailsResponse = toApiErrorResponse(
      new DomainError('lesson_incomplete', 'Internal bad shape', {
        pendingRequiredTaskIds: 'secret-resource-id',
      }),
    )
    const databaseBody = await databaseResponse.text()
    const detailsBody = await invalidDetailsResponse.text()

    expect(databaseResponse.status).toBe(500)
    expect(invalidDetailsResponse.status).toBe(500)
    expect(databaseBody).toContain('internal_error')
    expect(databaseBody).not.toContain('learner_sessions')
    expect(detailsBody).not.toContain('secret-resource-id')
  })
})
