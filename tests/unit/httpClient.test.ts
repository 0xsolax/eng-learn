import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import { createHttpClient, type FetchImplementation } from '@/api/httpClient'

const healthSchema = z.object({ scope: z.literal('app') }).strict()

describe('http client', () => {
  it('returns schema-validated data with credentials and the Access AJAX expiry header', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json({ ok: true, data: { scope: 'app' } }),
    )
    const client = createHttpClient(fetchImpl)

    await expect(
      client.request('/api/app/health', {
        dataSchema: healthSchema,
      }),
    ).resolves.toEqual({ scope: 'app' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/app/health', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('throws a stable API failure without exposing it as invalid transport data', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: {
            code: 'not_found',
            message: 'Route not found',
          },
        },
        { status: 404 },
      ),
    )
    const client = createHttpClient(fetchImpl)

    const error = await client
      .request('/api/app/missing', { dataSchema: healthSchema })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiFailureError)
    expect(error).toMatchObject({
      kind: 'api_failure',
      status: 404,
      code: 'not_found',
    })
  })

  it('rejects a success envelope whose data violates the caller schema', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: { scope: 'admin' } }))
    const client = createHttpClient(fetchImpl)

    await expect(
      client.request('/api/app/health', { dataSchema: healthSchema }),
    ).rejects.toBeInstanceOf(InvalidApiResponseError)
  })

  it('rejects an unknown failure envelope as an invalid API response', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: {
            code: 'surprise_error',
            message: 'Unknown contract',
          },
        },
        { status: 500 },
      ),
    )
    const client = createHttpClient(fetchImpl)

    await expect(
      client.request('/api/app/health', { dataSchema: healthSchema }),
    ).rejects.toBeInstanceOf(InvalidApiResponseError)
  })

  it('distinguishes fetch rejection from API and schema failures', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockRejectedValue(new TypeError('connection unavailable'))
    const client = createHttpClient(fetchImpl)

    const error = await client
      .request('/api/app/health', { dataSchema: healthSchema })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiNetworkError)
    expect(error).toMatchObject({ kind: 'network' })
  })
})
