import type { AdminAuthConfig } from '../server/security/adminCredential'

export const ADMIN_BENCHMARK_SAMPLE_COUNT: 100

export type AdminCredentialBenchmarkSummary = {
  p50Ms: number
  p95Ms: number
}

export type AdminCredentialBenchmarkResult = {
  algorithm: 'PBKDF2-HMAC-SHA256'
  iterations: 600_000
  samplesPerOutcome: 100
  success: AdminCredentialBenchmarkSummary
  failure: AdminCredentialBenchmarkSummary
  localP95GatePassed: boolean
}

export function summarizeBenchmarkDurations(
  durations: number[],
): AdminCredentialBenchmarkSummary

export function measureAdminCredentialBenchmark(input: {
  config: AdminAuthConfig
  username: string
  correctPassword: string
  incorrectPassword: string
  verifyCredential?: (
    config: AdminAuthConfig,
    username: string,
    password: string,
  ) => Promise<boolean>
  now?: () => number
}): Promise<AdminCredentialBenchmarkResult>

export function formatAdminCredentialBenchmark(
  result: AdminCredentialBenchmarkResult,
): string
