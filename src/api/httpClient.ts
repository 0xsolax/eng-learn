import { z } from 'zod'
import { apiErrorSchema } from '@shared/api/schemas'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from './errors'

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpRequestOptions<TSchema extends z.ZodType> = {
  dataSchema: TSchema
  method?: HttpMethod
  json?: unknown
  signal?: AbortSignal
}

export const createHttpClient = (fetchImpl: FetchImplementation = fetch) => ({
  async request<TSchema extends z.ZodType>(
    path: string,
    options: HttpRequestOptions<TSchema>,
  ): Promise<z.output<TSchema>> {
    const headers: Record<string, string> = {
      'x-requested-with': 'XMLHttpRequest',
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
    }
    const requestInit: RequestInit = {
      credentials: 'same-origin',
      headers,
      method: options.method ?? 'GET',
      ...(options.json === undefined
        ? {}
        : {
            body: JSON.stringify(options.json),
          }),
      ...(options.signal ? { signal: options.signal } : {}),
    }

    let response: Response
    try {
      response = await fetchImpl(path, requestInit)
    } catch (cause) {
      throw new ApiNetworkError(cause)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new InvalidApiResponseError(response.status, cause)
    }

    const envelope = z.looseObject({ ok: z.boolean() }).safeParse(payload)
    if (!envelope.success) {
      throw new InvalidApiResponseError(response.status, envelope.error)
    }

    if (!envelope.data.ok) {
      const failure = z
        .object({ ok: z.literal(false), error: apiErrorSchema })
        .strict()
        .safeParse(payload)
      if (!failure.success) {
        throw new InvalidApiResponseError(response.status, failure.error)
      }
      throw new ApiFailureError(response.status, failure.data.error)
    }

    if (!response.ok) {
      throw new InvalidApiResponseError(response.status)
    }

    const successEnvelope = z
      .object({ ok: z.literal(true), data: z.unknown() })
      .strict()
      .safeParse(payload)
    if (!successEnvelope.success) {
      throw new InvalidApiResponseError(response.status, successEnvelope.error)
    }

    const data = options.dataSchema.safeParse(successEnvelope.data.data)
    if (!data.success) {
      throw new InvalidApiResponseError(response.status, data.error)
    }

    return data.data
  },
})
