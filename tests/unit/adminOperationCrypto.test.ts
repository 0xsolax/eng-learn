import { describe, expect, it } from 'vitest'
import {
  ADMIN_ACCESS_CODE_ALPHABET,
  deriveAdminOperationAccessCode,
  fingerprintAdminOperationRequest,
  hashAdminOperationToken,
} from '../../server/security/adminOperationCrypto'
import {
  generateAdminOperationToken,
  parseAdminOperationToken,
} from '../../shared/security/adminOperationToken'

describe('admin operation crypto', () => {
  it('accepts and generates only canonical 256-bit operation tokens', () => {
    expect(parseAdminOperationToken('00'.repeat(32))).toBe('00'.repeat(32))
    expect(parseAdminOperationToken('AA'.repeat(32))).toBeUndefined()
    expect(parseAdminOperationToken('short')).toBeUndefined()

    const first = generateAdminOperationToken()
    const second = generateAdminOperationToken()

    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).not.toBe(first)
  })

  it('hashes one raw token into a stable operation identity without a kind split', async () => {
    const token = parseAdminOperationToken('00'.repeat(32))

    if (!token) throw new Error('Fixture operation token is invalid')

    await expect(hashAdminOperationToken(token)).resolves.toBe(
      'sha256:eec1a4534a19ea5707bd53b0331dab488ddb0dd71da742718680ee7a83455879',
    )
  })

  it('fingerprints normalized create and rotate requests with typed domain separation', async () => {
    await expect(
      fingerprintAdminOperationRequest({
        kind: 'create_course',
        learnerName: 'Alice',
        sourceVersionId: 'version-1',
      }),
    ).resolves.toBe(
      'sha256:7df81a80b9fc817c22c7d7a10d70ceaf332483002409fdc8aa8763d1038af039',
    )
    await expect(
      fingerprintAdminOperationRequest({
        kind: 'rotate_access_code',
        learnerId: 'learner-1',
        expectedCredentialVersion: 1,
      }),
    ).resolves.toBe(
      'sha256:836670382fe57c4ad8490da327f508f3f2a9bf78529790a0e00d41d2b4a48f8e',
    )
  })

  it('derives an unbiased code from a 32-character alphabet and separates operation kinds', async () => {
    const token = parseAdminOperationToken('00'.repeat(32))

    if (!token) throw new Error('Fixture operation token is invalid')

    expect(ADMIN_ACCESS_CODE_ALPHABET).toHaveLength(32)
    await expect(deriveAdminOperationAccessCode('create_course', token)).resolves.toBe(
      'TG6TEABA34',
    )
    await expect(deriveAdminOperationAccessCode('rotate_access_code', token)).resolves.toBe(
      '4ULJ3Y5BE2',
    )
  })
})
