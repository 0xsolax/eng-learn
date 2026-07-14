import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAdminAuthConfig } from '../../server/security/adminCredential'

interface AdminInitModule {
  createSerializedAdminConfig: (input: {
    username: string
    displayName: string
    password: string
    confirmation: string
  }) => Promise<string>
  ensureLocalAdminRuntimeConfig: (current: string) => string
  replaceAdminAuthConfig: (current: string, encoded: string) => string
  writeLocalAdminConfig: (path: string, encoded: string) => Promise<void>
  writeLocalAdminRuntimeConfig: (path: string) => Promise<void>
  putRemoteSecret: (encoded: string, command?: string) => Promise<void>
}

const moduleUrl = new URL('../../scripts/admin-init.mjs', import.meta.url).href
const adminInitModule: unknown = await import(moduleUrl)
const {
  createSerializedAdminConfig,
  ensureLocalAdminRuntimeConfig,
  putRemoteSecret,
  replaceAdminAuthConfig,
  writeLocalAdminConfig,
  writeLocalAdminRuntimeConfig,
} = adminInitModule as AdminInitModule
const commandPath = fileURLToPath(moduleUrl)

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('admin initialization command', () => {
  it('creates a versioned config without returning the raw password', async () => {
    const password = 'correct horse battery staple'
    const encoded = await createSerializedAdminConfig({
      username: ' Admin.Example ',
      displayName: ' Solazhu ',
      password,
      confirmation: password,
    })

    expect(encoded).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain(password)
  })

  it('produces a Worker-readable config for a 64-code-point display name', async () => {
    const displayName = '😀'.repeat(64)
    const encoded = await createSerializedAdminConfig({
      username: 'admin',
      displayName,
      password: 'correct horse battery staple',
      confirmation: 'correct horse battery staple',
    })

    expect(parseAdminAuthConfig(encoded).displayName).toBe(displayName)
  })

  it('rejects non-visible characters in the administrator display name', async () => {
    for (const displayName of ['Visible\tName', 'Visible\u200BName', 'Visible\u202EName']) {
      await expect(
        createSerializedAdminConfig({
          username: 'admin',
          displayName,
          password: 'correct horse battery staple',
          confirmation: 'correct horse battery staple',
        }),
      ).rejects.toThrow()
    }
  })

  it('rejects mismatched, short, and identity-derived passwords', async () => {
    await expect(
      createSerializedAdminConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: 'correct horse battery staple',
        confirmation: 'different password value',
      }),
    ).rejects.toThrow()
    await expect(
      createSerializedAdminConfig({
        username: 'admin',
        displayName: 'Solazhu',
        password: 'too-short',
        confirmation: 'too-short',
      }),
    ).rejects.toThrow()
    await expect(
      createSerializedAdminConfig({
        username: 'very-long-admin-name',
        displayName: 'Solazhu',
        password: 'very-long-admin-name',
        confirmation: 'very-long-admin-name',
      }),
    ).rejects.toThrow()
  })

  it('replaces only one config line and preserves all other bytes', () => {
    const current = '# local config\nAPP_ORIGIN=https://example.test\nADMIN_AUTH_CONFIG=old\n\n'
    const next = replaceAdminAuthConfig(current, 'v1.replacement')

    expect(next).toBe(
      '# local config\nAPP_ORIGIN=https://example.test\nADMIN_AUTH_CONFIG=v1.replacement\n\n',
    )
    expect(() =>
      replaceAdminAuthConfig(
        'ADMIN_AUTH_CONFIG=first\nADMIN_AUTH_CONFIG=second\n',
        'v1.replacement',
      ),
    ).toThrow()
  })

  it('preserves LF, CRLF, and a missing final newline when appending config', () => {
    expect(replaceAdminAuthConfig('TOKEN=one', 'v1.value')).toBe(
      'TOKEN=one\nADMIN_AUTH_CONFIG=v1.value',
    )
    expect(replaceAdminAuthConfig('TOKEN=one\r\nMODE=two', 'v1.value')).toBe(
      'TOKEN=one\r\nMODE=two\r\nADMIN_AUTH_CONFIG=v1.value',
    )
    expect(replaceAdminAuthConfig('TOKEN=one\r\n', 'v1.value')).toBe(
      'TOKEN=one\r\nADMIN_AUTH_CONFIG=v1.value\r\n',
    )
  })

  it('adds deterministic local runtime settings without changing EOF style', () => {
    expect(ensureLocalAdminRuntimeConfig('TOKEN=one')).toBe(
      'TOKEN=one\nAPP_ORIGIN=https://127.0.0.1:8787\nADMIN_BROWSER_AUTH_MODE=application_session',
    )
    expect(ensureLocalAdminRuntimeConfig('TOKEN=one\r\n')).toBe(
      'TOKEN=one\r\nAPP_ORIGIN=https://127.0.0.1:8787\r\nADMIN_BROWSER_AUTH_MODE=application_session\r\n',
    )
    expect(() =>
      ensureLocalAdminRuntimeConfig('APP_ORIGIN=https://localhost:5173\n'),
    ).toThrow('APP_ORIGIN must be https://127.0.0.1:8787')
    expect(() =>
      ensureLocalAdminRuntimeConfig(
        'ADMIN_BROWSER_AUTH_MODE=application_session\nADMIN_BROWSER_AUTH_MODE=cloudflare_access\n',
      ),
    ).toThrow('Multiple ADMIN_BROWSER_AUTH_MODE definitions found')
  })

  it('atomically writes a local config with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-init-'))
    temporaryRoots.push(root)
    const path = join(root, '.dev.vars')
    await writeFile(path, '# keep this comment\n')

    await writeLocalAdminConfig(path, 'v1.generated')

    expect(await readFile(path, 'utf8')).toBe(
      '# keep this comment\nAPP_ORIGIN=https://127.0.0.1:8787\nADMIN_BROWSER_AUTH_MODE=application_session\nADMIN_AUTH_CONFIG=v1.generated\n',
    )
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('leaves the existing local file byte-identical when validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-init-failure-'))
    temporaryRoots.push(root)
    const path = join(root, '.dev.vars')
    const current = 'ADMIN_AUTH_CONFIG=first\nADMIN_AUTH_CONFIG=second\n'
    await writeFile(path, current)

    await expect(writeLocalAdminConfig(path, 'v1.generated')).rejects.toThrow()

    expect(await readFile(path, 'utf8')).toBe(current)
    expect(await readdir(root)).toEqual(['.dev.vars'])
  })

  it('fails closed outside an interactive terminal before reading credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-init-cli-'))
    temporaryRoots.push(root)
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn(process.execPath, [commandPath, 'local'], {
          cwd: root,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', reject)
        child.once('close', (code) => {
          resolvePromise({ code, stdout, stderr })
        })
        child.stdin.end('admin\nSolazhu\nraw-password-must-not-be-read\n')
      },
    )

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('requires an interactive terminal')
    expect(result.stderr).not.toContain('raw-password-must-not-be-read')
    await expect(readFile(join(root, '.dev.vars'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('prepares local runtime settings without reading credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-prepare-cli-'))
    temporaryRoots.push(root)
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn(process.execPath, [commandPath, 'prepare-local'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.once('error', reject)
        child.once('close', (code) => {
          resolvePromise({ code, stdout, stderr })
        })
      },
    )

    expect(result).toEqual({
      code: 0,
      stdout: 'Local administrator runtime configuration prepared\n',
      stderr: '',
    })
    expect(await readFile(join(root, '.dev.vars'), 'utf8')).toBe(
      'APP_ORIGIN=https://127.0.0.1:8787\nADMIN_BROWSER_AUTH_MODE=application_session\n',
    )
    expect((await stat(join(root, '.dev.vars'))).mode & 0o777).toBe(0o600)
  })

  it('atomically prepares an existing local runtime config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-prepare-'))
    temporaryRoots.push(root)
    const path = join(root, '.dev.vars')
    await writeFile(path, 'TOKEN=keep-without-eof-newline')

    await writeLocalAdminRuntimeConfig(path)

    expect(await readFile(path, 'utf8')).toBe(
      'TOKEN=keep-without-eof-newline\nAPP_ORIGIN=https://127.0.0.1:8787\nADMIN_BROWSER_AUTH_MODE=application_session',
    )
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('passes the remote Secret through stdin and never through command arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-init-remote-'))
    temporaryRoots.push(root)
    const capturePath = join(root, 'capture.json')
    const fakeCommandPath = join(root, 'fake-pnpm')
    await writeFile(
      fakeCommandPath,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  writeFileSync(process.env.ADMIN_INIT_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString('utf8'),
  }))
})
`,
      { mode: 0o700 },
    )
    const encoded = await createSerializedAdminConfig({
      username: 'admin',
      displayName: 'Solazhu',
      password: 'correct horse battery staple',
      confirmation: 'correct horse battery staple',
    })
    const previousCapturePath = process.env.ADMIN_INIT_CAPTURE
    process.env.ADMIN_INIT_CAPTURE = capturePath

    try {
      await putRemoteSecret(encoded, fakeCommandPath)
    } finally {
      if (previousCapturePath === undefined) delete process.env.ADMIN_INIT_CAPTURE
      else process.env.ADMIN_INIT_CAPTURE = previousCapturePath
    }

    const capture = JSON.parse(await readFile(capturePath, 'utf8')) as {
      argv: string[]
      stdin: string
    }
    expect(capture.argv).toEqual([
      'exec',
      'wrangler',
      'secret',
      'put',
      'ADMIN_AUTH_CONFIG',
    ])
    expect(capture.argv.join(' ')).not.toContain(encoded)
    expect(capture.stdin).toBe(`${encoded}\n`)
    expect(parseAdminAuthConfig(capture.stdin.trim())).toMatchObject({
      username: 'admin',
      displayName: 'Solazhu',
    })
  })
})
