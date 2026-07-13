import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('../../scripts/check-cloudflare-isolated.mjs', import.meta.url),
)

const runCheck = (args: string[]) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'true',
    },
  })

describe('isolated Cloudflare check command policy', () => {
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
