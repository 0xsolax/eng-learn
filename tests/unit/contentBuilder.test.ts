import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import type { ImportWordInput } from '../../shared/domain/content'

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const wordNumber = index + 1
    const label = String(wordNumber)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      exampleSentence: `I can use word ${label}.`,
      partOfSpeech: 'noun',
    }
  })

describe('admin content building workflow', () => {
  it('imports twenty words into four groups and publishes a complete exercise version', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })

    const draft = await contentBuilder.importWords({
      sourceName: 'Test source',
      words: createWords(20),
    })

    expect(draft).toMatchObject({
      status: 'draft',
      wordCount: 20,
      groupCount: 4,
    })

    const coverage = await contentBuilder.buildExerciseItems(draft.versionId)

    expect(coverage).toMatchObject({
      sourceVersionId: draft.versionId,
      wordCount: 20,
      readyToPublish: true,
      missingItems: [],
    })

    const published = await contentBuilder.publishVersion(draft.versionId)

    expect(published).toEqual({
      sourceVersionId: draft.versionId,
      status: 'published',
    })
  })

  it('imports twenty two words into five groups', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })

    const draft = await contentBuilder.importWords({
      sourceName: 'Twenty two source',
      words: createWords(22),
    })

    expect(draft).toMatchObject({
      wordCount: 22,
      groupCount: 5,
    })
  })

  it('rejects empty or duplicate imported words before creating a draft version', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const duplicateWords = createWords(2)
    duplicateWords[1] = {
      word: 'word-1',
      meaning: 'meaning-copy',
      exampleSentence: 'I can use word copy.',
    }

    await expect(
      contentBuilder.importWords({
        sourceName: 'Invalid source',
        words: [
          {
            word: '',
            meaning: 'meaning',
            exampleSentence: 'I can use a word.',
          },
        ],
      }),
    ).rejects.toThrow('Imported word and meaning are required')

    await expect(
      contentBuilder.importWords({
        sourceName: 'Duplicate source',
        words: duplicateWords,
      }),
    ).rejects.toThrow('Duplicate imported word')
  })

  it('blocks publishing when sentence-based stages are missing required example sentences', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)
    const firstWord = words[0]

    if (!firstWord) {
      throw new Error('Expected test words to include a first item')
    }

    words[0] = {
      ...firstWord,
      exampleSentence: '',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Incomplete source',
      words,
    })
    const coverage = await contentBuilder.buildExerciseItems(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toEqual([
      {
        word: 'word-1',
        stage: 'S3',
        reason: 'example_sentence_required',
      },
      {
        word: 'word-1',
        stage: 'S4',
        reason: 'example_sentence_required',
      },
      {
        word: 'word-1',
        stage: 'S5',
        reason: 'example_sentence_required',
      },
    ])
    await expect(contentBuilder.publishVersion(draft.versionId)).rejects.toThrow(
      'Source version coverage is incomplete',
    )
  })

  it('keeps published source versions immutable', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Published source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    await expect(contentBuilder.buildExerciseItems(draft.versionId)).rejects.toThrow(
      'Published source versions are immutable',
    )
    await expect(contentBuilder.publishVersion(draft.versionId)).rejects.toThrow(
      'Published source versions are immutable',
    )
  })
})
