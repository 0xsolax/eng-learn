import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { selectApprovedExerciseItem } from '../../server/services/ApprovedExerciseSelector'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { generateAdminOperationToken } from '../../shared/security/adminOperationToken'

describe('approved exercise selector', () => {
  it('selects the stable approved S1 item required by each content model', async () => {
    const repository = createInMemoryContentRepository()
    const builder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    })
    const imported = await builder.importNewSourceIdempotently({
      operationToken: generateAdminOperationToken(),
      sourceName: 'Selector source',
      words: Array.from({ length: 5 }, (_, index) => ({
        word: `word-${String(index + 1)}`,
        meaning: `meaning-${String(index + 1)}`,
        examplePhrase: `word-${String(index + 1)}`,
        exampleSentence: `I use word-${String(index + 1)}.`,
        exampleSentenceExtended: `I use word-${String(index + 1)} every day.`,
      })),
    })

    await builder.buildExerciseItems(imported.versionId)
    const items = await builder.listExerciseItems(imported.versionId)
    await builder.approveExerciseItems(items.map((item) => item.id))
    await builder.publishVersion(imported.versionId)
    const snapshot = await repository.getSourceVersion(imported.versionId)

    if (!snapshot) throw new Error('Expected a published source snapshot')

    const word = snapshot.words[0]
    const progressiveS1 = snapshot.exerciseItems.find(
      (item) =>
        item.wordId === word?.id &&
        item.stage === 'S1' &&
        item.taskType === 'multiple_choice',
    )
    const progressiveS2 = snapshot.exerciseItems.find(
      (item) =>
        item.wordId === word?.id &&
        item.stage === 'S2' &&
        item.taskType === 'recall_word',
    )

    if (!word || !progressiveS1 || !progressiveS2) {
      throw new Error('Expected progressive S1 and S2 exercise items')
    }

    const deterministicSnapshot = {
      ...snapshot,
      exerciseItems: [
        { ...progressiveS1, id: '000-draft', status: 'draft' as const },
        { ...progressiveS1, id: '002-approved' },
        { ...progressiveS1, id: '001-approved' },
        { ...progressiveS2, id: '000-wrong-task', stage: 'S1' as const },
      ],
    }

    expect(selectApprovedExerciseItem(deterministicSnapshot, word.id, 'S1')?.id).toBe(
      '001-approved',
    )

    const legacySnapshot = {
      ...deterministicSnapshot,
      version: {
        ...deterministicSnapshot.version,
        contentModel: 'v1_single_sentence' as const,
      },
    }

    expect(selectApprovedExerciseItem(legacySnapshot, word.id, 'S1')?.id).toBe(
      '000-wrong-task',
    )
  })
})
