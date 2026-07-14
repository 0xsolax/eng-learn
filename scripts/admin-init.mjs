import { spawn } from 'node:child_process'
import { pbkdf2, randomBytes, randomUUID } from 'node:crypto'
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)
const ITERATIONS = 600_000
const ALGORITHM = 'PBKDF2-HMAC-SHA256'
const USERNAME_PATTERN = /^[A-Za-z0-9._+@-]+$/
const NON_VISIBLE_CHARACTER_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u
const LOCAL_ADMIN_APP_ORIGIN = 'https://127.0.0.1:8787'
const LOCAL_ADMIN_BROWSER_AUTH_MODE = 'application_session'

export const createSerializedAdminConfig = async (input) => {
  const username = validateUsername(input.username)
  const displayName = validateDisplayName(input.displayName)
  if (input.password !== input.confirmation) {
    throw new Error('The two passwords do not match')
  }
  validatePassword(input.password, username, displayName)

  const salt = randomBytes(16)
  const verifier = await pbkdf2Async(input.password, salt, ITERATIONS, 32, 'sha256')
  const config = {
    version: 1,
    username,
    displayName,
    credentialId: randomUUID(),
    algorithm: ALGORITHM,
    iterations: ITERATIONS,
    salt: salt.toString('base64url'),
    verifier: verifier.toString('base64url'),
    rateLimitKey: randomBytes(32).toString('base64url'),
  }
  return `v1.${Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')}`
}

export const replaceAdminAuthConfig = (current, encoded) => {
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Refusing to write an invalid ADMIN_AUTH_CONFIG value')
  }

  const linePattern = /^([ \t]*ADMIN_AUTH_CONFIG[ \t]*=)[^\r\n]*(\r?)$/gm
  const matches = [...current.matchAll(linePattern)]
  if (matches.length > 1) {
    throw new Error('Multiple ADMIN_AUTH_CONFIG definitions found')
  }
  if (matches.length === 1) {
    return current.replace(linePattern, (_line, prefix, carriageReturn) =>
      `${prefix}${encoded}${carriageReturn}`,
    )
  }

  return appendConfigLine(current, `ADMIN_AUTH_CONFIG=${encoded}`)
}

const appendConfigLine = (current, line) => {
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  if (current.length === 0) return `${line}${newline}`

  const hasFinalNewline = current.endsWith('\n')
  return `${current}${hasFinalNewline ? '' : newline}${line}${hasFinalNewline ? newline : ''}`
}

const readUniqueConfigValue = (current, key) => {
  const linePattern = new RegExp(`^[ \\t]*${key}[ \\t]*=([^\\r\\n]*)(\\r?)$`, 'gm')
  const matches = [...current.matchAll(linePattern)]
  if (matches.length > 1) throw new Error(`Multiple ${key} definitions found`)
  return matches.length === 1 ? matches[0][1].trim() : undefined
}

export const ensureLocalAdminRuntimeConfig = (current) => {
  let next = current
  for (const [key, expected] of [
    ['APP_ORIGIN', LOCAL_ADMIN_APP_ORIGIN],
    ['ADMIN_BROWSER_AUTH_MODE', LOCAL_ADMIN_BROWSER_AUTH_MODE],
  ]) {
    const existing = readUniqueConfigValue(next, key)
    if (existing === undefined) {
      next = appendConfigLine(next, `${key}=${expected}`)
      continue
    }
    if (existing !== expected) {
      throw new Error(`${key} must be ${expected} for pnpm dev:admin:local`)
    }
  }
  return next
}

const readLocalConfig = async (path) => {
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error
  }
  return current
}

const writeLocalConfig = async (path, next) => {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    await writeFile(temporaryPath, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export const writeLocalAdminRuntimeConfig = async (path) => {
  const current = await readLocalConfig(path)
  await writeLocalConfig(path, ensureLocalAdminRuntimeConfig(current))
}

export const writeLocalAdminConfig = async (path, encoded) => {
  const current = await readLocalConfig(path)
  const runtimeReady = ensureLocalAdminRuntimeConfig(current)
  await writeLocalConfig(path, replaceAdminAuthConfig(runtimeReady, encoded))
}

const validateUsername = (candidate) => {
  const username = candidate.trim().toLocaleLowerCase('en-US')
  if (username.length < 3 || username.length > 64 || !USERNAME_PATTERN.test(username)) {
    throw new Error('Admin username must be 3 to 64 allowed characters')
  }
  return username
}

const validateDisplayName = (candidate) => {
  const displayName = candidate.trim()
  if (
    Array.from(displayName).length < 1 ||
    Array.from(displayName).length > 64 ||
    NON_VISIBLE_CHARACTER_PATTERN.test(displayName)
  ) {
    throw new Error('Admin display name must contain 1 to 64 characters')
  }
  return displayName
}

const validatePassword = (password, username, displayName) => {
  const length = Array.from(password).length
  if (length < 15 || length > 128) {
    throw new Error('Admin password must contain 15 to 128 Unicode code points')
  }
  const normalized = password.toLocaleLowerCase('en-US')
  const blocked = new Set([
    username.toLocaleLowerCase('en-US'),
    displayName.toLocaleLowerCase('en-US'),
    'eng-learn',
    'eng learn',
    'password',
    'password123456',
    'admin123456789',
    '123456789012345',
    'qwertyuiopasdfg',
  ])
  if (blocked.has(normalized)) throw new Error('Admin password is not allowed')
}

const createPrompter = () => {
  let muted = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding)
      callback()
    },
  })
  const interface_ = createInterface({ input: process.stdin, output, terminal: true })
  return {
    async text(prompt) {
      return interface_.question(prompt)
    },
    async secret(prompt) {
      muted = true
      process.stdout.write(prompt)
      try {
        return await interface_.question('')
      } finally {
        muted = false
        process.stdout.write('\n')
      }
    },
    close() {
      interface_.close()
    },
  }
}

export const putRemoteSecret = async (encoded, command = 'pnpm') =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      command,
      ['exec', 'wrangler', 'secret', 'put', 'ADMIN_AUTH_CONFIG'],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Wrangler secret put failed (${signal ?? code ?? 'unknown'})`))
    })
    child.stdin.end(`${encoded}\n`)
  })

const run = async () => {
  const mode = process.argv[2]
  if (mode === 'prepare-local') {
    await writeLocalAdminRuntimeConfig(resolve('.dev.vars'))
    process.stdout.write('Local administrator runtime configuration prepared\n')
    return
  }
  if (mode !== 'local' && mode !== 'remote') {
    throw new Error('Usage: node scripts/admin-init.mjs <prepare-local|local|remote>')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Administrator initialization requires an interactive terminal')
  }

  const prompt = createPrompter()
  let encoded
  try {
    const username = await prompt.text('管理员账号: ')
    const displayName = await prompt.text('显示名称: ')
    const password = await prompt.secret('管理员密码: ')
    const confirmation = await prompt.secret('再次输入密码: ')
    encoded = await createSerializedAdminConfig({
      username,
      displayName,
      password,
      confirmation,
    })
  } finally {
    prompt.close()
  }

  if (mode === 'local') {
    await writeLocalAdminConfig(resolve('.dev.vars'), encoded)
    process.stdout.write('Local administrator authentication configuration updated\n')
    return
  }

  await putRemoteSecret(encoded)
  process.stdout.write('Remote administrator authentication configuration updated\n')
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Administrator initialization failed'}\n`,
    )
    process.exitCode = 1
  })
}
