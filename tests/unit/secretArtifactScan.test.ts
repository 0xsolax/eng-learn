import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const scannerPath = fileURLToPath(
  new URL('../../scripts/check-no-secret-artifacts.mjs', import.meta.url),
)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const createArtifactRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'eng-learn-secret-scan-'))
  temporaryRoots.push(root)
  return root
}

const runScanner = (root: string) =>
  spawnSync(process.execPath, [scannerPath, root], {
    encoding: 'utf8',
  })

describe('secret artifact scanner', () => {
  it('accepts runtime routes and relative Cloudflare artifact paths', async () => {
    const root = await createArtifactRoot()
    await mkdir(join(root, 'client'), { recursive: true })
    await writeFile(join(root, 'client', 'index.js'), 'fetch("/api/app/courses")')
    await writeFile(
      join(root, 'wrangler.json'),
      JSON.stringify({
        configPath: '../../wrangler.jsonc',
        userConfigPath: '../../wrangler.jsonc',
        main: 'index.js',
        assets: { directory: '../client' },
        d1_databases: [{ migrations_dir: '../../migrations' }],
      }),
    )

    const result = runScanner(root)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Secret artifact scan passed')
  })

  it('rejects build-machine paths in generated source-region metadata', async () => {
    const root = await createArtifactRoot()
    const sentinel = '/Users/build-agent/work/eng-learn/node_modules/example/index.mjs'
    await writeFile(
      join(root, 'index.js'),
      `//#region ../../../../..${sentinel}\nconsole.log("ready")\n//#endregion`,
    )

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('host-path-metadata')
    expect(output).not.toContain(sentinel)
  })

  it('rejects absolute config paths in generated Wrangler artifacts', async () => {
    const root = await createArtifactRoot()
    const sentinel = '/private/var/folders/build/eng-learn/wrangler.jsonc'
    await writeFile(
      join(root, 'wrangler.json'),
      JSON.stringify({ configPath: sentinel, userConfigPath: sentinel, main: 'index.js' }),
    )

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('host-path-metadata')
    expect(output).not.toContain(sentinel)
  })

  it('rejects dotenv and preview-secret files without printing their values', async () => {
    const root = await createArtifactRoot()
    const sentinel = 'do-not-print-this-value'
    await writeFile(join(root, '.dev.vars'), `ADMIN_API_TOKEN=${sentinel}`)

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('forbidden-secret-file')
    expect(output).not.toContain(sentinel)
  })

  it('rejects sensitive assignments inside text bundles without echoing content', async () => {
    const root = await createArtifactRoot()
    const sentinel = 'inline-do-not-print'
    await writeFile(join(root, 'index.js'), `const ADMIN_API_TOKEN = "${sentinel}"`)

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('sensitive-assignment')
    expect(output).not.toContain(sentinel)
  })

  it('rejects trace, HAR and storage-state artifacts by filename', async () => {
    const root = await createArtifactRoot()
    await writeFile(join(root, 'trace.zip'), 'opaque')
    await writeFile(join(root, 'requests.har'), 'opaque')
    await writeFile(join(root, 'storage-state.json'), '{}')

    const result = runScanner(root)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('sensitive-test-artifact')
  })

  it('rejects leaked learning codes, learner cookies, and Access assertions without echoing them', async () => {
    const root = await createArtifactRoot()
    const learningCode = 'ABCDEFGH23'
    const sessionToken = 'a'.repeat(64)
    const accessAssertion = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature'
    await writeFile(
      join(root, 'failure.json'),
      JSON.stringify({
        accessCode: learningCode,
        cookie: `__Host-eng_learn_session=${sessionToken}`,
        'Cf-Access-Jwt-Assertion': accessAssertion,
      }),
    )

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('sensitive-assignment')
    expect(output).not.toContain(learningCode)
    expect(output).not.toContain(sessionToken)
    expect(output).not.toContain(accessAssertion)
  })

  it('rejects unquoted dotenv, log headers, and learning codes without printing values', async () => {
    const root = await createArtifactRoot()
    const values = {
      admin: 'plain-admin-secret',
      bearer: 'plain-bearer-secret',
      service: 'plain-service-secret',
      assertion: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
      code: 'ABCDEFGH23',
    }
    const files = {
      'dotenv.log': `ADMIN_API_TOKEN=${values.admin}`,
      'authorization.log': `authorization: Bearer ${values.bearer}`,
      'service-header.log': `x-admin-token: ${values.service}`,
      'access-header.log': `cf-access-jwt-assertion: ${values.assertion}`,
      'learning-code.log': `access_code=${values.code}`,
    }

    await Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)),
    )

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    for (const name of Object.keys(files)) expect(output).toContain(name)
    for (const value of Object.values(values)) expect(output).not.toContain(value)
  })

  it('rejects raw admin operation tokens in text artifacts without echoing them', async () => {
    const root = await createArtifactRoot()
    const operationToken = 'f'.repeat(64)
    await writeFile(
      join(root, 'network-failure.json'),
      JSON.stringify({ operationToken }),
    )

    const result = runScanner(root)
    const output = `${result.stdout}${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('sensitive-assignment')
    expect(output).not.toContain(operationToken)
  })
})
