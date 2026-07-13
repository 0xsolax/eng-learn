import { describe, expect, it } from 'vitest'
import { createInMemoryAdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import { DomainError } from '../../server/errors/DomainError'

const NOW = new Date('2026-07-13T00:00:00.000Z')
const CREATE_TOKEN = '1'.repeat(64)
const ROTATE_TOKEN_A = '2'.repeat(64)
const ROTATE_TOKEN_B = '3'.repeat(64)
const SOURCE_TOKEN = '4'.repeat(64)
const WORDS = [
  {
    word: 'apple',
    meaning: '苹果',
    exampleSentence: 'I eat an apple.',
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
  const imported = await fixture.contentBuilder.importWords({
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
