import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'

describe('in-memory content repository CAS classification', () => {
  it('classifies non-draft and revision-mismatch writes without hiding missing rows', async () => {
    const immutableRepository = createInMemoryContentRepository()
    await createVersion(immutableRepository, 'immutable-version', 0)
    await immutableRepository.publishSourceVersion(
      'immutable-version',
      '2026-07-13T01:00:00.000Z',
      0,
    )

    await expect(
      immutableRepository.updateExerciseItems('immutable-version', [], 0),
    ).rejects.toMatchObject({ code: 'source_version_immutable' })

    const archivedRepository = createInMemoryContentRepository()
    await createVersion(archivedRepository, 'archived-version', 0)
    await archivedRepository.archiveDraftVersion('archived-version', 0)
    await expect(
      archivedRepository.updateExerciseItems('archived-version', [], 0),
    ).rejects.toMatchObject({ code: 'source_version_immutable' })

    const conflictRepository = createInMemoryContentRepository()
    await createVersion(conflictRepository, 'conflict-version', 1)
    await expect(
      conflictRepository.archiveDraftVersion('conflict-version', 0),
    ).rejects.toMatchObject({ code: 'conflict' })

    const missing = await conflictRepository
      .archiveDraftVersion('missing-version', 0)
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ message: 'Source version missing-version is missing' })
    expect(missing).not.toHaveProperty('code')
  })
})

const createVersion = (
  repository: ReturnType<typeof createInMemoryContentRepository>,
  versionId: string,
  contentRevision: number,
) =>
  repository.createSourceVersion({
    source: {
      id: `source-${versionId}`,
      name: `Source ${versionId}`,
      createdAt: '2026-07-13T00:00:00.000Z',
    },
    version: {
      id: versionId,
      sourceId: `source-${versionId}`,
      versionNo: 1,
      contentRevision,
      status: 'draft',
      createdAt: '2026-07-13T00:00:00.000Z',
    },
    words: [],
    groups: [],
  })
