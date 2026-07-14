import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_BENCHMARK_SAMPLE_COUNT,
  formatAdminCredentialBenchmark,
  measureAdminCredentialBenchmark,
  summarizeBenchmarkDurations,
} from '../../scripts/benchmark-admin-credential.mjs'
import type { AdminAuthConfig } from '../../server/security/adminCredential'

describe('administrator credential benchmark', () => {
  it('uses nearest-rank P50 and P95 summaries', () => {
    const durations = Array.from({ length: 100 }, (_, index) => index + 1)

    expect(summarizeBenchmarkDurations(durations)).toEqual({
      p50Ms: 50,
      p95Ms: 95,
    })
  })

  it('measures exactly 100 successful and 100 failed credential checks', async () => {
    const correctPassword = 'correct benchmark password'
    const incorrectPassword = 'incorrect benchmark password'
    const verifyCredential = vi.fn(
      (_config: AdminAuthConfig, _username: string, password: string) =>
        Promise.resolve(password === correctPassword),
    )
    const timestamps: number[] = []
    let elapsed = 0
    for (let index = 0; index < ADMIN_BENCHMARK_SAMPLE_COUNT; index += 1) {
      timestamps.push(elapsed, elapsed + 10, elapsed + 10, elapsed + 30)
      elapsed += 30
    }

    const result = await measureAdminCredentialBenchmark({
      config: {
        version: 1,
        username: 'benchmark-admin',
        displayName: 'Benchmark admin',
        credentialId: '00000000-0000-4000-8000-000000000000',
        algorithm: 'PBKDF2-HMAC-SHA256',
        iterations: 600_000,
        salt: 'AAAAAAAAAAAAAAAAAAAAAA',
        verifier: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        rateLimitKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      username: 'benchmark-admin',
      correctPassword,
      incorrectPassword,
      verifyCredential,
      now: () => timestamps.shift() ?? Number.NaN,
    })

    expect(verifyCredential).toHaveBeenCalledTimes(200)
    expect(result).toEqual({
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: 600_000,
      samplesPerOutcome: 100,
      success: { p50Ms: 10, p95Ms: 10 },
      failure: { p50Ms: 20, p95Ms: 20 },
      localP95GatePassed: true,
    })
  })

  it('formats only aggregate timing results', () => {
    const output = formatAdminCredentialBenchmark({
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: 600_000,
      samplesPerOutcome: 100,
      success: { p50Ms: 123.456, p95Ms: 234.567 },
      failure: { p50Ms: 134.567, p95Ms: 245.678 },
      localP95GatePassed: true,
    })

    expect(output).toContain('PBKDF2-HMAC-SHA256 / 600000 iterations')
    expect(output).toContain('Success: P50 123.46 ms / P95 234.57 ms')
    expect(output).toContain('Failure: P50 134.57 ms / P95 245.68 ms')
    expect(output).toContain('Local P95 gate (< 1000 ms): PASS')
    expect(output).not.toMatch(/password|verifier|rateLimitKey|ADMIN_AUTH_CONFIG/i)
  })
})
