import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { get as httpsGet } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createSerializedAdminConfig } from './admin-init.mjs'
import { createSecretFreeEnvironment } from './isolated-secret-environment.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'eng-learn-stack-e2e-'))
const projectRoot = join(temporaryRoot, 'project')
const stateRoot = join(temporaryRoot, 'state')
const outputRoot = join(temporaryRoot, 'test-results')
const pendingMigrations = [
  '0011_add_progressive_context_model.sql',
  '0012_add_exercise_review_feedback.sql',
]
const pendingMigrationPaths = new Map(
  pendingMigrations.map((migration) => [migration, join(temporaryRoot, migration)]),
)
const dbSentinel = randomUUID()
const adminUsername = 'e2e-admin'
const adminPassword = `E2E-${randomBytes(24).toString('base64url')}`
const adminAuthConfig = await createSerializedAdminConfig({
  username: adminUsername,
  displayName: 'E2E 管理员',
  password: adminPassword,
  confirmation: adminPassword,
})
let worker

const playwrightBrowsersPath =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Local', 'ms-playwright')
      : join(homedir(), '.cache', 'ms-playwright'))

const copiedEntries = [
  'index.html',
  'migrations',
  'package.json',
  'playwright.stack.config.ts',
  'server',
  'shared',
  'src',
  'tests/e2e/stack',
  'tsconfig.app.json',
  'tsconfig.component.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.vitest.json',
  'vite.client.config.ts',
  'worker-configuration.d.ts',
  'wrangler.e2e.jsonc',
]

const environment = createSecretFreeEnvironment(process.env)
environment.CI = '1'
environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath
environment.WRANGLER_SEND_METRICS = 'false'
environment.HOME = join(temporaryRoot, 'home')
environment.XDG_CONFIG_HOME = join(temporaryRoot, 'config')

const run = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit',
      ...options,
    })

    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(
          new Error(
            `${basename(command)} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})`,
          ),
        )
      }
    })
  })

const reservePort = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined

      server.close((error) => {
        if (error) rejectPromise(error)
        else if (port) resolvePromise(port)
        else rejectPromise(new Error('Could not reserve a local port'))
      })
    })
  })

const waitForIdentity = async (baseURL, expectedSentinel) => {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    try {
      const response = await readLocalJson(`${baseURL}/api/e2e/identity`)
      const body = response.body

      if (
        response.status === 200 &&
        body?.data?.workerName === 'eng-learn-e2e-local' &&
        body?.data?.environment === 'local-e2e' &&
        body?.data?.dbSentinel === expectedSentinel
      ) {
        return
      }
    } catch {
      // The local Worker may still be starting.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }

  throw new Error('Local E2E Worker identity did not become ready')
}

const readLocalJson = (url) =>
  new Promise((resolvePromise, rejectPromise) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolvePromise({ status: response.statusCode, body: JSON.parse(body) })
        } catch (error) {
          rejectPromise(error)
        }
      })
    })
    request.setTimeout(1_000, () => request.destroy(new Error('Local E2E health timed out')))
    request.once('error', rejectPromise)
  })

const stopWorker = async () => {
  const activeWorker = worker
  worker = undefined

  if (!activeWorker || activeWorker.exitCode !== null) return

  activeWorker.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => activeWorker.once('exit', resolvePromise)),
    new Promise((resolvePromise) =>
      setTimeout(() => {
        if (activeWorker.exitCode === null) activeWorker.kill('SIGKILL')
        resolvePromise()
      }, 5_000),
    ),
  ])
}

const startWorker = async (wrangler) => {
  const port = await reservePort()
  const baseURL = `https://127.0.0.1:${String(port)}`
  worker = spawn(
    wrangler,
    [
      'dev',
      '--config',
      'wrangler.e2e.jsonc',
      '--local',
      '--persist-to',
      stateRoot,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--local-protocol',
      'https',
      '--var',
      `APP_ORIGIN:${baseURL}`,
      '--var',
      'E2E_ENVIRONMENT:local-e2e',
      '--var',
      `E2E_RUN_ID:${dbSentinel}`,
      '--log-level',
      'warn',
    ],
    { cwd: projectRoot, env: environment, stdio: 'inherit' },
  )

  await waitForIdentity(baseURL, dbSentinel)
  return baseURL
}

const runStackTest = async (playwright, testFile, baseURL, outputDirectory) =>
  run(playwright, ['test', testFile, '--config', 'playwright.stack.config.ts'], {
    env: {
      ...environment,
      STACK_BASE_URL: baseURL,
      STACK_DB_SENTINEL: dbSentinel,
      STACK_OUTPUT_DIR: outputDirectory,
      STACK_ADMIN_USERNAME: adminUsername,
      STACK_ADMIN_PASSWORD: adminPassword,
    },
  })

try {
  await mkdir(projectRoot, { recursive: true })
  await mkdir(environment.HOME, { recursive: true })
  await mkdir(environment.XDG_CONFIG_HOME, { recursive: true })

  for (const entry of copiedEntries) {
    await mkdir(dirname(join(projectRoot, entry)), { recursive: true })
    await cp(join(repositoryRoot, entry), join(projectRoot, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    })
  }
  for (const migration of pendingMigrations) {
    const pendingPath = pendingMigrationPaths.get(migration)
    if (!pendingPath) throw new Error(`Missing pending path for ${migration}`)
    await rename(join(projectRoot, 'migrations', migration), pendingPath)
  }
  await symlink(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir')
  const devVarsPath = join(projectRoot, '.dev.vars')
  await writeFile(devVarsPath, `ADMIN_AUTH_CONFIG=${adminAuthConfig}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(devVarsPath, 0o600)

  const vite = join(repositoryRoot, 'node_modules', '.bin', 'vite')
  const wrangler = join(repositoryRoot, 'node_modules', '.bin', 'wrangler')
  const playwright = join(repositoryRoot, 'node_modules', '.bin', 'playwright')

  await run(vite, ['build', '--config', 'vite.client.config.ts'])
  await run(process.execPath, [
    join(repositoryRoot, 'scripts', 'check-no-secret-artifacts.mjs'),
    join(projectRoot, 'dist', 'e2e-client'),
  ])
  await run(wrangler, [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--config',
    'wrangler.e2e.jsonc',
    '--local',
    '--persist-to',
    stateRoot,
  ])
  await run(wrangler, [
    'd1',
    'execute',
    'DB',
    '--config',
    'wrangler.e2e.jsonc',
    '--local',
    '--persist-to',
    stateRoot,
    '--yes',
    '--command',
    `CREATE TABLE e2e_guard (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO e2e_guard (key, value) VALUES ('db_sentinel', '${dbSentinel}')`,
  ])

  const preMigrationBaseURL = await startWorker(wrangler)
  await runStackTest(
    playwright,
    'tests/e2e/stack/import-schema-not-ready.spec.ts',
    preMigrationBaseURL,
    join(outputRoot, 'schema-not-ready'),
  )
  await stopWorker()

  for (const migration of pendingMigrations) {
    const pendingPath = pendingMigrationPaths.get(migration)
    if (!pendingPath) throw new Error(`Missing pending path for ${migration}`)
    await rename(pendingPath, join(projectRoot, 'migrations', migration))
  }
  await run(wrangler, [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--config',
    'wrangler.e2e.jsonc',
    '--local',
    '--persist-to',
    stateRoot,
  ])

  const fullStackBaseURL = await startWorker(wrangler)
  await runStackTest(
    playwright,
    'tests/e2e/stack/full-loop.spec.ts',
    fullStackBaseURL,
    join(outputRoot, 'full'),
  )
  await run(process.execPath, [
    join(repositoryRoot, 'scripts', 'check-no-secret-artifacts.mjs'),
    outputRoot,
  ])

  process.stdout.write('Isolated local Worker + D1 E2E passed\n')
} catch (error) {
  process.stderr.write('Isolated local Worker + D1 E2E failed\n')
  process.exitCode = 1
  if (process.env.DEBUG_STACK_E2E === '1' && error instanceof Error) {
    process.stderr.write(`${error.message}\n`)
  }
} finally {
  await stopWorker()
  await rm(temporaryRoot, { recursive: true, force: true })
}
