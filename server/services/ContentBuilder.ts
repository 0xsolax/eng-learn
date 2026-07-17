import type {
  ArchivedSourceVersion,
  BuildCoverage,
  ContentModel,
  CoverageBlockReason,
  CoverageCell,
  ExerciseItemView,
  ImportedSourceVersion,
  ImportWordInput,
  PublishedSourceVersion,
  SourceVersionDetail,
  SourceVersionSummary,
  TaskType,
  WordStage,
} from '../../shared/domain/content'
import { exerciseItemContentSchema } from '../../shared/api/taskSchemas'
import {
  canonicalizeLearningText,
  containsUnicodeWholeToken,
  learnerPromptRevealsAnswer,
} from '../../shared/api/taskContentSafety'
import type {
  ContentRepository,
  ExerciseItemRecord,
  SourceRecord,
  SourceVersionRecord,
  WordGroupRecord,
  WordRecord,
} from '../repositories/contentRepository'
import { DomainError, isDomainError } from '../errors/DomainError'
import type {
  AdminOperationRecord,
  AdminOperationLedgerReader,
  SourceVersionImportAdminOperation,
} from '../repositories/adminOperationLedger'
import {
  findExactAdminOperation,
  prepareSourceVersionImportOperation,
  type PreparedAdminOperation,
} from './adminOperation'

const GROUP_SIZE = 5

type StageTaskDefinition = {
  stage: WordStage
  taskType: TaskType
  requiresExampleSentence: boolean
}

type ExpectedImportedSource = {
  sourceId?: string
  sourceName?: string
  words: ImportWordInput[]
}

type SourceVersionImportInput =
  | {
      mode: 'new_source'
      operationToken: string
      sourceName: string
      words: ImportWordInput[]
    }
  | {
      mode: 'next_version'
      operationToken: string
      sourceId: string
      words: ImportWordInput[]
    }

const LEGACY_STAGE_TASKS: StageTaskDefinition[] = [
  { stage: 'S0', taskType: 'recognize_meaning', requiresExampleSentence: false },
  { stage: 'S1', taskType: 'recall_word', requiresExampleSentence: false },
  { stage: 'S2', taskType: 'multiple_choice', requiresExampleSentence: false },
  { stage: 'S3', taskType: 'fill_blank', requiresExampleSentence: true },
  { stage: 'S4', taskType: 'sentence_build', requiresExampleSentence: true },
  { stage: 'S5', taskType: 'sentence_output', requiresExampleSentence: true },
]

const PROGRESSIVE_STAGE_TASKS: StageTaskDefinition[] = [
  { stage: 'S0', taskType: 'recognize_meaning', requiresExampleSentence: false },
  { stage: 'S1', taskType: 'multiple_choice', requiresExampleSentence: false },
  { stage: 'S2', taskType: 'recall_word', requiresExampleSentence: false },
  { stage: 'S3', taskType: 'fill_blank', requiresExampleSentence: true },
  { stage: 'S4', taskType: 'sentence_build', requiresExampleSentence: true },
  { stage: 'S5', taskType: 'sentence_output', requiresExampleSentence: true },
]

const getStageTasks = (contentModel: ContentModel): StageTaskDefinition[] =>
  contentModel === 'v2_progressive_context'
    ? PROGRESSIVE_STAGE_TASKS
    : LEGACY_STAGE_TASKS

export type ContentBuilder = {
  importNewSourceIdempotently(input: {
    operationToken: string
    sourceName: string
    words: ImportWordInput[]
  }): Promise<ImportedSourceVersion>
  importNextVersionIdempotently(input: {
    operationToken: string
    sourceId: string
    words: ImportWordInput[]
  }): Promise<ImportedSourceVersion>
  buildExerciseItems(sourceVersionId: string): Promise<BuildCoverage>
  listSourceVersions(): Promise<SourceVersionSummary[]>
  getSourceVersionDetail(sourceVersionId: string): Promise<SourceVersionDetail>
  getCoverage(sourceVersionId: string): Promise<BuildCoverage>
  listExerciseItems(sourceVersionId: string): Promise<ExerciseItemView[]>
  getExerciseItem(itemId: string): Promise<ExerciseItemView>
  editExerciseItem(itemId: string, input: { prompt: unknown; answer: unknown }): Promise<ExerciseItemView>
  approveExerciseItem(itemId: string): Promise<void>
  approveExerciseItems(itemIds: string[]): Promise<void>
  disableExerciseItem(itemId: string): Promise<void>
  discardDraft(sourceVersionId: string): Promise<ArchivedSourceVersion>
  publishVersion(sourceVersionId: string): Promise<PublishedSourceVersion>
}

export type CreateContentBuilderInput = {
  repository: ContentRepository
  now: () => Date
  operationLedger?: AdminOperationLedgerReader
}

export const createContentBuilder = ({
  repository,
  now,
  operationLedger = repository.adminOperationLedger,
}: CreateContentBuilderInput): ContentBuilder => {
  const timestamp = () => now().toISOString()

  const reconcileSourceVersionImport = async (
    prepared: PreparedAdminOperation,
    expected: { kind: AdminOperationRecord['kind']; targetId: string },
  ): Promise<AdminOperationRecord | undefined> => {
    try {
      return await findExactAdminOperation(operationLedger, prepared, expected)
    } catch (error) {
      if (isDomainError(error) && error.code === 'idempotency_conflict') {
        throw error
      }

      throw new DomainError(
        'import_reconcile_required',
        'Source import result requires reconciliation',
      )
    }
  }

  const replaySourceVersionImport = async (
    operation: SourceVersionImportAdminOperation,
    expected: ExpectedImportedSource,
  ): Promise<ImportedSourceVersion> => {
    try {
      return await replayImportedSource(repository, operation, expected)
    } catch (error) {
      if (isDomainError(error)) throw error

      throw new DomainError(
        'import_reconcile_required',
        'Source import result requires reconciliation',
      )
    }
  }

  const createImportedVersion = async (input: {
    source: SourceRecord
    versionNo: number
    words: ImportWordInput[]
    createSource: boolean
    versionId?: string
    adminOperation?: SourceVersionImportAdminOperation
  }): Promise<ImportedSourceVersion> => {
    const createdAt = timestamp()
    const importedWords = normalizeImportedWords(input.words)
    const version: SourceVersionRecord = {
      id: input.versionId ?? crypto.randomUUID(),
      sourceId: input.source.id,
      versionNo: input.versionNo,
      contentRevision: 0,
      contentModel: 'v2_progressive_context',
      status: 'draft',
      createdAt,
    }
    const words = importedWords.map<WordRecord>((word, index) => ({
      id: crypto.randomUUID(),
      sourceVersionId: version.id,
      orderIndex: index + 1,
      word: word.word,
      meaning: word.meaning,
      examplePhrase: word.examplePhrase,
      exampleSentence: word.exampleSentence,
      exampleSentenceExtended: word.exampleSentenceExtended,
      ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech } : {}),
      createdAt,
    }))
    const groups = createWordGroups(version.id, words.length, createdAt)

    await repository.createSourceVersion({
      ...(input.createSource ? { source: input.source } : {}),
      version,
      words,
      groups,
      ...(input.adminOperation ? { adminOperation: input.adminOperation } : {}),
    })

    return {
      sourceId: input.source.id,
      versionId: version.id,
      versionNo: version.versionNo,
      status: version.status,
      wordCount: words.length,
      groupCount: groups.length,
    }
  }

  const getExerciseItemView = async (itemId: string): Promise<ExerciseItemView> => {
    const item = await requireExerciseItem(repository, itemId)
    const snapshot = await requireSourceVersion(repository, item.sourceVersionId)

    return toExerciseItemView(snapshot, item)
  }

  const approveExerciseItems = async (itemIds: string[]): Promise<void> => {
    if (itemIds.length === 0) {
      throw validationError('itemIds', 'At least one exercise item is required')
    }

    const uniqueItemIds = Array.from(new Set(itemIds))
    const storedItems = await repository.getExerciseItems(uniqueItemIds)
    const itemsById = new Map(storedItems.map((item) => [item.id, item]))
    const items = uniqueItemIds.map((itemId) => {
      const item = itemsById.get(itemId)

      if (!item) {
        throw new DomainError('not_found', `Exercise item ${itemId} is missing`)
      }

      return item
    })
    const sourceVersionIds = new Set(items.map((item) => item.sourceVersionId))

    if (sourceVersionIds.size !== 1) {
      throw validationError('itemIds', 'Batch approval requires one source version')
    }

    const sourceVersionId = items[0]?.sourceVersionId

    if (!sourceVersionId) {
      throw validationError('itemIds', 'At least one exercise item is required')
    }

    const snapshot = await requireSourceVersion(repository, sourceVersionId)

    requireDraft(snapshot.version.status)

    for (const item of items) {
      if (item.status !== 'draft') {
        throw new DomainError('conflict', `Exercise item ${item.id} is not a draft`)
      }

      const word = snapshot.words.find((candidate) => candidate.id === item.wordId)

      if (!word) {
        throw new Error(`Word ${item.wordId} is missing`)
      }

      parseExerciseContent(item, word, snapshot.words, snapshot.version.contentModel)
    }

    await repository.updateExerciseItems(
      sourceVersionId,
      items.map((item) => ({
        ...item,
        status: 'approved',
      })),
      snapshot.version.contentRevision,
    )
  }

  const importSourceVersionIdempotently = async (
    input: SourceVersionImportInput,
  ): Promise<ImportedSourceVersion> => {
    const normalizedWords = normalizeImportedWords(input.words)
    const targetId = input.mode === 'new_source' ? 'new-source' : input.sourceId
    const prepared = await prepareSourceVersionImportOperation(
      input.operationToken,
      input.mode === 'new_source'
        ? {
            mode: input.mode,
            targetId,
            sourceName: input.sourceName,
            words: normalizedWords,
          }
        : {
            mode: input.mode,
            targetId,
            words: normalizedWords,
          },
      input.mode === 'new_source'
        ? {
            kind: 'create_source',
            sourceName: input.sourceName,
            words: normalizedWords,
          }
        : undefined,
    )
    const expected = { kind: 'create_source' as const, targetId }
    const expectedImportedSource: ExpectedImportedSource = {
      ...(input.mode === 'new_source'
        ? { sourceName: input.sourceName }
        : { sourceId: input.sourceId }),
      words: normalizedWords,
    }
    const existing = await reconcileSourceVersionImport(prepared, expected)

    if (existing) {
      if (existing.kind !== 'create_source') {
        throw new Error('Matched source-version import operation has an invalid kind')
      }

      return replaySourceVersionImport(existing, expectedImportedSource)
    }

    await repository.assertImportSchemaReady()

    const createdAt = timestamp()
    const source =
      input.mode === 'new_source'
        ? {
            id: crypto.randomUUID(),
            name: input.sourceName,
            createdAt,
          }
        : await requireSource(repository, input.sourceId)
    const versions =
      input.mode === 'new_source'
        ? []
        : await repository.listSourceVersionsBySource(input.sourceId)

    if (versions.some((version) => version.status === 'draft')) {
      throw new DomainError('source_draft_exists', 'Source already has a draft version')
    }

    const versionNo = versions.reduce(
      (highest, version) => Math.max(highest, version.versionNo),
      0,
    ) + 1
    const versionId = crypto.randomUUID()
    const adminOperation: SourceVersionImportAdminOperation = {
      operationHash: prepared.operationHash,
      kind: 'create_source',
      targetId,
      requestFingerprint: prepared.requestFingerprint,
      outcomeSourceId: source.id,
      outcomeSourceVersionId: versionId,
      createdAt,
    }

    try {
      return await createImportedVersion({
        source,
        versionNo,
        words: normalizedWords,
        createSource: input.mode === 'new_source',
        versionId,
        adminOperation,
      })
    } catch (error) {
      const raced = await reconcileSourceVersionImport(prepared, expected)

      if (raced?.kind === 'create_source') {
        return replaySourceVersionImport(raced, expectedImportedSource)
      }

      if (input.mode === 'next_version') {
        const currentVersions = await repository.listSourceVersionsBySource(input.sourceId)

        if (currentVersions.some((version) => version.status === 'draft')) {
          throw new DomainError('source_draft_exists', 'Source already has a draft version')
        }
      }

      throw error
    }
  }

  return {
    async importNewSourceIdempotently(input) {
      return importSourceVersionIdempotently({ mode: 'new_source', ...input })
    },

    async importNextVersionIdempotently(input) {
      return importSourceVersionIdempotently({ mode: 'next_version', ...input })
    },

    async buildExerciseItems(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(snapshot.version.status)

      const createdAt = timestamp()
      const stageTasks = getStageTasks(snapshot.version.contentModel)
      const exerciseItems = snapshot.words.flatMap((word) =>
        stageTasks.filter((task) =>
          canBuildTask(word, task, snapshot.words, snapshot.version.contentModel),
        ).map(
          (task) =>
            createExerciseItem(
              sourceVersionId,
              word,
              task.stage,
              task.taskType,
              snapshot.words,
              snapshot.version.contentModel,
              createdAt,
            ),
        ).filter(
          (item) =>
            !hasExerciseItem(
              snapshot.exerciseItems,
              item.wordId,
              item.stage,
              item.taskType,
            ),
        ),
      )

      await repository.addExerciseItems(
        sourceVersionId,
        exerciseItems,
        snapshot.version.contentRevision,
      )

      const updatedSnapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(updatedSnapshot.version.status)

      return toCoverage(updatedSnapshot)
    },

    async getCoverage(sourceVersionId) {
      return toCoverage(await requireSourceVersion(repository, sourceVersionId))
    },

    async listSourceVersions() {
      return repository.listSourceVersions()
    },

    async getSourceVersionDetail(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)
      const coverage = toCoverage(snapshot)

      return {
        ...toSourceVersionSummary(snapshot),
        readyToPublish: coverage.readyToPublish,
        missingItems: coverage.missingItems,
      }
    },

    async listExerciseItems(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      return snapshot.exerciseItems.map((item) => toExerciseItemView(snapshot, item))
    },

    async getExerciseItem(itemId) {
      return getExerciseItemView(itemId)
    },

    async editExerciseItem(itemId, input) {
      const item = await requireExerciseItem(repository, itemId)
      const snapshot = await requireSourceVersion(repository, item.sourceVersionId)

      requireDraft(snapshot.version.status)

      const word = snapshot.words.find((candidate) => candidate.id === item.wordId)

      if (!word) {
        throw new Error(`Word ${item.wordId} is missing`)
      }

      const content = parseExerciseContent(
        {
          ...item,
          prompt: input.prompt,
          answer: input.answer,
        },
        word,
        snapshot.words,
        snapshot.version.contentModel,
      )

      const edited: ExerciseItemRecord = {
        ...item,
        prompt: content.prompt,
        answer: content.answer,
        status: 'draft',
      }

      await repository.updateExerciseItems(
        item.sourceVersionId,
        [edited],
        snapshot.version.contentRevision,
      )

      return toExerciseItemView(snapshot, edited)
    },

    async approveExerciseItem(itemId) {
      await approveExerciseItems([itemId])
    },

    async approveExerciseItems(itemIds) {
      await approveExerciseItems(itemIds)
    },

    async disableExerciseItem(itemId) {
      const item = await requireExerciseItem(repository, itemId)
      const snapshot = await requireSourceVersion(repository, item.sourceVersionId)

      requireDraft(snapshot.version.status)

      if (item.status === 'disabled') {
        throw new DomainError('conflict', `Exercise item ${item.id} is already disabled`)
      }

      await repository.updateExerciseItems(
        item.sourceVersionId,
        [{
          ...item,
          status: 'disabled',
        }],
        snapshot.version.contentRevision,
      )
    },

    async discardDraft(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(snapshot.version.status)

      const archived = await repository.archiveDraftVersion(
        sourceVersionId,
        snapshot.version.contentRevision,
      )

      return {
        sourceVersionId: archived.id,
        sourceId: archived.sourceId,
        status: 'archived',
      }
    },

    async publishVersion(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(snapshot.version.status)

      const missingItems = toCoverage(snapshot).missingItems

      if (missingItems.length > 0) {
        throw new DomainError('coverage_incomplete', 'Source version coverage is incomplete', {
          missingItems,
        })
      }

      const published = await repository.publishSourceVersion(
        sourceVersionId,
        timestamp(),
        snapshot.version.contentRevision,
      )

      return {
        sourceVersionId: published.id,
        status: 'published',
      }
    },
  }
}

const requireDraft = (status: string): void => {
  if (status !== 'draft') {
    throw new DomainError('source_version_immutable', 'Published source versions are immutable')
  }
}

const normalizeImportedWords = (words: ImportWordInput[]): ImportWordInput[] => {
  const seen = new Set<string>()

  return words.map((word, index) => {
    const normalizedWord = word.word.trim()
    const normalizedMeaning = word.meaning.trim()
    const normalizedExamplePhrase = word.examplePhrase.trim()
    const normalizedExampleSentence = word.exampleSentence.trim()
    const normalizedExampleSentenceExtended = word.exampleSentenceExtended.trim()

    if (!normalizedWord || !normalizedMeaning) {
      const field = normalizedWord ? 'meaning' : 'word'

      throw validationError(`words.${String(index)}.${field}`, 'Imported word and meaning are required')
    }

    if (
      !normalizedExamplePhrase ||
      !normalizedExampleSentence ||
      !normalizedExampleSentenceExtended
    ) {
      const field = !normalizedExamplePhrase
        ? 'examplePhrase'
        : !normalizedExampleSentence
          ? 'exampleSentence'
          : 'exampleSentenceExtended'

      throw validationError(`words.${String(index)}.${field}`, `${field} is required`)
    }

    const duplicateKey = canonicalizeLearningText(normalizedWord)

    if (seen.has(duplicateKey)) {
      throw validationError(`words.${String(index)}.word`, 'Duplicate imported word')
    }

    seen.add(duplicateKey)

    return {
      word: normalizedWord,
      meaning: normalizedMeaning,
      examplePhrase: normalizedExamplePhrase,
      exampleSentence: normalizedExampleSentence,
      exampleSentenceExtended: normalizedExampleSentenceExtended,
      ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech.trim() } : {}),
    }
  })
}

const canBuildTask = (
  word: WordRecord,
  task: StageTaskDefinition,
  words: WordRecord[],
  contentModel: ContentModel,
): boolean => getTaskBuildBlockReason(word, task, words, contentModel) === undefined

const getTaskBuildBlockReason = (
  word: WordRecord,
  task: StageTaskDefinition,
  words: WordRecord[],
  contentModel: ContentModel,
): CoverageBlockReason | undefined => {
  if (
    (task.taskType === 'recall_word' || task.taskType === 'multiple_choice') &&
    containsUnicodeWholeToken(word.meaning, word.word)
  ) {
    return 'exercise_item_invalid'
  }

  const contextSentence = getContextSentence(word, task.stage, contentModel)

  if (task.requiresExampleSentence && contextSentence.trim().length === 0) {
    return 'example_sentence_required'
  }

  if (
    (task.taskType === 'sentence_build' || task.taskType === 'sentence_output') &&
    !containsUnicodeWholeToken(contextSentence, word.word)
  ) {
    return 'example_sentence_required'
  }

  if (
    task.taskType === 'sentence_output' &&
    generatedTaskRevealsAnswer(word, task, words, contentModel)
  ) {
    return 'exercise_item_invalid'
  }

  if (task.taskType === 'multiple_choice' && words.length < 3) {
    return 'distractors_required'
  }

  if (task.taskType === 'fill_blank' && !createFillBlankSentence(word, contextSentence)) {
    return 'example_sentence_required'
  }

  if (task.taskType === 'sentence_build' && !hasVisibleSentenceShuffle(contextSentence)) {
    return 'sentence_pieces_required'
  }

  return undefined
}

const createCoverageCells = (
  words: WordRecord[],
  exerciseItems: ExerciseItemRecord[],
  contentModel: ContentModel,
): CoverageCell[] =>
  words.flatMap((word) =>
    getStageTasks(contentModel).map((task) => {
      const item = exerciseItems.find(
        (candidate) =>
          candidate.wordId === word.id &&
          candidate.stage === task.stage &&
          candidate.taskType === task.taskType,
      )
      const base = {
        wordId: word.id,
        word: word.word,
        stage: task.stage,
        taskType: task.taskType,
      }

      if (item) {
        const isValid = isExerciseContentValid(item, word, words, contentModel)
        const reason: CoverageBlockReason | undefined = !isValid
          ? 'exercise_item_invalid'
          : item.status === 'approved'
            ? undefined
            : item.status === 'disabled'
              ? 'exercise_item_disabled'
              : 'exercise_item_draft'

        return {
          ...base,
          status: item.status,
          itemId: item.id,
          ...(reason ? { reason } : {}),
        }
      }

      const reason =
        getTaskBuildBlockReason(word, task, words, contentModel) ?? 'exercise_item_required'

      return {
        ...base,
        status: 'missing',
        reason,
      }
    }),
  )

const hasExerciseItem = (
  exerciseItems: ExerciseItemRecord[],
  wordId: string,
  stage: WordStage,
  taskType: TaskType,
): boolean =>
  exerciseItems.some(
    (item) => item.wordId === wordId && item.stage === stage && item.taskType === taskType,
  )

const toCoverage = (snapshot: Awaited<ReturnType<typeof requireSourceVersion>>): BuildCoverage => {
  const cells = createCoverageCells(
    snapshot.words,
    snapshot.exerciseItems,
    snapshot.version.contentModel,
  )
  const missingItems = cells.flatMap((cell) =>
    cell.reason
      ? [{
          word: cell.word,
          stage: cell.stage,
          taskType: cell.taskType,
          reason: cell.reason,
        }]
      : [],
  )

  return {
    sourceVersionId: snapshot.version.id,
    wordCount: snapshot.words.length,
    readyToPublish: missingItems.length === 0,
    cells,
    missingItems,
  }
}

const toExerciseItemView = (
  snapshot: Awaited<ReturnType<typeof requireSourceVersion>>,
  item: ExerciseItemRecord,
): ExerciseItemView => {
  const word = snapshot.words.find((candidate) => candidate.id === item.wordId)

  if (!word) {
    throw new Error(`Word ${item.wordId} is missing`)
  }

  return {
    id: item.id,
    sourceVersionId: item.sourceVersionId,
    wordId: item.wordId,
    word: word.word,
    stage: item.stage,
    taskType: item.taskType,
    prompt: item.prompt,
    answer: item.answer,
    status: item.status,
  }
}

const toSourceVersionSummary = (
  snapshot: Awaited<ReturnType<typeof requireSourceVersion>>,
): SourceVersionSummary => ({
  sourceId: snapshot.source.id,
  sourceName: snapshot.source.name,
  versionId: snapshot.version.id,
  versionNo: snapshot.version.versionNo,
  status: snapshot.version.status,
  wordCount: snapshot.words.length,
  groupCount: snapshot.groups.length,
  exerciseItemCount: snapshot.exerciseItems.length,
  approvedItemCount: snapshot.exerciseItems.filter((item) => item.status === 'approved').length,
  createdAt: snapshot.version.createdAt,
  ...(snapshot.version.publishedAt ? { publishedAt: snapshot.version.publishedAt } : {}),
})

const createWordGroups = (
  sourceVersionId: string,
  wordCount: number,
  createdAt: string,
): WordGroupRecord[] => {
  const groupCount = Math.ceil(wordCount / GROUP_SIZE)

  return Array.from({ length: groupCount }, (_, index) => {
    const groupIndex = index + 1
    const startOrderIndex = index * GROUP_SIZE + 1
    const endOrderIndex = Math.min(startOrderIndex + GROUP_SIZE - 1, wordCount)

    return {
      id: crypto.randomUUID(),
      sourceVersionId,
      groupIndex,
      startOrderIndex,
      endOrderIndex,
      createdAt,
    }
  })
}

const createExerciseItem = (
  sourceVersionId: string,
  word: WordRecord,
  stage: WordStage,
  taskType: TaskType,
  words: WordRecord[],
  contentModel: ContentModel,
  createdAt: string,
): ExerciseItemRecord => {
  const generatedContent = createExerciseContent(word, stage, taskType, words, contentModel)
  const content = parseExerciseContent(
    generatedContent,
    word,
    words,
    contentModel,
  )

  return {
    id: crypto.randomUUID(),
    sourceVersionId,
    wordId: word.id,
    stage: content.stage,
    taskType: content.taskType,
    prompt: content.prompt,
    answer: content.answer,
    status: 'draft',
    createdAt,
  }
}

const createExerciseContent = (
  word: WordRecord,
  stage: WordStage,
  taskType: TaskType,
  words: WordRecord[],
  contentModel: ContentModel,
): Pick<ExerciseItemRecord, 'stage' | 'taskType' | 'prompt' | 'answer'> => {
  const contextSentence = getContextSentence(word, stage, contentModel)

  if (stage === 'S4' && taskType === 'sentence_build') {
    const pieces = createSentencePieces(contextSentence, () => crypto.randomUUID())

    return {
      stage,
      taskType,
      prompt: { pieces: [...pieces].reverse() },
      answer: {
        pieceIds: pieces.map((piece) => piece.id),
        referenceSentence: contextSentence,
      },
    }
  }

  return {
    stage,
    taskType,
    prompt: createPrompt(word, stage, taskType, words, contentModel),
    answer: createAnswer(word, taskType, contextSentence),
  }
}

const generatedTaskRevealsAnswer = (
  word: WordRecord,
  task: StageTaskDefinition,
  words: WordRecord[],
  contentModel: ContentModel,
): boolean => {
  const content = exerciseItemContentSchema.safeParse(
    createExerciseContent(word, task.stage, task.taskType, words, contentModel),
  )

  return !content.success || learnerPromptRevealsAnswer(content.data, word.word)
}

const getContextSentence = (
  word: WordRecord,
  stage: WordStage,
  contentModel: ContentModel,
): string => {
  if (contentModel === 'v1_single_sentence') {
    return word.exampleSentence
  }

  if (stage === 'S0') {
    return word.examplePhrase
  }

  if (stage === 'S4' || stage === 'S5') {
    return word.exampleSentenceExtended
  }

  return word.exampleSentence
}

const createPrompt = (
  word: WordRecord,
  stage: WordStage,
  taskType: TaskType,
  words: WordRecord[],
  contentModel: ContentModel,
): unknown => {
  if (taskType === 'recognize_meaning') {
    return {
      word: word.word,
      meaning: word.meaning,
      exampleSentence: getContextSentence(word, stage, contentModel),
    }
  }

  if (taskType === 'recall_word') {
    return {
      meaning: word.meaning,
    }
  }

  if (taskType === 'multiple_choice') {
    const options = [
      word.word,
      ...words
        .filter((candidate) => candidate.id !== word.id)
        .slice(0, 2)
        .map((candidate) => candidate.word),
    ]
    const rotation = word.orderIndex % options.length

    return {
      meaning: word.meaning,
      options: [...options.slice(rotation), ...options.slice(0, rotation)],
    }
  }

  if (taskType === 'fill_blank') {
    return {
      sentence:
        createFillBlankSentence(word, getContextSentence(word, stage, contentModel)) ?? '',
    }
  }

  return {
    meaning: word.meaning,
    instruction: 'Write one complete English sentence.',
  }
}

const createAnswer = (
  word: WordRecord,
  taskType: TaskType,
  contextSentence: string,
): unknown => {
  if (taskType === 'recognize_meaning') {
    return {
      word: word.word,
      expectedResponse: 'known',
    }
  }

  if (taskType === 'sentence_output') {
    return {
      referenceSentence: contextSentence,
    }
  }

  return {
    word: word.word,
  }
}

const createSentencePieces = (
  sentence: string,
  createId: (index: number) => string = (index) => String(index + 1),
): Array<{ id: string; text: string }> =>
  sentence.trim().split(/\s+/).map((text, index) => ({
    id: createId(index),
    text,
  }))

const createFillBlankSentence = (
  word: WordRecord,
  sentence: string,
): string | undefined => {
  const target = word.word.trim()

  if (!target) {
    return undefined
  }

  const targetPattern = new RegExp(
    `(^|[^\\p{L}\\p{M}\\p{N}_])(${escapeRegularExpression(target)})(?=$|[^\\p{L}\\p{M}\\p{N}_])`,
    'giu',
  )
  const blanked = sentence.replace(
    targetPattern,
    (_match, leadingBoundary: string) => `${leadingBoundary}____`,
  )

  return blanked === sentence ? undefined : blanked
}

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const hasVisibleSentenceShuffle = (sentence: string): boolean => {
  const pieces = createSentencePieces(sentence)

  if (pieces.length < 2) {
    return false
  }

  const reversedPieces = [...pieces].reverse()

  return pieces.some((piece, index) => piece.text !== reversedPieces[index]?.text)
}

const parseExerciseContent = (
  item: Pick<ExerciseItemRecord, 'stage' | 'taskType' | 'prompt' | 'answer'>,
  word: WordRecord,
  words: WordRecord[],
  contentModel: ContentModel,
) => {
  const content = exerciseItemContentSchema.parse({
    stage: item.stage,
    taskType: item.taskType,
    prompt: item.prompt,
    answer: item.answer,
  })
  const expectedTask = getStageTasks(contentModel).find(
    (task) => task.stage === content.stage,
  )

  if (!expectedTask || expectedTask.taskType !== content.taskType) {
    throw validationError(
      'content.taskType',
      'Task type must match the source version content model',
    )
  }

  if (
    contentModel === 'v2_progressive_context' &&
    content.taskType === 'recognize_meaning' &&
    content.prompt.exampleSentence.trim().length === 0
  ) {
    throw validationError(
      'content.prompt.exampleSentence',
      'Progressive S0 context is required',
    )
  }

  if (
    'word' in content.answer &&
    normalizeTaskText(content.answer.word) !== normalizeTaskText(word.word)
  ) {
    throw validationError('content.answer.word', 'Task answer must match the exercise word')
  }

  if (
    content.taskType === 'recognize_meaning' &&
    normalizeTaskText(content.prompt.word) !== normalizeTaskText(word.word)
  ) {
    throw validationError('content.prompt.word', 'Task prompt must match the exercise word')
  }

  if (
    (content.taskType === 'recall_word' || content.taskType === 'multiple_choice') &&
    containsUnicodeWholeToken(content.prompt.meaning, word.word)
  ) {
    throw validationError(
      'content.prompt.meaning',
      'Task prompt must not reveal the exercise word',
    )
  }

  if (content.taskType === 'sentence_output' && learnerPromptRevealsAnswer(content, word.word)) {
    throw validationError(
      'content.prompt',
      'Task prompt must not reveal the reference sentence',
    )
  }

  if (
    content.taskType === 'fill_blank' &&
    containsUnicodeWholeToken(content.prompt.sentence, word.word)
  ) {
    throw validationError(
      'content.prompt.sentence',
      'Fill-blank prompt must not reveal the exercise word',
    )
  }

  if (content.taskType === 'multiple_choice') {
    const sourceWords = new Set(words.map((candidate) => normalizeTaskText(candidate.word)))

    if (content.prompt.options.some((option) => !sourceWords.has(normalizeTaskText(option)))) {
      throw validationError('content.prompt.options', 'Multiple-choice options must come from source words')
    }
  }

  if (
    (content.taskType === 'sentence_build' || content.taskType === 'sentence_output') &&
    !containsUnicodeWholeToken(content.answer.referenceSentence, word.word)
  ) {
    throw validationError(
      'content.answer.referenceSentence',
      'Reference sentence must contain the exercise word',
    )
  }

  if (content.taskType === 'sentence_build') {
    const piecesById = new Map(
      content.prompt.pieces.map((piece) => [piece.id, piece.text] as const),
    )
    const reconstructed = content.answer.pieceIds
      .map((pieceId) => piecesById.get(pieceId) ?? '')
      .join(' ')

    if (
      normalizeSentenceText(reconstructed) !==
      normalizeSentenceText(content.answer.referenceSentence)
    ) {
      throw validationError(
        'content.answer.referenceSentence',
        'Sentence-build answer must reconstruct its reference sentence',
      )
    }
  }

  return content
}

const isExerciseContentValid = (
  item: ExerciseItemRecord,
  word: WordRecord,
  words: WordRecord[],
  contentModel: ContentModel,
): boolean => {
  try {
    parseExerciseContent(item, word, words, contentModel)

    return true
  } catch {
    return false
  }
}

const normalizeTaskText = canonicalizeLearningText

const normalizeSentenceText = canonicalizeLearningText

const replayImportedSource = async (
  repository: ContentRepository,
  operation: SourceVersionImportAdminOperation,
  expected: ExpectedImportedSource,
): Promise<ImportedSourceVersion> => {
  const snapshot = await repository.getSourceVersion(operation.outcomeSourceVersionId)

  if (
    !snapshot ||
    snapshot.source.id !== operation.outcomeSourceId ||
    snapshot.version.sourceId !== operation.outcomeSourceId
  ) {
    throw new DomainError(
      'import_reconcile_required',
      'Committed source import outcome requires reconciliation',
    )
  }

  const wordsMatch =
    snapshot.words.length === expected.words.length &&
    snapshot.words.every((word, index) => {
      const expectedWord = expected.words[index]

      return (
        expectedWord !== undefined &&
        word.orderIndex === index + 1 &&
        word.word === expectedWord.word &&
        word.meaning === expectedWord.meaning &&
        word.examplePhrase === expectedWord.examplePhrase &&
        word.exampleSentence === expectedWord.exampleSentence &&
        word.exampleSentenceExtended === expectedWord.exampleSentenceExtended &&
        (word.partOfSpeech ?? '') === (expectedWord.partOfSpeech ?? '')
      )
    })

  if (
    (expected.sourceId && snapshot.source.id !== expected.sourceId) ||
    (expected.sourceName && snapshot.source.name !== expected.sourceName) ||
    !wordsMatch
  ) {
    throw new DomainError(
      'idempotency_conflict',
      'Admin operation token was already used for a different request',
    )
  }

  return {
    sourceId: snapshot.source.id,
    versionId: snapshot.version.id,
    versionNo: snapshot.version.versionNo,
    status: 'draft',
    wordCount: snapshot.words.length,
    groupCount: snapshot.groups.length,
  }
}

const requireSource = async (
  repository: ContentRepository,
  sourceId: string,
): Promise<SourceRecord> => {
  const source = await repository.getSource(sourceId)

  if (!source) {
    throw new DomainError('not_found', `Source ${sourceId} is missing`)
  }

  return source
}

const requireSourceVersion = async (
  repository: ContentRepository,
  sourceVersionId: string,
) => {
  const snapshot = await repository.getSourceVersion(sourceVersionId)

  if (!snapshot) {
    throw new DomainError('not_found', `Source version ${sourceVersionId} is missing`)
  }

  return snapshot
}

const requireExerciseItem = async (
  repository: ContentRepository,
  itemId: string,
): Promise<ExerciseItemRecord> => {
  const item = await repository.getExerciseItem(itemId)

  if (!item) {
    throw new DomainError('not_found', `Exercise item ${itemId} is missing`)
  }

  return item
}

const validationError = (path: string, message: string): DomainError =>
  new DomainError('validation_error', message, {
    fields: [{ path, message }],
  })
