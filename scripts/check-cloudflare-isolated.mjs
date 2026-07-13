import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const wranglerArgs = process.argv.slice(2)
const allowedCommands = [
  ['check', 'startup'],
  ['types', '--check'],
]
const copiedEntries = [
  'dist',
  'migrations',
  'package.json',
  'server',
  'shared',
  'tsconfig.app.json',
  'tsconfig.component.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.vitest.json',
  'worker-configuration.d.ts',
  'wrangler.jsonc',
]

if (
  !allowedCommands.some(
    (allowed) =>
      allowed.length === wranglerArgs.length &&
      allowed.every((argument, index) => argument === wranglerArgs[index]),
  )
) {
  process.stderr.write(
    'Only read-only Cloudflare checks are allowed: check startup | types --check\n',
  )
  process.exit(2)
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'eng-learn-cloudflare-check-'))
const projectRoot = join(temporaryRoot, 'project')

const run = (command, args, environment) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit',
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
  await mkdir(projectRoot, { recursive: true })
  for (const entry of copiedEntries) {
    await cp(join(repositoryRoot, entry), join(projectRoot, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
  }
  await symlink(join(repositoryRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir')

  const environment = { ...process.env }
  for (const name of [
    'ADMIN_API_TOKEN',
    'CF_API_KEY',
    'CF_API_TOKEN',
    'CF_ACCESS_CLIENT_SECRET',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCESS_CLIENT_SECRET',
    'CLOUDFLARE_EMAIL',
    'WRANGLER_API_TOKEN',
  ]) {
    delete environment[name]
  }
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
  environment.WRANGLER_SEND_METRICS = 'false'
  environment.HOME = join(temporaryRoot, 'home')
  environment.XDG_CONFIG_HOME = join(temporaryRoot, 'config')
  await mkdir(environment.HOME, { recursive: true })
  await mkdir(environment.XDG_CONFIG_HOME, { recursive: true })

  await run(
    join(repositoryRoot, 'node_modules', '.bin', 'wrangler'),
    wranglerArgs,
    environment,
  )
  process.stdout.write('Isolated Cloudflare check passed without local secret files\n')
} catch (error) {
  process.stderr.write('Isolated Cloudflare check failed\n')
  process.exitCode = 1
  if (process.env.DEBUG_CLOUDFLARE_CHECK === '1' && error instanceof Error) {
    process.stderr.write(`${error.message}\n`)
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
