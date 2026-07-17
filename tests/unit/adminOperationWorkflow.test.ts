import { describe, expect, it } from 'vitest'
import {
  createInMemoryAdminOperationLedger,
  type AdminOperationLedgerReader,
} from '../../server/repositories/adminOperationLedger'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import type { ContentRepository } from '../../server/repositories/contentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import { DomainError } from '../../server/errors/DomainError'
import { prepareAdminOperation } from '../../server/services/adminOperation'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const NOW = new Date('2026-07-13T00:00:00.000Z')
const CREATE_TOKEN = '1'.repeat(64)
const ROTATE_TOKEN_A = '2'.repeat(64)
const ROTATE_TOKEN_B = '3'.repeat(64)
const SOURCE_TOKEN = '4'.repeat(64)
const NEXT_VERSION_TOKEN = '5'.repeat(64)
const WORDS = [
  {
    word: 'apple',
    meaning: '苹果',
    examplePhrase: 'An apple',
    exampleSentence: 'I eat an apple.',
    exampleSentenceExtended: 'I eat an apple every day.',
    partOfSpeech: 'noun',
  },
]

describe('admin operation workflow', () => {
  it('replays a committed new-source import without creating a duplicate', async () => {
    const fixture = createFixture()
    const command = {
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: WORDS,
    }

    const first = await fixture.contentBuilder.importNewSourceIdempotently(command)
    const replay = await fixture.contentBuilder.importNewSourceIdempotently(command)

    expect(replay).toEqual(first)
    await expect(fixture.contentBuilder.listSourceVersions()).resolves.toHaveLength(1)
    await expect(
      fixture.contentBuilder.importNewSourceIdempotently({
        ...command,
        sourceName: 'Changed',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('replays the original draft result after the imported version is archived', async () => {
    const fixture = createFixture()
    const command = {
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: WORDS,
    }
    const imported = await fixture.contentBuilder.importNewSourceIdempotently(command)

    await fixture.contentBuilder.discardDraft(imported.versionId)

    await expect(
      fixture.contentBuilder.importNewSourceIdempotently(command),
    ).resolves.toEqual(imported)
  })

  it('replays one next-version import and fingerprints every learning context field', async () => {
    const fixture = createFixture()
    const firstWord = WORDS[0]

    if (!firstWord) throw new Error('Expected one import word')

    await createPublishedVersion(fixture)
    const [published] = await fixture.contentBuilder.listSourceVersions()

    if (!published) throw new Error('Expected one published source version')

    const command = {
      operationToken: NEXT_VERSION_TOKEN,
      sourceId: published.sourceId,
      words: WORDS,
    }
    const first = await fixture.contentBuilder.importNextVersionIdempotently(command)
    const replay = await fixture.contentBuilder.importNextVersionIdempotently(command)

    expect(replay).toEqual(first)
    await expect(fixture.contentBuilder.listSourceVersions()).resolves.toHaveLength(2)
    await expect(
      fixture.contentBuilder.importNextVersionIdempotently({
        ...command,
        words: [
          {
            ...firstWord,
            exampleSentenceExtended: 'I eat an apple after school.',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('returns a stable reconciliation result when commit status cannot be read', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const storedRepository = createInMemoryContentRepository({ ledger })
    let ledgerReadCount = 0
    const operationLedger: AdminOperationLedgerReader = {
      async get(operationHash) {
        ledgerReadCount += 1

        if (ledgerReadCount === 2) {
          throw new Error('Injected ledger read failure')
        }

        return ledger.get(operationHash)
      },
    }
    let loseCreateResponse = true
    const repository: ContentRepository = {
      ...storedRepository,
      async createSourceVersion(input) {
        const snapshot = await storedRepository.createSourceVersion(input)

        if (loseCreateResponse) {
          loseCreateResponse = false
          throw new Error('Injected lost create response')
        }

        return snapshot
      },
    }
    const contentBuilder = createContentBuilder({
      repository,
      operationLedger,
      now: () => NOW,
    })
    const command = {
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: WORDS,
    }

    await expect(
      contentBuilder.importNewSourceIdempotently(command),
    ).rejects.toMatchObject({ code: 'import_reconcile_required' })
    await expect(
      contentBuilder.importNewSourceIdempotently(command),
    ).resolves.toMatchObject({ versionNo: 1, wordCount: 1 })
    await expect(contentBuilder.listSourceVersions()).resolves.toHaveLength(1)
  })

  it('requires reconciliation when the initial new-source ledger read fails', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const repository = createInMemoryContentRepository({ ledger })
    const contentBuilder = createContentBuilder({
      repository,
      operationLedger: {
        get() {
          return Promise.reject(new Error('Injected initial ledger read failure'))
        },
      },
      now: () => NOW,
    })

    await expect(
      contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Starter',
        words: WORDS,
      }),
    ).rejects.toMatchObject({ code: 'import_reconcile_required' })
    await expect(contentBuilder.listSourceVersions()).resolves.toHaveLength(0)
  })

  it('requires reconciliation when the initial next-version ledger read fails', async () => {
    const fixture = createFixture()
    const sourceVersionId = await createPublishedVersion(fixture)
    const snapshot = await fixture.contentRepository.getSourceVersion(sourceVersionId)

    if (!snapshot) throw new Error('Expected one published source version')

    const contentBuilder = createContentBuilder({
      repository: fixture.contentRepository,
      operationLedger: {
        get() {
          return Promise.reject(new Error('Injected initial ledger read failure'))
        },
      },
      now: () => NOW,
    })

    await expect(
      contentBuilder.importNextVersionIdempotently({
        operationToken: NEXT_VERSION_TOKEN,
        sourceId: snapshot.source.id,
        words: WORDS,
      }),
    ).rejects.toMatchObject({ code: 'import_reconcile_required' })
    await expect(contentBuilder.listSourceVersions()).resolves.toHaveLength(1)
  })

  it('requires reconciliation when import schema readiness cannot be determined', async () => {
    const storedRepository = createInMemoryContentRepository()
    const repository: ContentRepository = {
      ...storedRepository,
      assertImportSchemaReady() {
        return Promise.reject(
          new DomainError('dependency_failure', 'Injected readiness failure'),
        )
      },
    }
    const contentBuilder = createContentBuilder({ repository, now: () => NOW })

    await expect(
      contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Starter',
        words: WORDS,
      }),
    ).rejects.toMatchObject({ code: 'import_reconcile_required' })
    await expect(contentBuilder.listSourceVersions()).resolves.toHaveLength(0)
  })

  it('replays a committed import before probing schema readiness again', async () => {
    const storedRepository = createInMemoryContentRepository()
    let readinessAvailable = true
    const repository: ContentRepository = {
      ...storedRepository,
      assertImportSchemaReady() {
        return readinessAvailable
          ? Promise.resolve()
          : Promise.reject(
              new DomainError('dependency_failure', 'Injected readiness failure'),
            )
      },
    }
    const contentBuilder = createContentBuilder({ repository, now: () => NOW })
    const command = {
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: WORDS,
    }
    const imported = await contentBuilder.importNewSourceIdempotently(command)
    readinessAvailable = false

    await expect(
      contentBuilder.importNewSourceIdempotently(command),
    ).resolves.toEqual(imported)
  })

  it('keeps a committed import recoverable while its outcome is temporarily unreadable', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const storedRepository = createInMemoryContentRepository({ ledger })
    let loseCreateResponse = true
    let failOutcomeRead = true
    const repository: ContentRepository = {
      ...storedRepository,
      async createSourceVersion(input) {
        const snapshot = await storedRepository.createSourceVersion(input)

        if (loseCreateResponse) {
          loseCreateResponse = false
          throw new Error('Injected lost create response')
        }

        return snapshot
      },
      async getSourceVersion(versionId) {
        if (failOutcomeRead) {
          failOutcomeRead = false
          return undefined
        }

        return storedRepository.getSourceVersion(versionId)
      },
    }
    const contentBuilder = createContentBuilder({
      repository,
      operationLedger: ledger,
      now: () => NOW,
    })
    const command = {
      operationToken: SOURCE_TOKEN,
      sourceName: 'Starter',
      words: WORDS,
    }

    await expect(
      contentBuilder.importNewSourceIdempotently(command),
    ).rejects.toMatchObject({ code: 'import_reconcile_required' })
    await expect(
      contentBuilder.importNewSourceIdempotently(command),
    ).resolves.toMatchObject({ versionNo: 1, wordCount: 1 })
    await expect(contentBuilder.listSourceVersions()).resolves.toHaveLength(1)
  })

  it('replays a legacy v1 import fingerprint but rejects changed progressive context', async () => {
    const ledger = createInMemoryAdminOperationLedger()
    const repository = createInMemoryContentRepository({ ledger })
    const contentBuilder = createContentBuilder({
      repository,
      operationLedger: ledger,
      now: () => NOW,
    })
    const imported = await contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
      sourceName: 'Legacy source',
      words: WORDS,
    })
    const prepared = await prepareAdminOperation(SOURCE_TOKEN, {
      kind: 'create_source',
      sourceName: 'Legacy source',
      words: WORDS,
    })

    ledger.insert({
      operationHash: prepared.operationHash,
      kind: 'create_source',
      targetId: 'new-source',
      requestFingerprint: prepared.requestFingerprint,
      outcomeSourceId: imported.sourceId,
      outcomeSourceVersionId: imported.versionId,
      createdAt: NOW.toISOString(),
    })

    await expect(
      contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Legacy source',
        words: WORDS,
      }),
    ).resolves.toEqual(imported)
    await expect(
      contentBuilder.importNewSourceIdempotently({
        operationToken: SOURCE_TOKEN,
        sourceName: 'Legacy source',
        words: WORDS.map((word) => ({
          ...word,
          examplePhrase: 'A changed phrase',
        })),
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('replays course creation with the same one-time code and rejects cross-kind token reuse', async () => {
    const fixture = createFixture()
    const sourceVersionId = await createPublishedVersion(fixture)
    const command = {
      operationToken: CREATE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId,
    }

    const first = await fixture.courseRuntime.createCourseIdempotently(command)
    const replay = await fixture.courseRuntime.createCourseIdempotently(command)

    expect(replay).toEqual(first)
    await expect(fixture.courseRepository.listAdminCourses()).resolves.toHaveLength(1)
    await expect(
      fixture.contentBuilder.importNewSourceIdempotently({
        operationToken: CREATE_TOKEN,
        sourceName: 'Cross kind',
        words: WORDS,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rotates once, revokes once, and safely replays the exact committed operation', async () => {
    const fixture = createFixture()
    const sourceVersionId = await createPublishedVersion(fixture)
    const created = await fixture.courseRuntime.createCourseIdempotently({
      operationToken: CREATE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId,
    })
    const established = await fixture.sessionService.exchangeAccessCode(
      created.learner.accessCode,
    )
    expect(established).toBeDefined()

    if (!established) throw new Error('Expected a learner session')

    const command = {
      operationToken: ROTATE_TOKEN_A,
      expectedCredentialVersion: 1,
    }
    const first = await fixture.sessionService.rotateAccessCodeIdempotently(
      created.learner.id,
      command,
    )
    const replay = await fixture.sessionService.rotateAccessCodeIdempotently(
      created.learner.id,
      command,
    )

    expect(replay).toEqual(first)
    expect(first).toMatchObject({ credentialVersion: 2, revokedSessionCount: 1 })
    await expect(fixture.sessionService.resolve(established.token)).resolves.toEqual({
      status: 'revoked',
    })
  })

  it('allows only one different token to rotate the same expected credential version', async () => {
    const fixture = createFixture()
    const sourceVersionId = await createPublishedVersion(fixture)
    const created = await fixture.courseRuntime.createCourseIdempotently({
      operationToken: CREATE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId,
    })

    const results = await Promise.allSettled([
      fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
        operationToken: ROTATE_TOKEN_A,
        expectedCredentialVersion: 1,
      }),
      fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
        operationToken: ROTATE_TOKEN_B,
        expectedCredentialVersion: 1,
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'credential_conflict' })
  })

  it('fails closed when an older successful rotation is replayed after a newer rotation', async () => {
    const fixture = createFixture()
    const sourceVersionId = await createPublishedVersion(fixture)
    const created = await fixture.courseRuntime.createCourseIdempotently({
      operationToken: CREATE_TOKEN,
      learnerName: 'Alice',
      sourceVersionId,
    })
    const firstCommand = {
      operationToken: ROTATE_TOKEN_A,
      expectedCredentialVersion: 1,
    }

    await fixture.sessionService.rotateAccessCodeIdempotently(
      created.learner.id,
      firstCommand,
    )
    await fixture.sessionService.rotateAccessCodeIdempotently(created.learner.id, {
      operationToken: ROTATE_TOKEN_B,
      expectedCredentialVersion: 2,
    })

    await expect(
      fixture.sessionService.rotateAccessCodeIdempotently(
        created.learner.id,
        firstCommand,
      ),
    ).rejects.toMatchObject({ code: 'operation_superseded' })
    await expect(
      fixture.courseRuntime.createCourseIdempotently({
        operationToken: CREATE_TOKEN,
        learnerName: 'Alice',
        sourceVersionId,
      }),
    ).rejects.toMatchObject({ code: 'operation_superseded' })
  })
})

const createFixture = () => {
  const ledger = createInMemoryAdminOperationLedger()
  const contentRepository = createInMemoryContentRepository({ ledger })
  const courseRepository = createInMemoryCourseRepository({ ledger })
  const sessionRepository = createInMemorySessionRepository({
    credentialPort: courseRepository,
    ledger,
  })
  const contentBuilder = createContentBuilder({
    repository: contentRepository,
    operationLedger: ledger,
    now: () => NOW,
  })

  return {
    contentBuilder,
    contentRepository,
    courseRepository,
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      operationLedger: ledger,
      now: () => NOW,
      queueWriteMode: 'v2',
    }),
    sessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger: ledger,
      now: () => NOW,
      generateToken: () => 'a'.repeat(64),
    }),
  }
}

const createPublishedVersion = async (
  fixture: ReturnType<typeof createFixture>,
): Promise<string> => {
  const imported = await fixture.contentBuilder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
    sourceName: 'Published source',
    words: WORDS,
  })
  await fixture.contentBuilder.buildExerciseItems(imported.versionId)
  const snapshot = await fixture.contentRepository.getSourceVersion(imported.versionId)

  if (!snapshot) throw new DomainError('not_found', 'Fixture source version is missing')

  await fixture.contentRepository.updateExerciseItems(
    imported.versionId,
    snapshot.exerciseItems.map((item) => ({ ...item, status: 'approved' as const })),
    snapshot.version.contentRevision,
  )
  const updated = await fixture.contentRepository.getSourceVersion(imported.versionId)

  if (!updated) throw new DomainError('not_found', 'Fixture source version is missing')

  await fixture.contentRepository.publishSourceVersion(
    imported.versionId,
    NOW.toISOString(),
    updated.version.contentRevision,
  )

  return imported.versionId
}
