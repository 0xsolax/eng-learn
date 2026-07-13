import { describe, expect, it, vi } from 'vitest'
import e2eWorker from '../../server/e2e'

describe('local E2E Worker guard', () => {
  it('fails closed for a non-loopback request even when local E2E flags are present', async () => {
    const databaseRead = vi.fn()
    const response = await e2eWorker.fetch(
      new Request('https://public.example/api/admin/health'),
      {
        DB: {
          prepare: databaseRead,
        } as unknown as D1Database,
        ASSETS: {
          fetch: () => Promise.resolve(new Response('asset')),
        },
        APP_ORIGIN: 'https://public.example',
        E2E_ENVIRONMENT: 'local-e2e',
        E2E_RUN_ID: 'run-sentinel',
      },
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'dependency_failure' },
    })
    expect(databaseRead).not.toHaveBeenCalled()
  })

  it('requires the per-run value to match the isolated D1 sentinel', async () => {
    const response = await e2eWorker.fetch(
      new Request('https://127.0.0.1:8787/api/e2e/identity'),
      createEnvironment('different-sentinel'),
    )

    expect(response.status).toBe(503)
  })

  it('exposes identity only for a matching loopback origin and D1 sentinel', async () => {
    const response = await e2eWorker.fetch(
      new Request('https://127.0.0.1:8787/api/e2e/identity'),
      createEnvironment('run-sentinel'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        workerName: 'eng-learn-e2e-local',
        environment: 'local-e2e',
        dbSentinel: 'run-sentinel',
      },
    })
  })
})

const createEnvironment = (storedSentinel: string) => ({
  DB: {
    prepare: () => ({
      first: () => Promise.resolve({ value: storedSentinel }),
    }),
  } as unknown as D1Database,
  ASSETS: {
    fetch: () => Promise.resolve(new Response('asset')),
  },
  APP_ORIGIN: 'https://127.0.0.1:8787',
  E2E_ENVIRONMENT: 'local-e2e',
  E2E_RUN_ID: 'run-sentinel',
})
