import { timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADMIN_PASSWORD_ALGORITHM,
  ADMIN_PASSWORD_ITERATIONS,
  createAdminAuthConfig,
  verifyAdminCredential,
} from '../server/security/adminCredential.ts'

if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
}

export const ADMIN_BENCHMARK_SAMPLE_COUNT = 100
const LOCAL_P95_LIMIT_MS = 1_000

export const summarizeBenchmarkDurations = (durations) => {
  if (
    durations.length === 0 ||
    durations.some((duration) => !Number.isFinite(duration) || duration < 0)
  ) {
    throw new Error('Benchmark durations must contain finite non-negative values')
  }

  const sorted = [...durations].sort((left, right) => left - right)
  const percentile = (ratio) => sorted[Math.ceil(sorted.length * ratio) - 1]
  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  }
}

export const measureAdminCredentialBenchmark = async ({
  config,
  username,
  correctPassword,
  incorrectPassword,
  verifyCredential = verifyAdminCredential,
  now = () => performance.now(),
}) => {
  const successDurations = []
  const failureDurations = []

  for (let index = 0; index < ADMIN_BENCHMARK_SAMPLE_COUNT; index += 1) {
    const successStartedAt = now()
    const success = await verifyCredential(config, username, correctPassword)
    successDurations.push(now() - successStartedAt)
    if (!success) throw new Error('Benchmark success credential was rejected')

    const failureStartedAt = now()
    const failure = await verifyCredential(config, username, incorrectPassword)
    failureDurations.push(now() - failureStartedAt)
    if (failure) throw new Error('Benchmark failure credential was accepted')
  }

  const successSummary = summarizeBenchmarkDurations(successDurations)
  const failureSummary = summarizeBenchmarkDurations(failureDurations)
  return {
    algorithm: ADMIN_PASSWORD_ALGORITHM,
    iterations: ADMIN_PASSWORD_ITERATIONS,
    samplesPerOutcome: ADMIN_BENCHMARK_SAMPLE_COUNT,
    success: successSummary,
    failure: failureSummary,
    localP95GatePassed:
      successSummary.p95Ms < LOCAL_P95_LIMIT_MS &&
      failureSummary.p95Ms < LOCAL_P95_LIMIT_MS,
  }
}

export const formatAdminCredentialBenchmark = (result) =>
  [
    `${result.algorithm} / ${String(result.iterations)} iterations`,
    `Samples per outcome: ${String(result.samplesPerOutcome)}`,
    `Success: P50 ${result.success.p50Ms.toFixed(2)} ms / P95 ${result.success.p95Ms.toFixed(2)} ms`,
    `Failure: P50 ${result.failure.p50Ms.toFixed(2)} ms / P95 ${result.failure.p95Ms.toFixed(2)} ms`,
    `Local P95 gate (< ${String(LOCAL_P95_LIMIT_MS)} ms): ${result.localP95GatePassed ? 'PASS' : 'FAIL'}`,
  ].join('\n')

const runCli = async () => {
  const username = 'local-benchmark-admin'
  const correctPassword = 'local benchmark credential 2026'
  const incorrectPassword = 'local benchmark credential 2027'
  const config = await createAdminAuthConfig({
    username,
    displayName: 'Local benchmark',
    password: correctPassword,
  })
  const result = await measureAdminCredentialBenchmark({
    config,
    username,
    correctPassword,
    incorrectPassword,
  })

  process.stdout.write(`${formatAdminCredentialBenchmark(result)}\n`)
  if (!result.localP95GatePassed) process.exitCode = 1
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (scriptPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli()
  } catch {
    process.stderr.write('Administrator credential benchmark failed\n')
    process.exitCode = 2
  }
}
