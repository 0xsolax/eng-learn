import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWorkerApp, type WorkerApp } from '../../server/app'
import { createInMemoryAdminOperationLedger } from '../../server/repositories/adminOperationLedger'
import type { ContentRepository } from '../../server/repositories/contentRepository'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createInMemoryCourseRepository } from '../../server/repositories/inMemoryCourseRepository'
import { createInMemoryLessonReplayRepository } from '../../server/repositories/inMemoryLessonReplayRepository'
import { createInMemorySessionRepository } from '../../server/repositories/inMemorySessionRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { createCourseQueryService } from '../../server/services/CourseQueryService'
import { createCourseRuntime } from '../../server/services/CourseRuntime'
import { createLearnerSessionService } from '../../server/services/LearnerSessionService'
import { createLearningProgressService } from '../../server/services/LearningProgressService'
import { createLessonReplayService } from '../../server/services/LessonReplayService'
import type { AdminExerciseItemDto } from '../../shared/api/contentSchemas'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

const ORIGIN = 'https://eng-learn.test'

type WriteOperation = 'edit' | 'approve' | 'disable' | 'publish' | 'discard'
type GatedMethod =
  | 'updateExerciseItems'
  | 'requestExerciseItemRework'
  | 'publishSourceVersion'
  | 'archiveDraftVersion'

const WRITE_CASES: Array<{
  operation: WriteOperation
  gatedMethod: GatedMethod
}> = [
  { operation: 'edit', gatedMethod: 'updateExerciseItems' },
  { operation: 'approve', gatedMethod: 'updateExerciseItems' },
  { operation: 'disable', gatedMethod: 'updateExerciseItems' },
  { operation: 'publish', gatedMethod: 'publishSourceVersion' },
  { operation: 'discard', gatedMethod: 'archiveDraftVersion' },
]

describe.each(WRITE_CASES)('Content CAS API race: $operation', ({ operation, gatedMethod }) => {
  it('returns source_version_immutable when a competing request publishes first', async () => {
    const fixture = await createFixture(operation)
    const gate = createGatedRepository(fixture.repository, gatedMethod)
    const writeTimes: string[] = []
    const app = createContentRaceApp(gate.repository, () => {
      const value = new Date(
        Date.UTC(2026, 6, 13, 2, 0, writeTimes.length),
      )
      writeTimes.push(value.toISOString())
      return value
    })
    const original = app.fetch(operationRequest(operation, fixture))

    await gate.reached

    const racerResponses = operation === 'approve'
      ? [
          await app.fetch(itemActionRequest(fixture.item.id, 'approve')),
          await app.fetch(versionActionRequest(fixture.versionId, 'publish')),
        ]
      : [await app.fetch(versionActionRequest(fixture.versionId, 'publish'))]

    gate.release()

    const response = await original
    expect(racerResponses.map((racer) => racer.status)).toEqual(
      Array.from({ length: racerResponses.length }, () => 200),
    )
    expect(response.status).toBe(409)
    await expect(errorCode(response)).resolves.toBe('source_version_immutable')

    const snapshot = await requireSnapshot(fixture.repository, fixture.versionId)
    expect(snapshot.version.status).toBe('published')
    expect(snapshot.version.contentRevision).toBe(
      fixture.revisionBeforeRace + (operation === 'approve' ? 1 : 0),
    )

    if (operation === 'publish') {
      expect(writeTimes).toHaveLength(2)
      expect(snapshot.version.publishedAt).toBe(writeTimes[1])
    }
  })

  it('returns conflict and preserves only a competing edit when revision drifts', async () => {
    const fixture = await createFixture(operation)
    const gate = createGatedRepository(fixture.repository, gatedMethod)
    const app = createContentRaceApp(
      gate.repository,
      () => new Date('2026-07-13T02:00:00.000Z'),
    )
    const original = app.fetch(operationRequest(operation, fixture))

    await gate.reached
    const racer = await app.fetch(editRequest(fixture.item, 'race-winner'))
    gate.release()

    const response = await original
    expect(racer.status).toBe(200)
    expect(response.status).toBe(409)
    await expect(errorCode(response)).resolves.toBe('conflict')

    const snapshot = await requireSnapshot(fixture.repository, fixture.versionId)
    const storedItem = snapshot.exerciseItems.find((item) => item.id === fixture.item.id)

    expect(snapshot.version).toMatchObject({
      status: 'draft',
      contentRevision: fixture.revisionBeforeRace + 1,
    })
    expect(storedItem?.status).toBe('draft')
    expect(storedItem?.prompt).toMatchObject({ meaning: 'race-winner' })
  })
})

describe.each([
  { action: 'approve' as const, operation: 'approve' as const, gatedMethod: 'updateExerciseItems' as const },
  { action: 'request_rework' as const, operation: 'edit' as const, gatedMethod: 'requestExerciseItemRework' as const },
  { action: 'correct' as const, operation: 'edit' as const, gatedMethod: 'updateExerciseItems' as const },
])('Exercise review CAS API race: $action', ({ action, operation, gatedMethod }) => {
  it('returns conflict and preserves only a competing edit', async () => {
    const fixture = await createFixture(operation)
    const gate = createGatedRepository(fixture.repository, gatedMethod)
    const app = createContentRaceApp(
      gate.repository,
      () => new Date('2026-07-17T02:00:00.000Z'),
    )
    const command = action === 'approve'
      ? { action, expectedContentRevision: fixture.revisionBeforeRace }
      : action === 'request_rework'
        ? {
            action,
            expectedContentRevision: fixture.revisionBeforeRace,
            feedback: '并发测试反馈',
          }
        : {
            action,
            expectedContentRevision: fixture.revisionBeforeRace,
            content: editContent(fixture.item, 'original-correction'),
          }
    const original = app.fetch(reviewDecisionRequest(fixture.item.id, command))

    await gate.reached
    const racer = await app.fetch(editRequest(fixture.item, 'race-winner'))
    gate.release()

    const response = await original
    expect(racer.status).toBe(200)
    expect(response.status).toBe(409)
    await expect(errorCode(response)).resolves.toBe('conflict')

    const snapshot = await requireSnapshot(fixture.repository, fixture.versionId)
    const storedItem = snapshot.exerciseItems.find((item) => item.id === fixture.item.id)
    const feedback = await fixture.repository.getExerciseReviewFeedback([fixture.item.id])

    expect(snapshot.version.contentRevision).toBe(fixture.revisionBeforeRace + 1)
    expect(storedItem).toMatchObject({ status: 'draft', prompt: { meaning: 'race-winner' } })
    expect(feedback).toEqual([])
  })
})

const createFixture = async (operation: WriteOperation) => {
  const repository = createInMemoryContentRepository()
  const builder = createContentBuilder({
    repository,
    now: () => new Date('2026-07-13T00:00:00.000Z'),
  })
  const draft = await builder.importNewSourceIdempotently({ operationToken: generateAdminOperationToken(),
    sourceName: `CAS ${operation}`,
    words: Array.from({ length: 5 }, (_, index) => ({
      word: `word-${String(index + 1)}`,
      meaning: `meaning-${String(index + 1)}`,
      examplePhrase: `word-${String(index + 1)}`,
      exampleSentence: `I use word-${String(index + 1)} here.`,
      exampleSentenceExtended: `I use word-${String(index + 1)} here every day.`,
    })),
  })

  await builder.buildExerciseItems(draft.versionId)
  const items = await builder.listExerciseItems(draft.versionId)
  await builder.approveExerciseItems(items.map((item) => item.id))

  const firstItem = items.find((item) => item.taskType === 'recognize_meaning')

  if (!firstItem) throw new Error('Expected a recognition item')

  if (operation === 'approve') {
    await builder.editExerciseItem(firstItem.id, editContent(firstItem, 'approval-seed'))
  }

  const item = await builder.getExerciseItem(firstItem.id)
  const snapshot = await requireSnapshot(repository, draft.versionId)

  return {
    repository,
    versionId: draft.versionId,
    item,
    revisionBeforeRace: snapshot.version.contentRevision,
  }
}

const createContentRaceApp = (
  contentRepository: ContentRepository,
  now: () => Date,
): WorkerApp => {
  const operationLedger = createInMemoryAdminOperationLedger()
  const courseRepository = createInMemoryCourseRepository({ ledger: operationLedger })
  const sessionRepository = createInMemorySessionRepository({
    credentialPort: courseRepository,
    ledger: operationLedger,
  })
  const replayRepository = createInMemoryLessonReplayRepository()

  return createWorkerApp({
    contentBuilder: createContentBuilder({ repository: contentRepository, now }),
    courseRuntime: createCourseRuntime({
      contentRepository,
      courseRepository,
      operationLedger,
      now,
      queueWriteMode: 'v2',
      flowWriteMode: 'legacy_v1',
    }),
    courseQueryService: createCourseQueryService({
      contentRepository,
      courseRepository,
      flowWriteMode: 'legacy_v1',
    }),
    courseRepository,
    lessonReplayService: createLessonReplayService({
      courseRepository,
      replayRepository,
      now,
    }),
    learningProgressService: createLearningProgressService({
      courseRepository,
      now,
    }),
    learnerSessionService: createLearnerSessionService({
      courseRepository,
      sessionRepository,
      operationLedger,
      now,
    }),
    adminAuthentication: {
      accessAuthenticator: {
        authenticate: () =>
          Promise.resolve({
            source: 'cloudflare_access',
            subject: 'content-cas-admin',
          }),
      },
      allowedOrigin: ORIGIN,
    },
  })
}

const createGatedRepository = (
  stored: ContentRepository,
  gatedMethod: GatedMethod,
) => {
  const reached = createDeferred()
  const released = createDeferred()
  let didGate = false

  const waitAtGate = async (method: GatedMethod): Promise<void> => {
    if (method !== gatedMethod || didGate) return
    didGate = true
    reached.resolve()
    await released.promise
  }

  const repository: ContentRepository = {
    ...stored,
    async updateExerciseItems(versionId, items, expectedRevision) {
      await waitAtGate('updateExerciseItems')
      return stored.updateExerciseItems(versionId, items, expectedRevision)
    },
    async requestExerciseItemRework(versionId, itemId, feedbackText, requestedAt, expectedRevision) {
      await waitAtGate('requestExerciseItemRework')
      return stored.requestExerciseItemRework(
        versionId,
        itemId,
        feedbackText,
        requestedAt,
        expectedRevision,
      )
    },
    async publishSourceVersion(versionId, publishedAt, expectedRevision) {
      await waitAtGate('publishSourceVersion')
      return stored.publishSourceVersion(versionId, publishedAt, expectedRevision)
    },
    async archiveDraftVersion(versionId, expectedRevision) {
      await waitAtGate('archiveDraftVersion')
      return stored.archiveDraftVersion(versionId, expectedRevision)
    },
  }

  return {
    repository,
    reached: reached.promise,
    release: released.resolve,
  }
}

const operationRequest = (
  operation: WriteOperation,
  fixture: { versionId: string; item: AdminExerciseItemDto },
): Request => {
  switch (operation) {
    case 'edit':
      return editRequest(fixture.item, 'original-edit')
    case 'approve':
      return itemActionRequest(fixture.item.id, 'approve')
    case 'disable':
      return itemActionRequest(fixture.item.id, 'disable')
    case 'publish':
      return versionActionRequest(fixture.versionId, 'publish')
    case 'discard':
      return versionActionRequest(fixture.versionId, 'discard')
  }
}

const editRequest = (item: AdminExerciseItemDto, meaning: string): Request =>
  request(`/api/admin/exercise-items/${item.id}`, {
    method: 'PUT',
    body: { content: editContent(item, meaning) },
  })

const editContent = (item: AdminExerciseItemDto, meaning: string) => ({
  stage: 'S0' as const,
  taskType: 'recognize_meaning' as const,
  prompt: {
    word: item.word,
    meaning,
    exampleSentence: `I use ${item.word} here.`,
  },
  answer: { word: item.word, expectedResponse: 'known' as const },
})

const itemActionRequest = (itemId: string, action: 'approve' | 'disable'): Request =>
  request(`/api/admin/exercise-items/${itemId}/${action}`, { method: 'POST' })

const versionActionRequest = (
  versionId: string,
  action: 'publish' | 'discard',
): Request =>
  request(`/api/admin/source-versions/${versionId}/${action}`, { method: 'POST' })

const reviewDecisionRequest = (itemId: string, body: unknown): Request =>
  request(`/api/admin/exercise-items/${itemId}/review/decision`, {
    method: 'POST',
    body,
  })

const request = (
  path: string,
  input: { method: 'POST' | 'PUT'; body?: unknown },
): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: input.method,
    headers: {
      'cf-access-jwt-assertion': 'controlled-test-assertion',
      origin: ORIGIN,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })

const errorCode = async (response: Response): Promise<string> => {
  const body: unknown = await response.json()
  const envelope = z
    .looseObject({
      ok: z.literal(false),
      error: z.looseObject({ code: z.string() }),
    })
    .parse(body)

  return envelope.error.code
}

const requireSnapshot = async (repository: ContentRepository, versionId: string) => {
  const snapshot = await repository.getSourceVersion(versionId)

  if (!snapshot) throw new Error(`Source version ${versionId} is missing`)

  return snapshot
}

const createDeferred = () => {
  let resolvePromise: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}
