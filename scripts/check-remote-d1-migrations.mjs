import { spawn } from 'node:child_process'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const wranglerConfigPath = join(repositoryRoot, 'wrangler.jsonc')
const MIGRATION_QUERY = 'SELECT id, name FROM d1_migrations ORDER BY id'
const MIGRATION_FILENAME = /^\d{4}_.+\.sql$/u
const ACCOUNT_ID = /^[0-9a-f]{32}$/u
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export const parseWranglerJsonc = (contents) => {
  try {
    return JSON.parse(removeJsoncSyntax(contents.replace(/^\uFEFF/u, '')))
  } catch {
    throw new Error('Could not parse wrangler.jsonc')
  }
}

export const assertProductionLessonQueueWriteMode = (config) => {
  const writeMode =
    isRecord(config) && isRecord(config.vars)
      ? config.vars.LESSON_QUEUE_WRITE_MODE
      : undefined

  if (writeMode !== 'v2') {
    throw new Error(
      'wrangler.jsonc production LESSON_QUEUE_WRITE_MODE must be exactly v2',
    )
  }
}

export const resolveRemoteD1MigrationTarget = (config) => {
  if (!isRecord(config) || !ACCOUNT_ID.test(config.account_id ?? '')) {
    throw new Error('wrangler.jsonc has no valid production account_id')
  }

  if (!Array.isArray(config.d1_databases)) {
    throw new Error('wrangler.jsonc has no D1 database configuration')
  }

  const database = config.d1_databases.find(
    (candidate) => isRecord(candidate) && candidate.binding === 'DB',
  )

  if (
    !isRecord(database) ||
    typeof database.database_name !== 'string' ||
    database.database_name.length === 0 ||
    typeof database.database_id !== 'string' ||
    !DATABASE_ID.test(database.database_id) ||
    typeof database.migrations_dir !== 'string' ||
    database.migrations_dir.length === 0
  ) {
    throw new Error('wrangler.jsonc has no complete production DB migration target')
  }

  return {
    accountId: config.account_id,
    binding: 'DB',
    databaseName: database.database_name,
    databaseId: database.database_id,
    migrationsDirectory: database.migrations_dir,
  }
}

export const parseRemoteD1Info = (stdout) => {
  const parsed = parseWranglerJson(stdout, 'D1 info')

  if (
    !isRecord(parsed) ||
    typeof parsed.name !== 'string' ||
    typeof parsed.uuid !== 'string'
  ) {
    throw new Error('Could not parse Wrangler D1 info output')
  }

  return { name: parsed.name, uuid: parsed.uuid }
}

export const parseRemoteD1Migrations = (stdout) => {
  const parsed = parseWranglerJson(stdout, 'D1 migration query')
  const result = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined

  if (
    !isRecord(result) ||
    result.success !== true ||
    !Array.isArray(result.results) ||
    !isRecord(result.meta) ||
    result.meta.changed_db !== false ||
    result.meta.rows_written !== 0
  ) {
    throw new Error('Could not parse read-only Wrangler D1 migration output')
  }

  return result.results.map((row) => {
    if (
      !isRecord(row) ||
      !Number.isInteger(row.id) ||
      row.id < 1 ||
      typeof row.name !== 'string' ||
      !MIGRATION_FILENAME.test(row.name)
    ) {
      throw new Error('Could not parse a remote D1 migration row')
    }

    return { id: row.id, name: row.name }
  })
}

export const assertRemoteD1MigrationParity = ({
  target,
  info,
  localMigrationNames,
  remoteMigrations,
}) => {
  if (info.name !== target.databaseName || info.uuid !== target.databaseId) {
    throw new Error(
      `Remote D1 identity mismatch: expected ${target.databaseName} (${target.databaseId})`,
    )
  }

  if (localMigrationNames.length === 0) {
    throw new Error('No local D1 migrations were found')
  }

  for (const [index, name] of localMigrationNames.entries()) {
    if (!MIGRATION_FILENAME.test(name)) {
      throw new Error(`Invalid local D1 migration filename: ${name}`)
    }

    const remote = remoteMigrations[index]

    if (!remote) {
      throw new Error(
        `Remote D1 is missing migrations: ${localMigrationNames.slice(index).join(', ')}`,
      )
    }

    if (remote.id !== index + 1 || remote.name !== name) {
      throw new Error(
        `Remote D1 migration order mismatch at position ${String(index + 1)}: local ${name}, remote ${remote.name}`,
      )
    }
  }

  if (remoteMigrations.length > localMigrationNames.length) {
    throw new Error(
      `Remote D1 has migrations absent locally: ${remoteMigrations
        .slice(localMigrationNames.length)
        .map((migration) => migration.name)
        .join(', ')}`,
    )
  }
}

export const createRemoteD1ReadCommands = (target, configPath) => [
  [
    'd1',
    'info',
    target.databaseName,
    '--json',
    '--config',
    configPath,
  ],
  [
    'd1',
    'execute',
    target.databaseName,
    '--remote',
    '--config',
    configPath,
    '--command',
    MIGRATION_QUERY,
    '--json',
  ],
]

export const checkRemoteD1Migrations = async () => {
  const config = parseWranglerJsonc(await readFile(wranglerConfigPath, 'utf8'))
  assertProductionLessonQueueWriteMode(config)
  const target = resolveRemoteD1MigrationTarget(config)
  const migrationsDirectory = resolve(repositoryRoot, target.migrationsDirectory)
  const repositoryPrefix = `${repositoryRoot}${sep}`

  if (!migrationsDirectory.startsWith(repositoryPrefix)) {
    throw new Error('D1 migrations_dir must stay inside the repository')
  }

  const entries = await readdir(migrationsDirectory, { withFileTypes: true })
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
  const invalidMigration = sqlFiles.find((name) => !MIGRATION_FILENAME.test(name))

  if (invalidMigration) {
    throw new Error(`Invalid local D1 migration filename: ${invalidMigration}`)
  }

  const localMigrationNames = sqlFiles.toSorted()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'eng-learn-d1-gate-'))
  const wranglerPath = join(repositoryRoot, 'node_modules', '.bin', 'wrangler')
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    WRANGLER_LOG_PATH: join(temporaryRoot, 'wrangler.log'),
    WRANGLER_SEND_METRICS: 'false',
  }

  try {
    const [infoCommand, migrationsCommand] = createRemoteD1ReadCommands(
      target,
      wranglerConfigPath,
    )
    const info = parseRemoteD1Info(
      await runWrangler(wranglerPath, infoCommand, environment, 'D1 info'),
    )
    const remoteMigrations = parseRemoteD1Migrations(
      await runWrangler(
        wranglerPath,
        migrationsCommand,
        environment,
        'D1 migration query',
      ),
    )

    assertRemoteD1MigrationParity({
      target,
      info,
      localMigrationNames,
      remoteMigrations,
    })

    return {
      databaseName: target.databaseName,
      databaseId: target.databaseId,
      migrationCount: localMigrationNames.length,
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

const runWrangler = (executable, args, environment, label) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''

    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.once('error', () => {
      rejectPromise(new Error(`Wrangler ${label} could not start`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        rejectPromise(
          new Error(
            `Wrangler ${label} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})`,
          ),
        )
      }
    })
  })

const parseWranglerJson = (stdout, label) => {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`Could not parse Wrangler ${label} output`)
  }
}

const removeJsoncSyntax = (contents) => {
  let withoutComments = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index]
    const next = contents[index + 1]

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
        withoutComments += character
      }
      continue
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      } else if (character === '\n' || character === '\r') {
        withoutComments += character
      }
      continue
    }

    if (inString) {
      withoutComments += character
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      withoutComments += character
    } else if (character === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else {
      withoutComments += character
    }
  }

  let result = ''
  inString = false
  escaped = false

  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]

    if (inString) {
      result += character
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      result += character
      continue
    }

    if (character === ',') {
      let lookahead = index + 1

      while (/\s/u.test(withoutComments[lookahead] ?? '')) lookahead += 1
      if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']') {
        continue
      }
    }

    result += character
  }

  return result
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    const result = await checkRemoteD1Migrations()
    process.stdout.write(
      `Remote D1 migration gate passed: ${result.databaseName} (${result.databaseId}), ${String(result.migrationCount)} migrations\n`,
    )
  } catch (error) {
    process.stderr.write(
      `Remote D1 migration gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    )
    process.exitCode = 1
  }
}
