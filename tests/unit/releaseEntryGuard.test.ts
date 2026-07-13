import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release entry guard', () => {
  it('does not expose a package script that deploys the default production binding directly', async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const scripts = readScripts(packageJson)

    expect(scripts.deploy).toBeUndefined()
    expect(Object.values(scripts)).not.toContain('wrangler deploy')
  })
})

const readScripts = (packageJson: unknown): Record<string, string> => {
  if (!packageJson || typeof packageJson !== 'object' || !('scripts' in packageJson)) {
    throw new Error('package.json scripts are missing')
  }

  const scripts = packageJson.scripts

  if (!scripts || typeof scripts !== 'object') {
    throw new Error('package.json scripts are invalid')
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
