import { describe, expect, it } from 'vitest'
import { createInMemoryContentRepository } from '../../server/repositories/inMemoryContentRepository'
import { createContentBuilder } from '../../server/services/ContentBuilder'
import { exerciseItemContentSchema } from '../../shared/api/taskSchemas'
import type { ImportWordInput } from '../../shared/domain/content'
import type { ContentRepository } from '../../server/repositories/contentRepository'

const createWords = (count: number): ImportWordInput[] =>
  Array.from({ length: count }, (_, index) => {
    const wordNumber = index + 1
    const label = String(wordNumber)

    return {
      word: `word-${label}`,
      meaning: `meaning-${label}`,
      examplePhrase: `word-${label}`,
      exampleSentence: `I use word-${label}.`,
      exampleSentenceExtended: `I can use word-${label} every day.`,
      partOfSpeech: 'noun',
    }
  })

const approveAllDraftItems = async (
  contentBuilder: ReturnType<typeof createContentBuilder>,
  sourceVersionId: string,
): Promise<void> => {
  const items = await contentBuilder.listExerciseItems(sourceVersionId)

  await contentBuilder.approveExerciseItems(items.map((item) => item.id))
}

describe('admin content building workflow', () => {
  it('creates the next version under an existing source and allows only one draft', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const firstDraft = await contentBuilder.importWords({
      sourceName: 'Versioned source',
      words: createWords(5),
    })

    expect(firstDraft.versionNo).toBe(1)
    await expect(
      contentBuilder.importNextVersion({
        sourceId: firstDraft.sourceId,
        words: createWords(6),
      }),
    ).rejects.toThrow('Source already has a draft version')

    await contentBuilder.buildExerciseItems(firstDraft.versionId)
    await approveAllDraftItems(contentBuilder, firstDraft.versionId)
    await contentBuilder.publishVersion(firstDraft.versionId)

    const secondDraft = await contentBuilder.importNextVersion({
      sourceId: firstDraft.sourceId,
      words: createWords(6),
    })

    expect(secondDraft).toMatchObject({
      sourceId: firstDraft.sourceId,
      versionNo: 2,
      status: 'draft',
      wordCount: 6,
      groupCount: 2,
    })
    await expect(
      contentBuilder.importNextVersion({
        sourceId: firstDraft.sourceId,
        words: createWords(7),
      }),
    ).rejects.toThrow('Source already has a draft version')
  })

  it('maps concurrent next-version creation to one draft and one stable conflict', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const firstDraft = await contentBuilder.importWords({
      sourceName: 'Concurrent version source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(firstDraft.versionId)
    await approveAllDraftItems(contentBuilder, firstDraft.versionId)
    await contentBuilder.publishVersion(firstDraft.versionId)

    const results = await Promise.allSettled([
      contentBuilder.importNextVersion({
        sourceId: firstDraft.sourceId,
        words: createWords(6),
      }),
      contentBuilder.importNextVersion({
        sourceId: firstDraft.sourceId,
        words: createWords(7),
      }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      reason: {
        code: 'source_draft_exists',
      },
    })
    expect(
      (await contentBuilder.listSourceVersions()).filter(
        (version) => version.sourceId === firstDraft.sourceId && version.status === 'draft',
      ),
    ).toHaveLength(1)
  })

  it('archives an unusable draft and allows the same source to be re-imported', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const firstDraft = await contentBuilder.importWords({
      sourceName: 'Recoverable source',
      words: createWords(2),
    })

    expect(await contentBuilder.discardDraft(firstDraft.versionId)).toEqual({
      sourceVersionId: firstDraft.versionId,
      sourceId: firstDraft.sourceId,
      status: 'archived',
    })

    const replacement = await contentBuilder.importNextVersion({
      sourceId: firstDraft.sourceId,
      words: createWords(5),
    })

    expect(replacement).toMatchObject({
      sourceId: firstDraft.sourceId,
      versionNo: 2,
      status: 'draft',
      wordCount: 5,
    })
    expect(await contentBuilder.listSourceVersions()).toEqual([
      expect.objectContaining({
        versionId: replacement.versionId,
        versionNo: 2,
        status: 'draft',
      }),
      expect.objectContaining({
        versionId: firstDraft.versionId,
        versionNo: 1,
        status: 'archived',
      }),
    ])
  })

  it('builds draft exercises and publishes only after every required item is approved', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })

    const draft = await contentBuilder.importWords({
      sourceName: 'Test source',
      words: createWords(20),
    })

    expect(draft).toMatchObject({
      versionNo: 1,
      status: 'draft',
      wordCount: 20,
      groupCount: 4,
    })

    const coverage = await contentBuilder.buildExerciseItems(draft.versionId)

    expect(coverage).toMatchObject({
      sourceVersionId: draft.versionId,
      wordCount: 20,
      readyToPublish: false,
    })
    const draftItems = await contentBuilder.listExerciseItems(draft.versionId)

    expect(draftItems).toHaveLength(120)
    expect(draftItems.every((item) => item.status === 'draft')).toBe(true)

    await contentBuilder.approveExerciseItems(draftItems.map((item) => item.id))

    expect(await contentBuilder.getCoverage(draft.versionId)).toMatchObject({
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

  it('builds all six progressive exercise variants from their intended context level', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Schema-valid source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)

    expect(items).toHaveLength(30)

    for (const item of items) {
      expect(() =>
        exerciseItemContentSchema.parse({
          stage: item.stage,
          taskType: item.taskType,
          prompt: item.prompt,
          answer: item.answer,
        }),
      ).not.toThrow()
    }

    const wordItems = items.filter((item) => item.word === 'word-1')

    expect(wordItems).toEqual([
      expect.objectContaining({
        stage: 'S0',
        taskType: 'recognize_meaning',
        prompt: {
          word: 'word-1',
          meaning: 'meaning-1',
          exampleSentence: 'word-1',
        },
      }),
      expect.objectContaining({
        stage: 'S1',
        taskType: 'multiple_choice',
      }),
      expect.objectContaining({
        stage: 'S2',
        taskType: 'recall_word',
      }),
      expect.objectContaining({
        stage: 'S3',
        taskType: 'fill_blank',
        prompt: { sentence: 'I use ____.' },
      }),
      expect.objectContaining({
        stage: 'S4',
        taskType: 'sentence_build',
      }),
      expect.objectContaining({
        stage: 'S5',
        taskType: 'sentence_output',
        answer: { referenceSentence: 'I can use word-1 every day.' },
      }),
    ])
    expect(wordItems.find((item) => item.stage === 'S4')?.answer).toMatchObject({
      referenceSentence: 'I can use word-1 every day.',
    })
  })

  it('keeps the historical single-sentence stage mapping for v1 source versions', async () => {
    const repository = createInMemoryContentRepository()
    const createdAt = '2026-07-01T00:00:00.000Z'
    const versionId = 'version-legacy'

    await repository.createSourceVersion({
      source: { id: 'source-legacy', name: 'Legacy source', createdAt },
      version: {
        id: versionId,
        sourceId: 'source-legacy',
        versionNo: 1,
        contentRevision: 0,
        contentModel: 'v1_single_sentence',
        status: 'draft',
        createdAt,
      },
      words: ['apple', 'pear', 'plum'].map((word, index) => ({
        id: `word-${String(index + 1)}`,
        sourceVersionId: versionId,
        orderIndex: index + 1,
        word,
        meaning: `meaning-${String(index + 1)}`,
        examplePhrase: '',
        exampleSentence: `I eat ${word}.`,
        exampleSentenceExtended: '',
        createdAt,
      })),
      groups: [
        {
          id: 'group-legacy',
          sourceVersionId: versionId,
          groupIndex: 1,
          startOrderIndex: 1,
          endOrderIndex: 3,
          createdAt,
        },
      ],
    })
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    })

    await contentBuilder.buildExerciseItems(versionId)

    const items = (await contentBuilder.listExerciseItems(versionId)).filter(
      (item) => item.word === 'apple',
    )

    expect(items.map(({ stage, taskType }) => ({ stage, taskType }))).toEqual([
      { stage: 'S0', taskType: 'recognize_meaning' },
      { stage: 'S1', taskType: 'recall_word' },
      { stage: 'S2', taskType: 'multiple_choice' },
      { stage: 'S3', taskType: 'fill_blank' },
      { stage: 'S4', taskType: 'sentence_build' },
      { stage: 'S5', taskType: 'sentence_output' },
    ])
    expect(items[0]?.prompt).toEqual({
      word: 'apple',
      meaning: 'meaning-1',
      exampleSentence: 'I eat apple.',
    })
    expect(items[4]?.answer).toEqual(
      expect.objectContaining({ referenceSentence: 'I eat apple.' }),
    )
    expect(items[5]?.answer).toEqual({ referenceSentence: 'I eat apple.' })
  })

  it('returns stable, addressable coverage cells for every required exercise identity', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Coverage cells source',
      words: createWords(5),
    })

    const coverage = await contentBuilder.buildExerciseItems(draft.versionId)
    const item = (await contentBuilder.listExerciseItems(draft.versionId)).find(
      (candidate) => candidate.word === 'word-1' && candidate.taskType === 'multiple_choice',
    )

    if (!item) {
      throw new Error('Expected an S1 exercise item')
    }

    expect(coverage.cells).toHaveLength(30)
    expect(coverage.cells).toContainEqual({
      wordId: item.wordId,
      word: 'word-1',
      stage: 'S1',
      taskType: 'multiple_choice',
      status: 'draft',
      itemId: item.id,
      reason: 'exercise_item_draft',
    })

    await approveAllDraftItems(contentBuilder, draft.versionId)

    expect((await contentBuilder.getCoverage(draft.versionId)).cells).toContainEqual({
      wordId: item.wordId,
      word: 'word-1',
      stage: 'S1',
      taskType: 'multiple_choice',
      status: 'approved',
      itemId: item.id,
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

  it('lists source versions and returns version and exercise details', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Readable source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(await contentBuilder.listSourceVersions()).toEqual([
      expect.objectContaining({
        sourceId: draft.sourceId,
        sourceName: 'Readable source',
        versionId: draft.versionId,
        versionNo: 1,
        status: 'draft',
        wordCount: 5,
        groupCount: 1,
        exerciseItemCount: 30,
        approvedItemCount: 0,
      }),
    ])
    expect(await contentBuilder.getSourceVersionDetail(draft.versionId)).toMatchObject({
      sourceId: draft.sourceId,
      sourceName: 'Readable source',
      versionId: draft.versionId,
      readyToPublish: false,
    })

    const item = (await contentBuilder.listExerciseItems(draft.versionId))[0]

    if (!item) {
      throw new Error('Expected a generated exercise item')
    }

    expect(await contentBuilder.getExerciseItem(item.id)).toEqual(item)
  })

  it('returns edited approved and disabled exercise items to draft', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Review source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const item = (await contentBuilder.listExerciseItems(draft.versionId))[0]

    if (!item) {
      throw new Error('Expected a generated exercise item')
    }

    await contentBuilder.approveExerciseItem(item.id)
    expect(await contentBuilder.getExerciseItem(item.id)).toMatchObject({ status: 'approved' })

    const firstEdit = await contentBuilder.editExerciseItem(item.id, {
      prompt: {
        word: 'word-1',
        meaning: 'edited-meaning',
        exampleSentence: 'I can use word-1 in a custom example.',
      },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })

    expect(firstEdit).toMatchObject({
      status: 'draft',
      prompt: { word: 'word-1', meaning: 'edited-meaning' },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })

    await contentBuilder.approveExerciseItem(item.id)
    await contentBuilder.disableExerciseItem(item.id)
    expect(await contentBuilder.getExerciseItem(item.id)).toMatchObject({ status: 'disabled' })

    expect(
      await contentBuilder.editExerciseItem(item.id, {
        prompt: {
          word: 'word-1',
          meaning: 'reworked-meaning',
          exampleSentence: 'I can use word-1 after reworking it.',
        },
        answer: { word: 'word-1', expectedResponse: 'known' },
      }),
    ).toMatchObject({ status: 'draft' })
  })

  it('rejects malformed edited exercise content without changing the stored item', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Validated edit source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const item = (await contentBuilder.listExerciseItems(draft.versionId)).find(
      (candidate) => candidate.taskType === 'multiple_choice',
    )

    if (!item) {
      throw new Error('Expected an S2 exercise item')
    }

    await expect(
      contentBuilder.editExerciseItem(item.id, {
        prompt: {
          meaning: 'meaning-1',
          options: ['word-2', 'word-3', 'word-4'],
        },
        answer: { word: 'word-1' },
      }),
    ).rejects.toThrow('Multiple-choice answer must be one of the options')

    await expect(
      contentBuilder.editExerciseItem(item.id, {
        prompt: {
          meaning: 'meaning-1',
          options: ['word-1', 'invented-distractor-1', 'invented-distractor-2'],
        },
        answer: { word: 'word-1' },
      }),
    ).rejects.toThrow('Multiple-choice options must come from source words')

    expect(await contentBuilder.getExerciseItem(item.id)).toEqual(item)
  })

  it('rejects edited task content that detaches mastery from the owned source word', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Bound exercise source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)
    const itemByType = (taskType: string) => {
      const item = items.find(
        (candidate) => candidate.word === 'word-1' && candidate.taskType === taskType,
      )

      if (!item) throw new Error(`Expected ${taskType} item`)

      return item
    }
    const invalidEdits = [
      {
        item: itemByType('recognize_meaning'),
        prompt: {
          word: 'word-2',
          meaning: 'meaning-1',
          exampleSentence: 'I can use word-1.',
        },
        answer: { word: 'word-1', expectedResponse: 'known' },
      },
      {
        item: itemByType('recall_word'),
        prompt: { meaning: 'meaning-1' },
        answer: { word: 'word-2' },
      },
      {
        item: itemByType('fill_blank'),
        prompt: { sentence: 'I can use ____.' },
        answer: { word: 'word-2' },
      },
      {
        item: itemByType('fill_blank'),
        prompt: { sentence: '____ means word-1.' },
        answer: { word: 'word-1' },
      },
      {
        item: itemByType('sentence_build'),
        prompt: itemByType('sentence_build').prompt,
        answer: {
          ...(itemByType('sentence_build').answer as { pieceIds: string[] }),
          referenceSentence: 'I can use word-2.',
        },
      },
      {
        item: itemByType('sentence_output'),
        prompt: { meaning: 'meaning-1', instruction: 'Write one complete English sentence.' },
        answer: { referenceSentence: 'I can use word-2.' },
      },
    ]

    for (const invalid of invalidEdits) {
      await expect(
        contentBuilder.editExerciseItem(invalid.item.id, {
          prompt: invalid.prompt,
          answer: invalid.answer,
        }),
      ).rejects.toThrow('exercise word')
      expect(await contentBuilder.getExerciseItem(invalid.item.id)).toEqual(invalid.item)
    }
  })

  it('preserves manual edits and approval when build is repeated', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Stable build source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const item = (await contentBuilder.listExerciseItems(draft.versionId))[0]

    if (!item) {
      throw new Error('Expected a generated exercise item')
    }

    await contentBuilder.editExerciseItem(item.id, {
      prompt: {
        word: 'word-1',
        meaning: 'manual-meaning',
        exampleSentence: 'I can manually edit the word-1 example.',
      },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })
    await contentBuilder.approveExerciseItem(item.id)
    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(await contentBuilder.getExerciseItem(item.id)).toMatchObject({
      id: item.id,
      status: 'approved',
      prompt: { word: 'word-1', meaning: 'manual-meaning' },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })
    expect(await contentBuilder.listExerciseItems(draft.versionId)).toHaveLength(30)
  })

  it('uses real source words as S2 distractors and stable shuffled piece ids for S4', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Task content source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)
    const multipleChoice = items.find(
      (item) => item.word === 'word-1' && item.taskType === 'multiple_choice',
    )
    const sentenceBuild = items.find(
      (item) => item.word === 'word-1' && item.taskType === 'sentence_build',
    )

    if (!multipleChoice || !sentenceBuild) {
      throw new Error('Expected S2 and S4 exercise items')
    }

    const choicePrompt = multipleChoice.prompt

    if (
      !choicePrompt ||
      typeof choicePrompt !== 'object' ||
      !('meaning' in choicePrompt) ||
      choicePrompt.meaning !== 'meaning-1' ||
      !('options' in choicePrompt) ||
      !Array.isArray(choicePrompt.options)
    ) {
      throw new Error('Expected S2 meaning and options')
    }

    const options: unknown[] = choicePrompt.options

    expect(options).toEqual(['word-2', 'word-3', 'word-1'])

    const prompt = sentenceBuild.prompt
    const answer = sentenceBuild.answer

    if (
      !prompt ||
      typeof prompt !== 'object' ||
      !('pieces' in prompt) ||
      !Array.isArray(prompt.pieces) ||
      !answer ||
      typeof answer !== 'object' ||
      !('pieceIds' in answer) ||
      !Array.isArray(answer.pieceIds)
    ) {
      throw new Error('Expected S4 pieces and canonical piece ids')
    }

    const pieces: unknown[] = prompt.pieces
    const answerPieceIds: unknown[] = answer.pieceIds
    const promptIds = pieces.map((piece: unknown) => {
      if (!piece || typeof piece !== 'object' || !('id' in piece) || typeof piece.id !== 'string') {
        throw new Error('Expected every S4 piece to have a stable id')
      }

      return piece.id
    })

    if (!answerPieceIds.every((pieceId: unknown) => typeof pieceId === 'string')) {
      throw new Error('Expected every canonical S4 piece id to be a string')
    }

    expect(promptIds).not.toEqual(answerPieceIds)
    expect(new Set(promptIds)).toEqual(new Set(answerPieceIds))
    expect(promptIds.every((pieceId) => !pieceId.includes(':piece:'))).toBe(true)
    expect(promptIds.every((pieceId) => !pieceId.includes(sentenceBuild.wordId))).toBe(true)
  })

  it('reports an S1 coverage gap when the source has fewer than three real words', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Small source',
      words: createWords(2),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S1',
      taskType: 'multiple_choice',
      reason: 'distractors_required',
    })
  })

  it('does not build S1/S2 prompts whose meaning reveals the owning word', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'apple',
      meaning: 'apple 苹果',
      examplePhrase: 'an apple',
      exampleSentence: 'I ate an apple.',
      exampleSentenceExtended: 'I ate an apple after lunch.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Answer-revealing meaning source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)
    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(
      items.filter(
        (item) =>
          item.word === 'apple' &&
          (item.taskType === 'recall_word' || item.taskType === 'multiple_choice'),
      ),
    ).toEqual([])
    expect(coverage.missingItems).toEqual(
      expect.arrayContaining([
        {
          word: 'apple',
          stage: 'S1',
          taskType: 'multiple_choice',
          reason: 'exercise_item_invalid',
        },
        {
          word: 'apple',
          stage: 'S2',
          taskType: 'recall_word',
          reason: 'exercise_item_invalid',
        },
      ]),
    )
  })

  it('skips an S5 prompt that would reveal the owning word and reports the explicit gap', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'apple',
      meaning: 'ap\u200Bple fruit',
      examplePhrase: 'an apple',
      exampleSentence: 'I ate an apple.',
      exampleSentenceExtended: 'I ate an apple after lunch.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'S5 owning-word leak source',
      words,
    })
    const coverage = await contentBuilder.buildExerciseItems(draft.versionId)
    const items = await contentBuilder.listExerciseItems(draft.versionId)

    expect(
      items.find(
        (item) => item.word === 'apple' && item.taskType === 'sentence_output',
      ),
    ).toBeUndefined()
    expect(coverage.missingItems).toContainEqual({
      word: 'apple',
      stage: 'S5',
      taskType: 'sentence_output',
      reason: 'exercise_item_invalid',
    })
  })

  it('rejects editing or approving S1/S2 prompts that reveal the owning word', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'apple',
      meaning: '苹果',
      examplePhrase: 'an apple',
      exampleSentence: 'I ate an apple.',
      exampleSentenceExtended: 'I ate an apple after lunch.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Reviewed answer-revealing meaning source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)
    const recall = items.find(
      (item) => item.word === 'apple' && item.taskType === 'recall_word',
    )
    const choice = items.find(
      (item) => item.word === 'apple' && item.taskType === 'multiple_choice',
    )

    if (!recall || !choice) {
      throw new Error('Expected S1 and S2 exercise items')
    }

    await expect(
      contentBuilder.editExerciseItem(recall.id, {
        prompt: { meaning: '请回忆 apple 的英文' },
        answer: { word: 'apple' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })

    const snapshot = await repository.getSourceVersion(draft.versionId)

    if (!snapshot) {
      throw new Error('Expected a source version snapshot')
    }

    const storedChoice = await repository.getExerciseItem(choice.id)

    if (!storedChoice) {
      throw new Error('Expected the stored S2 exercise item')
    }

    await repository.updateExerciseItems(
      draft.versionId,
      [
        {
          ...storedChoice,
          prompt: {
            meaning: 'APPLE 苹果',
            options: ['word-2', 'word-3', 'apple'],
          },
        },
      ],
      snapshot.version.contentRevision,
    )

    await expect(contentBuilder.approveExerciseItem(choice.id)).rejects.toMatchObject({
      code: 'validation_error',
    })
  })

  it('enforces the progressive model during edit, approval and coverage checks', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Progressive validation source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const snapshot = await repository.getSourceVersion(draft.versionId)
    const s0 = snapshot?.exerciseItems.find(
      (item) => item.stage === 'S0' && item.taskType === 'recognize_meaning',
    )
    const s1 = snapshot?.exerciseItems.find(
      (item) => item.stage === 'S1' && item.taskType === 'multiple_choice',
    )

    if (!snapshot || !s0 || !s1) {
      throw new Error('Expected progressive S0 and S1 items')
    }

    await expect(
      contentBuilder.editExerciseItem(s0.id, {
        prompt: { word: 'word-1', meaning: 'meaning-1', exampleSentence: '' },
        answer: { word: 'word-1', expectedResponse: 'known' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })

    await repository.updateExerciseItems(
      draft.versionId,
      [
        {
          ...s0,
          prompt: { word: 'word-1', meaning: 'meaning-1', exampleSentence: '' },
        },
        {
          ...s1,
          taskType: 'recall_word',
          prompt: { meaning: 'meaning-1' },
          answer: { word: 'word-1' },
        },
      ],
      snapshot.version.contentRevision,
    )

    await expect(contentBuilder.approveExerciseItem(s0.id)).rejects.toMatchObject({
      code: 'validation_error',
    })
    await expect(contentBuilder.approveExerciseItem(s1.id)).rejects.toMatchObject({
      code: 'validation_error',
    })

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S0',
      taskType: 'recognize_meaning',
      reason: 'exercise_item_invalid',
    })
    expect(coverage.missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S1',
      taskType: 'multiple_choice',
      reason: 'exercise_item_required',
    })
  })

  it('rejects editing or approving S5 prompts that reveal the reference sentence', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'apple',
      meaning: '苹果',
      examplePhrase: 'an apple',
      exampleSentence: 'I ate an apple.',
      exampleSentenceExtended: 'I ate an apple after lunch.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'S5 prompt safety source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const item = (await contentBuilder.listExerciseItems(draft.versionId)).find(
      (candidate) => candidate.word === 'apple' && candidate.taskType === 'sentence_output',
    )

    if (!item) throw new Error('Expected an S5 exercise item')

    await expect(
      contentBuilder.editExerciseItem(item.id, {
        prompt: {
          meaning: 'I   ATE an apple after lunch.',
          instruction: 'Write one complete English sentence.',
        },
        answer: { referenceSentence: 'I ate an apple after lunch.' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    expect(await contentBuilder.getExerciseItem(item.id)).toEqual(item)

    const snapshot = await repository.getSourceVersion(draft.versionId)
    const storedItem = await repository.getExerciseItem(item.id)

    if (!snapshot || !storedItem) throw new Error('Expected the stored S5 exercise item')

    await repository.updateExerciseItems(
      draft.versionId,
      [
        {
          ...storedItem,
          prompt: {
            meaning: '苹果',
            instruction: 'Write this: I ate an apple after lunch.',
          },
        },
      ],
      snapshot.version.contentRevision,
    )

    await expect(contentBuilder.approveExerciseItem(item.id)).rejects.toMatchObject({
      code: 'validation_error',
    })
  })

  it('does not treat a target substring inside a larger Unicode token as an answer leak', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'he',
      meaning: 'the hero',
      examplePhrase: 'he',
      exampleSentence: 'He is the hero.',
      exampleSentenceExtended: 'He is the hero in this story.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Whole-token meaning source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    const items = await contentBuilder.listExerciseItems(draft.versionId)

    expect(
      items.filter(
        (item) =>
          item.word === 'he' &&
          (item.taskType === 'recall_word' || item.taskType === 'multiple_choice'),
      ),
    ).toHaveLength(2)
  })

  it('reports an S4 coverage gap when a sentence cannot be shuffled', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)
    const firstWord = words[0]

    if (!firstWord) {
      throw new Error('Expected a first word')
    }

    words[0] = {
      ...firstWord,
      exampleSentenceExtended: 'word-1',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Unshufflable sentence source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S4',
      taskType: 'sentence_build',
      reason: 'sentence_pieces_required',
    })
  })

  it('reports an S4 coverage gap when reversing pieces leaves the visible sentence unchanged', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)
    const firstWord = words[0]

    if (!firstWord) {
      throw new Error('Expected a first word')
    }

    words[0] = {
      ...firstWord,
      word: 'go',
      examplePhrase: 'go',
      exampleSentence: 'I go',
      exampleSentenceExtended: 'go go',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Visibly unshufflable source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toContainEqual({
      word: 'go',
      stage: 'S4',
      taskType: 'sentence_build',
      reason: 'sentence_pieces_required',
    })
  })

  it('requires an approved item matching word, stage and task type for coverage', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Exact coverage source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const recognizeItem = (await contentBuilder.listExerciseItems(draft.versionId)).find(
      (item) => item.word === 'word-1' && item.taskType === 'recognize_meaning',
    )

    if (!recognizeItem) {
      throw new Error('Expected an S0 recognize item')
    }

    const record = await repository.getExerciseItem(recognizeItem.id)

    if (!record) {
      throw new Error('Expected the S0 record')
    }

    const sourceVersion = await repository.getSourceVersion(draft.versionId)

    if (!sourceVersion) {
      throw new Error('Expected the source version')
    }

    await repository.updateExerciseItems(
      draft.versionId,
      [
      {
        ...record,
        taskType: 'recall_word',
      },
      ],
      sourceVersion.version.contentRevision,
    )

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S0',
      taskType: 'recognize_meaning',
      reason: 'exercise_item_required',
    })
  })

  it('does not count malformed approved content toward publish coverage', async () => {
    const repository = createInMemoryContentRepository()
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Malformed approved source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const sourceVersion = await repository.getSourceVersion(draft.versionId)
    const item = sourceVersion?.exerciseItems.find(
      (candidate) => candidate.taskType === 'multiple_choice',
    )

    if (!sourceVersion || !item) {
      throw new Error('Expected an S1 repository item')
    }

    await repository.updateExerciseItems(
      draft.versionId,
      [
        {
          ...item,
          prompt: {
            meaning: 'meaning-1',
            options: ['word-2', 'word-3', 'word-4'],
          },
          answer: { word: 'word-1' },
          status: 'approved',
        },
      ],
      sourceVersion.version.contentRevision,
    )

    const coverage = await contentBuilder.getCoverage(draft.versionId)

    expect(coverage.readyToPublish).toBe(false)
    expect(coverage.cells).toContainEqual({
      wordId: item.wordId,
      word: 'word-1',
      stage: 'S1',
      taskType: 'multiple_choice',
      status: 'approved',
      itemId: item.id,
      reason: 'exercise_item_invalid',
    })
    await expect(contentBuilder.publishVersion(draft.versionId)).rejects.toThrow(
      'Source version coverage is incomplete',
    )
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
      examplePhrase: 'word-1',
      exampleSentence: 'I can use word copy.',
      exampleSentenceExtended: 'I can use word-1 in a copied sentence.',
    }

    await expect(
      contentBuilder.importWords({
        sourceName: 'Invalid source',
        words: [
          {
            word: '',
            meaning: 'meaning',
            examplePhrase: 'a word',
            exampleSentence: 'I can use a word.',
            exampleSentenceExtended: 'I can use a word in this sentence.',
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

    await expect(
      contentBuilder.importWords({
        sourceName: 'Unicode duplicate source',
        words: [
          {
            word: 'café',
            meaning: '咖啡',
            examplePhrase: 'un café',
            exampleSentence: 'I drink café.',
            exampleSentenceExtended: 'I drink café every morning.',
          },
          {
            word: 'cafe\u0301',
            meaning: '同一咖啡',
            examplePhrase: 'un cafe\u0301',
            exampleSentence: 'I drink cafe\u0301.',
            exampleSentenceExtended: 'I drink cafe\u0301 every morning.',
          },
        ],
      }),
    ).rejects.toThrow('Duplicate imported word')
  })

  it('rejects a progressive import when any context level is missing', async () => {
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

    await expect(
      contentBuilder.importWords({
        sourceName: 'Incomplete source',
        words,
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: {
        fields: [{ path: 'words.0.exampleSentence', message: 'exampleSentence is required' }],
      },
    })
  })

  it('reports a coverage gap instead of crashing when an example omits the target word', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)
    const firstWord = words[0]

    if (!firstWord) {
      throw new Error('Expected a first word')
    }

    words[0] = {
      ...firstWord,
      exampleSentence: 'This example omits the target token.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Mismatched example source',
      words,
    })

    await expect(contentBuilder.buildExerciseItems(draft.versionId)).resolves.toBeTruthy()
    await approveAllDraftItems(contentBuilder, draft.versionId)

    expect((await contentBuilder.getCoverage(draft.versionId)).missingItems).toContainEqual({
      word: 'word-1',
      stage: 'S3',
      taskType: 'fill_blank',
      reason: 'example_sentence_required',
    })
  })

  it('blanks the standalone target instead of an earlier substring', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'cat',
      meaning: '猫',
      examplePhrase: 'a cat',
      exampleSentence: 'Scatter the cards; the cat sleeps.',
      exampleSentenceExtended: 'Scatter the cards; the cat sleeps nearby.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Standalone token source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(
      (await contentBuilder.listExerciseItems(draft.versionId)).find(
        (item) => item.word === 'cat' && item.taskType === 'fill_blank',
      ),
    ).toMatchObject({
      prompt: { sentence: 'Scatter the cards; the ____ sleeps.' },
    })
  })

  it('removes every standalone target occurrence from an unsubmitted fill-blank prompt', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'apple',
      meaning: '苹果',
      examplePhrase: 'an apple',
      exampleSentence: 'Apple pie with apple slices.',
      exampleSentenceExtended: 'Apple pie with apple slices tastes good.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Repeated target source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(
      (await contentBuilder.listExerciseItems(draft.versionId)).find(
        (item) => item.word === 'apple' && item.taskType === 'fill_blank',
      ),
    ).toMatchObject({
      prompt: { sentence: '____ pie with ____ slices.' },
    })
  })

  it('matches a standalone target case-insensitively after a larger token', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'he',
      meaning: '他',
      examplePhrase: 'he',
      exampleSentence: 'The sign says HE is ready.',
      exampleSentenceExtended: 'The sign says HE is ready to begin.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Case-insensitive token source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(
      (await contentBuilder.listExerciseItems(draft.versionId)).find(
        (item) => item.word === 'he' && item.taskType === 'fill_blank',
      ),
    ).toMatchObject({
      prompt: { sentence: 'The sign says ____ is ready.' },
    })
  })

  it('accepts punctuation as a complete target-token boundary', async () => {
    const contentBuilder = createContentBuilder({
      repository: createInMemoryContentRepository(),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const words = createWords(5)

    words[0] = {
      word: 'cat',
      meaning: '猫',
      examplePhrase: 'a cat',
      exampleSentence: 'Look at (cat), please.',
      exampleSentenceExtended: 'Look at (cat), please, before it leaves.',
    }

    const draft = await contentBuilder.importWords({
      sourceName: 'Punctuation token source',
      words,
    })

    await contentBuilder.buildExerciseItems(draft.versionId)

    expect(
      (await contentBuilder.listExerciseItems(draft.versionId)).find(
        (item) => item.word === 'cat' && item.taskType === 'fill_blank',
      ),
    ).toMatchObject({
      prompt: { sentence: 'Look at (____), please.' },
    })
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
    await approveAllDraftItems(contentBuilder, draft.versionId)
    await contentBuilder.publishVersion(draft.versionId)

    const publishedItem = (await contentBuilder.listExerciseItems(draft.versionId))[0]

    if (!publishedItem) {
      throw new Error('Expected a published exercise item')
    }

    await expect(contentBuilder.buildExerciseItems(draft.versionId)).rejects.toThrow(
      'Published source versions are immutable',
    )
    await expect(
      contentBuilder.editExerciseItem(publishedItem.id, {
        prompt: { word: 'forbidden' },
        answer: { word: 'forbidden' },
      }),
    ).rejects.toThrow('Published source versions are immutable')
    await expect(contentBuilder.approveExerciseItem(publishedItem.id)).rejects.toThrow(
      'Published source versions are immutable',
    )
    await expect(contentBuilder.disableExerciseItem(publishedItem.id)).rejects.toThrow(
      'Published source versions are immutable',
    )
    await expect(contentBuilder.publishVersion(draft.versionId)).rejects.toThrow(
      'Published source versions are immutable',
    )
    await expect(contentBuilder.discardDraft(draft.versionId)).rejects.toThrow(
      'Published source versions are immutable',
    )
  })

  it('rejects publishing when reviewed content changes after coverage was checked', async () => {
    const storedRepository = createInMemoryContentRepository()
    const publishReached = createDeferred()
    const releasePublish = createDeferred()
    const repository: ContentRepository = {
      ...storedRepository,
      async publishSourceVersion(versionId, publishedAt, expectedRevision) {
        publishReached.resolve()
        await releasePublish.promise

        return storedRepository.publishSourceVersion(
          versionId,
          publishedAt,
          expectedRevision,
        )
      },
    }
    const contentBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await contentBuilder.importWords({
      sourceName: 'Concurrent publish source',
      words: createWords(5),
    })

    await contentBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(contentBuilder, draft.versionId)

    const item = (await contentBuilder.listExerciseItems(draft.versionId))[0]

    if (!item) {
      throw new Error('Expected an exercise item')
    }

    const publishing = contentBuilder.publishVersion(draft.versionId)
    const rejectedPublish = expect(publishing).rejects.toThrow('Source version changed concurrently')

    await publishReached.promise
    await contentBuilder.disableExerciseItem(item.id)
    releasePublish.resolve()

    await rejectedPublish
    expect(await contentBuilder.getSourceVersionDetail(draft.versionId)).toMatchObject({
      status: 'draft',
      readyToPublish: false,
    })
  })

  it('does not report a successful edit when the version publishes before the write lands', async () => {
    const storedRepository = createInMemoryContentRepository()
    const setupBuilder = createContentBuilder({
      repository: storedRepository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const draft = await setupBuilder.importWords({
      sourceName: 'Concurrent edit source',
      words: createWords(5),
    })

    await setupBuilder.buildExerciseItems(draft.versionId)
    await approveAllDraftItems(setupBuilder, draft.versionId)

    const item = (await setupBuilder.listExerciseItems(draft.versionId))[0]

    if (!item) {
      throw new Error('Expected an exercise item')
    }

    const updateReached = createDeferred()
    const releaseUpdate = createDeferred()
    const repository: ContentRepository = {
      ...storedRepository,
      async updateExerciseItems(versionId, items, expectedRevision) {
        updateReached.resolve()
        await releaseUpdate.promise

        return storedRepository.updateExerciseItems(versionId, items, expectedRevision)
      },
    }
    const racingBuilder = createContentBuilder({
      repository,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    })
    const editing = racingBuilder.editExerciseItem(item.id, {
      prompt: {
        word: 'word-1',
        meaning: 'edited-meaning',
        exampleSentence: 'I can use word-1 after editing it.',
      },
      answer: { word: 'word-1', expectedResponse: 'known' },
    })
    const rejectedEdit = expect(editing).rejects.toThrow(
      'Published source versions are immutable',
    )

    await updateReached.promise
    await setupBuilder.publishVersion(draft.versionId)
    releaseUpdate.resolve()

    await rejectedEdit
    expect(await setupBuilder.getExerciseItem(item.id)).toEqual(item)
  })
})

const createDeferred = () => {
  let resolvePromise: () => void = () => undefined
  let rejectPromise: (reason?: unknown) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}
