import type { z } from 'zod'
import { DomainError } from '../errors/DomainError'

export const MAX_JSON_REQUEST_BYTES = 256 * 1024
export const MAX_IMPORT_JSON_REQUEST_BYTES = 2 * 1024 * 1024

export const parseJsonRequest = async <TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  options: { maxBytes?: number } = {},
): Promise<z.output<TSchema>> => {
  if (!request.headers.get('content-type')?.toLocaleLowerCase().startsWith('application/json')) {
    throw new DomainError('bad_request', 'Request content type must be application/json')
  }

  const maxBytes = options.maxBytes ?? MAX_JSON_REQUEST_BYTES

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('JSON request byte limit must be a positive safe integer')
  }

  const declaredLength = Number(request.headers.get('content-length'))

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new DomainError('payload_too_large', 'Request body exceeds the allowed size')
  }

  let encodedBody: Uint8Array

  try {
    encodedBody = await readBoundedBody(request, maxBytes)
  } catch (error) {
    if (error instanceof DomainError) throw error

    throw new DomainError('bad_request', 'Request body could not be read')
  }

  let payload: unknown

  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encodedBody))
  } catch {
    throw new DomainError('bad_request', 'Request body must be valid JSON')
  }

  const result = schema.safeParse(payload)

  if (!result.success) {
    throw new DomainError('validation_error', 'Request validation failed', {
      fields: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  return result.data
}

const readBoundedBody = async (request: Request, maxBytes: number): Promise<Uint8Array> => {
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  let chunk = await reader.read()

  while (!chunk.done) {
    totalLength += chunk.value.byteLength

    if (totalLength > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // The body is already rejected; cancellation failure does not change the response.
      }

      throw new DomainError('payload_too_large', 'Request body exceeds the allowed size')
    }

    chunks.push(chunk.value)
    chunk = await reader.read()
  }

  const body = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}
