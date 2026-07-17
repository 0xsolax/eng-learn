import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { apiErrorSchema } from '../../../shared/api/schemas'
import { generateAdminOperationToken } from '../../../shared/security/adminOperationToken'

const adminUsername = process.env.STACK_ADMIN_USERNAME
const adminPassword = process.env.STACK_ADMIN_PASSWORD

if (!adminUsername || !adminPassword) {
  throw new Error('STACK administrator credentials are required')
}

test('fails closed before migration 0011 without writing import state', async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected stack base URL')

  const originHeaders = { origin: new URL(baseURL).origin }
  const login = await request.post('/api/admin/auth/login', {
    headers: originHeaders,
    data: { username: adminUsername, password: adminPassword },
  })
  expect(login.status()).toBe(200)

  const imported = await request.post('/api/admin/source-versions/import', {
    headers: originHeaders,
    data: {
      mode: 'new_source',
      operationToken: generateAdminOperationToken(),
      sourceName: 'Pre-0011 source',
      words: [
        {
          word: 'apple',
          meaning: '苹果',
          examplePhrase: 'an apple',
          exampleSentence: 'I eat an apple.',
          exampleSentenceExtended: 'I eat an apple after school every day.',
        },
      ],
    },
  })
  const failure = z
    .object({ ok: z.literal(false), error: apiErrorSchema })
    .strict()
    .parse(await imported.json())

  expect(imported.status()).toBe(503)
  expect(failure.error.code).toBe('schema_not_ready')

  const evidenceResponse = await request.get('/api/e2e/import-evidence')
  const evidence = z
    .object({
      ok: z.literal(true),
      data: z
        .object({
          sourceCount: z.number().int().nonnegative(),
          versionCount: z.number().int().nonnegative(),
          wordCount: z.number().int().nonnegative(),
          groupCount: z.number().int().nonnegative(),
          operationCount: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict()
    .parse(await evidenceResponse.json())

  expect(evidenceResponse.status()).toBe(200)
  expect(evidence.data).toEqual({
    sourceCount: 0,
    versionCount: 0,
    wordCount: 0,
    groupCount: 0,
    operationCount: 0,
  })
})
