import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseJsonRequest } from '../../server/http/request'

describe('HTTP request parsing', () => {
  it('returns schema-validated data and strips no undeclared fields silently', async () => {
    const request = new Request('https://eng-learn.test/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    })

    await expect(
      parseJsonRequest(request, z.object({ name: z.string().min(1) }).strict()),
    ).resolves.toEqual({ name: 'Alice' })
  })

  it('returns stable request errors for malformed JSON and invalid fields', async () => {
    const malformed = new Request('https://eng-learn.test/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    const invalid = new Request('https://eng-learn.test/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    await expect(
      parseJsonRequest(malformed, z.object({ name: z.string() }).strict()),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      parseJsonRequest(invalid, z.object({ name: z.string().min(1) }).strict()),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: {
        fields: [
          {
            path: 'name',
            message: 'Too small: expected string to have >=1 characters',
          },
        ],
      },
    })
  })

  it('rejects an oversized JSON body when Content-Length is missing or understated', async () => {
    const oversizedName = 'a'.repeat(256 * 1024)
    const withoutLength = new Request('https://eng-learn.test/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: oversizedName }),
    })
    const understatedLength = new Request('https://eng-learn.test/api/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '16',
      },
      body: JSON.stringify({ name: oversizedName }),
    })
    const schema = z.object({ name: z.string() }).strict()

    await expect(parseJsonRequest(withoutLength, schema)).rejects.toMatchObject({
      code: 'payload_too_large',
    })
    await expect(parseJsonRequest(understatedLength, schema)).rejects.toMatchObject({
      code: 'payload_too_large',
    })
  })

  it('allows an explicitly larger bounded import payload without changing the default limit', async () => {
    const request = new Request('https://eng-learn.test/api/admin/source-versions/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'a'.repeat(300 * 1024) }),
    })

    const parsed = await parseJsonRequest(request, z.object({ value: z.string() }).strict(), {
      maxBytes: 2 * 1024 * 1024,
    })

    expect(parsed.value).toHaveLength(300 * 1024)
  })
})
