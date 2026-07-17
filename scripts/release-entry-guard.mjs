import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import {
  assertProductionLessonWriteModes,
  checkRemoteD1Migrations,
  parseWranglerJsonc,
  resolveRemoteD1MigrationTarget,
} from './check-remote-d1-migrations.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const wranglerConfigPath = join(repositoryRoot, 'wrangler.jsonc')
const workerArtifactPath = join(repositoryRoot, 'dist', 'eng_learn', 'index.js')
const releaseArtifactConfigPath = join(
  repositoryRoot,
  'dist',
  'eng_learn',
  'wrangler.json',
)
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const wranglerExecutable = join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
)
const REQUIRED_WORKER_CAPABILITIES = Object.freeze([
  'v1_5_8_unbounded',
  'v2_3_6_cap3',
  'v1_due_then_new_unbounded',
  'v2_rolling_reinforcement_budget24',
])

export const assertReleaseWorkerCompatibility = (workerArtifact) => {
  const missingCapability = REQUIRED_WORKER_CAPABILITIES.find(
    (capability) => !workerArtifact.includes(capability),
  )

  if (missingCapability) {
    throw new Error(
      `Release Worker is not queue/flow dual-read compatible: missing ${missingCapability}`,
    )
  }
}

export const createReleaseDeployArguments = () => [
  'deploy',
  '--strict',
  '--config',
  releaseArtifactConfigPath,
]

export const executeReleaseEntry = async ({
  entry,
  configurationContents,
  buildRelease,
  readArtifactConfiguration,
  readWorkerArtifact,
  scanArtifacts,
  checkRemoteMigrations,
  readCurrentConfiguration,
  deploy,
}) => {
  assertProductionLessonWriteModes(
    parseWranglerJsonc(configurationContents),
    entry,
  )

  await buildRelease()
  assertProductionLessonWriteModes(
    parseWranglerJsonc(await readArtifactConfiguration()),
    entry,
  )
  assertReleaseWorkerCompatibility(await readWorkerArtifact())
  await scanArtifacts()
  await checkRemoteMigrations(entry)

  const currentConfigurationContents = await readCurrentConfiguration()
  if (currentConfigurationContents !== configurationContents) {
    throw new Error('wrangler.jsonc changed while the release gates were running')
  }
  assertProductionLessonWriteModes(
    parseWranglerJsonc(currentConfigurationContents),
    entry,
  )

  await deploy()
}

const runCommand = (command, args, environment = process.env) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    })

    child.once('error', () => {
      rejectPromise(new Error(`${command} could not start`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(
          new Error(
            `${command} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})`,
          ),
        )
      }
    })
  })

const runReleaseEntry = async (entry) => {
  const configurationContents = await readFile(wranglerConfigPath, 'utf8')
  const target = resolveRemoteD1MigrationTarget(
    parseWranglerJsonc(configurationContents),
  )
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    WRANGLER_SEND_METRICS: 'false',
  }

  await executeReleaseEntry({
    entry,
    configurationContents,
    buildRelease: () => runCommand(pnpmExecutable, ['build:release']),
    readArtifactConfiguration: () => readFile(releaseArtifactConfigPath, 'utf8'),
    readWorkerArtifact: () => readFile(workerArtifactPath, 'utf8'),
    scanArtifacts: () => runCommand(process.execPath, [
      join(scriptDirectory, 'check-no-secret-artifacts.mjs'),
      join(repositoryRoot, 'dist'),
    ]),
    checkRemoteMigrations: checkRemoteD1Migrations,
    readCurrentConfiguration: () => readFile(wranglerConfigPath, 'utf8'),
    deploy: () => runCommand(
      wranglerExecutable,
      createReleaseDeployArguments(),
      environment,
    ),
  })
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    await runReleaseEntry(process.argv[2])
  } catch (error) {
    process.stderr.write(
      `Release entry guard failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    )
    process.exitCode = 1
  }
}
