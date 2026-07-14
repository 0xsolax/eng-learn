import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface AdminInitModule {
  createSerializedAdminConfig: (input: {
    username: string
    displayName: string
    password: string
    confirmation: string
  }) => Promise<string>
  replaceAdminAuthConfig: (current: string, encoded: string) => string
  writeLocalAdminConfig: (path: string, encoded: string) => Promise<void>
}

const moduleUrl = new URL('../../scripts/admin-init.mjs', import.meta.url).href
const adminInitModule: unknown = await import(moduleUrl)
const {
  createSerializedAdminConfig,
  replaceAdminAuthConfig,
  writeLocalAdminConfig,
} = adminInitModule as AdminInitModule

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

  it('atomically writes a local config with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-admin-init-'))
    temporaryRoots.push(root)
    const path = join(root, '.dev.vars')
    await writeFile(path, '# keep this comment\nAPP_ORIGIN=https://example.test\n')

    await writeLocalAdminConfig(path, 'v1.generated')

    expect(await readFile(path, 'utf8')).toBe(
      '# keep this comment\nAPP_ORIGIN=https://example.test\nADMIN_AUTH_CONFIG=v1.generated\n',
    )
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
