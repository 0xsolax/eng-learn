import { describe, expect, it } from 'vitest'
import {
  SECRET_ENVIRONMENT_NAMES,
  createSecretFreeEnvironment,
} from '../../scripts/isolated-secret-environment.mjs'

describe('isolated script environment', () => {
  it('removes every deployment and administrator secret without mutating the source', () => {
    const source: NodeJS.ProcessEnv = { APP_ORIGIN: 'https://example.test' }
    for (const name of SECRET_ENVIRONMENT_NAMES) {
      source[name] = `secret-for-${name}`
    }

    const isolated = createSecretFreeEnvironment(source)

    expect(source.ADMIN_AUTH_CONFIG).toBe('secret-for-ADMIN_AUTH_CONFIG')
    expect(isolated.APP_ORIGIN).toBe('https://example.test')
    for (const name of SECRET_ENVIRONMENT_NAMES) {
      expect(isolated).not.toHaveProperty(name)
    }
  })
})
