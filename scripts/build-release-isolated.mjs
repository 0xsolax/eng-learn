import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { sanitizeGeneratedReleaseMetadata } from './release-metadata-sanitizer.mjs'
import { createSecretFreeEnvironment } from './isolated-secret-environment.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'eng-learn-release-build-'))
const projectRoot = join(temporaryRoot, 'project')
const copiedEntries = [
  'index.html',
  'package.json',
  'public',
  'server',
  'shared',
  'src',
  'tsconfig.app.json',
  'tsconfig.component.json',
  'tsconfig.eslint.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.vitest.json',
  'vite.config.ts',
  'worker-configuration.d.ts',
  'wrangler.jsonc',
]

const run = (command, args, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
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

try {
  await mkdir(projectRoot)
  for (const entry of copiedEntries) {
    await cp(join(repositoryRoot, entry), join(projectRoot, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
  }
  await symlink(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir')

  const environment = createSecretFreeEnvironment(process.env)
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
  environment.WRANGLER_SEND_METRICS = 'false'
  environment.HOME = temporaryRoot
  environment.XDG_CONFIG_HOME = join(temporaryRoot, 'config')

  await run(join(repositoryRoot, 'node_modules', '.bin', 'vite'), ['build'], {
    env: environment,
  })
  await sanitizeGeneratedReleaseMetadata({
    workerPath: join(projectRoot, 'dist', 'eng_learn', 'index.js'),
    outputConfigPath: join(projectRoot, 'dist', 'eng_learn', 'wrangler.json'),
  })
  await run(process.execPath, [
    join(repositoryRoot, 'scripts', 'check-no-secret-artifacts.mjs'),
    join(projectRoot, 'dist'),
  ], { env: environment })

  await rm(join(repositoryRoot, 'dist'), { recursive: true, force: true })
  await cp(join(projectRoot, 'dist'), join(repositoryRoot, 'dist'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  })

  process.stdout.write('Isolated release build passed and published verified artifacts\n')
} catch (error) {
  process.stderr.write('Isolated release build failed\n')
  process.exitCode = 1
  if (process.env.DEBUG_RELEASE_BUILD === '1' && error instanceof Error) {
    process.stderr.write(`${error.message}\n`)
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
