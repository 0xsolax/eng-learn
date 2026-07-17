import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  assertReleaseWorkerCompatibility,
  createReleaseDeployArguments,
  executeReleaseEntry,
} from '../../scripts/release-entry-guard.mjs'

const releaseConfiguration = (flowWriteMode: string): string => JSON.stringify({
  vars: {
    LESSON_QUEUE_WRITE_MODE: 'v2',
    LESSON_FLOW_WRITE_MODE: flowWriteMode,
  },
})

const COMPATIBLE_WORKER = [
  'v1_5_8_unbounded',
  'v2_3_6_cap3',
  'v1_due_then_new_unbounded',
  'v2_rolling_reinforcement_budget24',
].join('\n')

describe('release entry guard', () => {
  it('exposes only the three guarded production deployment entrypoints', async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const scripts = readScripts(packageJson)

    expect(scripts.deploy).toBeUndefined()
    expect(scripts['release:deploy']).toBe(
      'node scripts/release-entry-guard.mjs normal',
    )
    expect(scripts['release:deploy:flow-compat']).toBe(
      'node scripts/release-entry-guard.mjs flow-compat',
    )
    expect(scripts['release:deploy:flow-freeze']).toBe(
      'node scripts/release-entry-guard.mjs flow-freeze',
    )
    expect(Object.values(scripts).join('\n')).not.toMatch(/\bwrangler\s+deploy\b/u)
  })

  it('rejects an invalid entry configuration before build, remote reads, or deploy', async () => {
    const operations = createOperations()

    await expect(executeReleaseEntry({
      entry: 'normal',
      configurationContents: releaseConfiguration('legacy_v1'),
      ...operations,
    })).rejects.toThrow(/LESSON_FLOW_WRITE_MODE.*rolling_v2/u)

    expect(operations.buildRelease).not.toHaveBeenCalled()
    expect(operations.readArtifactConfiguration).not.toHaveBeenCalled()
    expect(operations.readWorkerArtifact).not.toHaveBeenCalled()
    expect(operations.scanArtifacts).not.toHaveBeenCalled()
    expect(operations.checkRemoteMigrations).not.toHaveBeenCalled()
    expect(operations.deploy).not.toHaveBeenCalled()
  })

  it.each([
    ['normal', 'rolling_v2'],
    ['flow-compat', 'legacy_v1'],
    ['flow-freeze', 'disabled'],
  ] as const)(
    'runs the %s build, compatibility, secret, migration, and deploy gates in order',
    async (entry, flowWriteMode) => {
      const calls: string[] = []
      const configurationContents = releaseConfiguration(flowWriteMode)

      await executeReleaseEntry({
        entry,
        configurationContents,
        buildRelease: vi.fn(() => {
          calls.push('build')
          return Promise.resolve()
        }),
        readArtifactConfiguration: vi.fn(() => {
          calls.push('artifact-config')
          return Promise.resolve(configurationContents)
        }),
        readWorkerArtifact: vi.fn(() => {
          calls.push('compatibility')
          return Promise.resolve(COMPATIBLE_WORKER)
        }),
        scanArtifacts: vi.fn(() => {
          calls.push('secret-scan')
          return Promise.resolve()
        }),
        checkRemoteMigrations: vi.fn((actualEntry) => {
          calls.push(`migrations:${String(actualEntry)}`)
          return Promise.resolve()
        }),
        readCurrentConfiguration: vi.fn(() => {
          calls.push('config-recheck')
          return Promise.resolve(configurationContents)
        }),
        deploy: vi.fn(() => {
          calls.push('deploy')
          return Promise.resolve()
        }),
      })

      expect(calls).toEqual([
        'build',
        'artifact-config',
        'compatibility',
        'secret-scan',
        `migrations:${entry}`,
        'config-recheck',
        'deploy',
      ])
    },
  )

  it('rejects a built artifact whose write modes differ from the selected entry', async () => {
    const operations = createOperations()
    operations.readArtifactConfiguration.mockResolvedValue(
      releaseConfiguration('legacy_v1'),
    )

    await expect(executeReleaseEntry({
      entry: 'normal',
      configurationContents: releaseConfiguration('rolling_v2'),
      ...operations,
    })).rejects.toThrow(/LESSON_FLOW_WRITE_MODE.*rolling_v2/u)

    expect(operations.readWorkerArtifact).not.toHaveBeenCalled()
    expect(operations.scanArtifacts).not.toHaveBeenCalled()
    expect(operations.checkRemoteMigrations).not.toHaveBeenCalled()
    expect(operations.deploy).not.toHaveBeenCalled()
  })

  it('deploys the verified no-bundle artifact instead of rebuilding source', () => {
    const args = createReleaseDeployArguments()
    const configIndex = args.indexOf('--config')

    expect(configIndex).toBeGreaterThanOrEqual(0)
    expect(args[configIndex + 1]).toMatch(/\/dist\/eng_learn\/wrangler\.json$/u)
    expect(args).not.toContain(expect.stringMatching(/\/wrangler\.jsonc$/u))
  })

  it('blocks compat and freeze deployments when the built Worker is not a dual reader', () => {
    expect(() => {
      assertReleaseWorkerCompatibility('v2_rolling_reinforcement_budget24')
    }).toThrow(/dual-read|v1_5_8_unbounded/u)

    expect(() => {
      assertReleaseWorkerCompatibility(COMPATIBLE_WORKER)
    }).not.toThrow()
  })
})

const createOperations = () => ({
  buildRelease: vi.fn(() => Promise.resolve()),
  readArtifactConfiguration: vi.fn(() =>
    Promise.resolve(releaseConfiguration('rolling_v2'))),
  readWorkerArtifact: vi.fn(() => Promise.resolve(COMPATIBLE_WORKER)),
  scanArtifacts: vi.fn(() => Promise.resolve()),
  checkRemoteMigrations: vi.fn(() => Promise.resolve()),
  readCurrentConfiguration: vi.fn(() =>
    Promise.resolve(releaseConfiguration('rolling_v2'))),
  deploy: vi.fn(() => Promise.resolve()),
})

const readScripts = (packageJson: unknown): Record<string, string> => {
  if (!packageJson || typeof packageJson !== 'object' || !('scripts' in packageJson)) {
    throw new Error('package.json scripts are missing')
  }

  const scripts = packageJson.scripts

  if (!scripts || typeof scripts !== 'object') {
    throw new Error('package.json scripts are invalid')
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
