import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('../../scripts/check-cloudflare-isolated.mjs', import.meta.url),
)
const secretIsolatedScripts = [
  '../../scripts/build-release-isolated.mjs',
  '../../scripts/check-cloudflare-isolated.mjs',
  '../../scripts/generate-cloudflare-types-isolated.mjs',
  '../../scripts/run-stack-e2e.mjs',
]

const runCheck = (args: string[]) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'true',
    },
  })

describe('isolated Cloudflare check command policy', () => {
  it.each(secretIsolatedScripts)('%s clears inherited secrets through the shared policy', (path) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')

    expect(source).toContain('createSecretFreeEnvironment(process.env)')
    expect(source).not.toContain('const environment = { ...process.env }')
  })

  it('rejects unknown Wrangler commands before invoking Wrangler', () => {
    const result = runCheck(['unknown-command'])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      'Only read-only Cloudflare checks are allowed: check startup | types --check',
    )
    expect(result.stdout).not.toContain('Isolated Cloudflare check passed')
  })

  it('fails closed instead of accepting a preview deploy that can fall back to production', () => {
    const result = runCheck(['deploy', '--dry-run', '--env', 'preview'])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      'Only read-only Cloudflare checks are allowed: check startup | types --check',
    )
    expect(result.stdout).not.toContain('Isolated Cloudflare check passed')
  })
})
