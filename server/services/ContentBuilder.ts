import type {
  BuildCoverage,
  ImportedSourceVersion,
  ImportWordInput,
  PublishedSourceVersion,
  TaskType,
  WordStage,
} from '../../shared/domain/content'
import type {
  ContentRepository,
  ExerciseItemRecord,
  SourceRecord,
  SourceVersionRecord,
  WordGroupRecord,
  WordRecord,
} from '../repositories/contentRepository'

const GROUP_SIZE = 5

const MVP_STAGE_TASKS: Array<{
  stage: WordStage
  taskType: TaskType
  requiresExampleSentence: boolean
}> = [
  { stage: 'S0', taskType: 'recognize_meaning', requiresExampleSentence: false },
  { stage: 'S1', taskType: 'recall_word', requiresExampleSentence: false },
  { stage: 'S2', taskType: 'multiple_choice', requiresExampleSentence: false },
  { stage: 'S3', taskType: 'fill_blank', requiresExampleSentence: true },
  { stage: 'S4', taskType: 'sentence_build', requiresExampleSentence: true },
  { stage: 'S5', taskType: 'sentence_output', requiresExampleSentence: true },
]

export type ContentBuilder = {
  importWords(input: {
    sourceName: string
    words: ImportWordInput[]
  }): Promise<ImportedSourceVersion>
  buildExerciseItems(sourceVersionId: string): Promise<BuildCoverage>
  publishVersion(sourceVersionId: string): Promise<PublishedSourceVersion>
}

export type CreateContentBuilderInput = {
  repository: ContentRepository
  now: () => Date
}

export const createContentBuilder = ({
  repository,
  now,
}: CreateContentBuilderInput): ContentBuilder => {
  const timestamp = () => now().toISOString()

  return {
    async importWords(input) {
      const createdAt = timestamp()
      const importedWords = normalizeImportedWords(input.words)
      const source: SourceRecord = {
        id: crypto.randomUUID(),
        name: input.sourceName,
        createdAt,
      }
      const version: SourceVersionRecord = {
        id: crypto.randomUUID(),
        sourceId: source.id,
        versionNo: 1,
        status: 'draft',
        createdAt,
      }
      const words = importedWords.map<WordRecord>((word, index) => ({
        id: crypto.randomUUID(),
        sourceVersionId: version.id,
        orderIndex: index + 1,
        word: word.word,
        meaning: word.meaning,
        exampleSentence: word.exampleSentence,
        ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech } : {}),
        createdAt,
      }))
      const groups = createWordGroups(version.id, words.length, createdAt)

      await repository.createSourceVersion({
        source,
        version,
        words,
        groups,
      })

      return {
        sourceId: source.id,
        versionId: version.id,
        status: version.status,
        wordCount: words.length,
        groupCount: groups.length,
      }
    },

    async buildExerciseItems(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(snapshot.version.status)

      const createdAt = timestamp()
      const exerciseItems = snapshot.words.flatMap((word) =>
        MVP_STAGE_TASKS.filter((task) => canBuildStage(word, task.requiresExampleSentence)).map(
          (task) => createExerciseItem(sourceVersionId, word, task.stage, task.taskType, createdAt),
        ),
      )
      const missingItems = findMissingCoverage(snapshot.words, exerciseItems)

      await repository.replaceExerciseItems(sourceVersionId, exerciseItems)

      return {
        sourceVersionId,
        wordCount: snapshot.words.length,
        readyToPublish: missingItems.length === 0,
        missingItems,
      }
    },

    async publishVersion(sourceVersionId) {
      const snapshot = await requireSourceVersion(repository, sourceVersionId)

      requireDraft(snapshot.version.status)

      const missingItems = findMissingCoverage(snapshot.words, snapshot.exerciseItems)

      if (missingItems.length > 0) {
        throw new Error('Source version coverage is incomplete')
      }

      const published = await repository.publishSourceVersion(sourceVersionId, timestamp())

      return {
        sourceVersionId: published.id,
        status: 'published',
      }
    },
  }
}

const requireDraft = (status: string): void => {
  if (status !== 'draft') {
    throw new Error('Published source versions are immutable')
  }
}

const normalizeImportedWords = (words: ImportWordInput[]): ImportWordInput[] => {
  const seen = new Set<string>()

  return words.map((word) => {
    const normalizedWord = word.word.trim()
    const normalizedMeaning = word.meaning.trim()

    if (!normalizedWord || !normalizedMeaning) {
      throw new Error('Imported word and meaning are required')
    }

    const duplicateKey = normalizedWord.toLocaleLowerCase()

    if (seen.has(duplicateKey)) {
      throw new Error('Duplicate imported word')
    }

    seen.add(duplicateKey)

    return {
      word: normalizedWord,
      meaning: normalizedMeaning,
      exampleSentence: word.exampleSentence,
      ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech.trim() } : {}),
    }
  })
}

const canBuildStage = (word: WordRecord, requiresExampleSentence: boolean): boolean => {
  if (!requiresExampleSentence) {
    return true
  }

  return word.exampleSentence.trim().length > 0
}

const findMissingCoverage = (
  words: WordRecord[],
  exerciseItems: ExerciseItemRecord[],
): BuildCoverage['missingItems'] =>
  words.flatMap((word) =>
    MVP_STAGE_TASKS.filter((task) => !hasApprovedItem(exerciseItems, word.id, task.stage)).map(
      (task) => ({
        word: word.word,
        stage: task.stage,
        reason: task.requiresExampleSentence
          ? 'example_sentence_required'
          : 'exercise_item_required',
      }),
    ),
  )

const hasApprovedItem = (
  exerciseItems: ExerciseItemRecord[],
  wordId: string,
  stage: WordStage,
): boolean =>
  exerciseItems.some(
    (item) => item.wordId === wordId && item.stage === stage && item.status === 'approved',
  )

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
  createdAt: string,
): ExerciseItemRecord => ({
  id: crypto.randomUUID(),
  sourceVersionId,
  wordId: word.id,
  stage,
  taskType,
  prompt: createPrompt(word, stage),
  answer: {
    word: word.word,
    meaning: word.meaning,
  },
  status: 'approved',
  createdAt,
})

const createPrompt = (word: WordRecord, stage: WordStage): unknown => {
  if (stage === 'S0') {
    return {
      word: word.word,
      meaning: word.meaning,
      exampleSentence: word.exampleSentence,
    }
  }

  if (stage === 'S1') {
    return {
      meaning: word.meaning,
    }
  }

  if (stage === 'S2') {
    return {
      meaning: word.meaning,
      options: [word.word, `${word.word}-option-a`, `${word.word}-option-b`],
    }
  }

  if (stage === 'S3') {
    return {
      sentence: word.exampleSentence.replace(word.word, '____'),
    }
  }

  if (stage === 'S4') {
    return {
      pieces: word.exampleSentence.split(' '),
    }
  }

  return {
    meaning: word.meaning,
  }
}

const requireSourceVersion = async (
  repository: ContentRepository,
  sourceVersionId: string,
) => {
  const snapshot = await repository.getSourceVersion(sourceVersionId)

  if (!snapshot) {
    throw new Error(`Source version ${sourceVersionId} is missing`)
  }

  return snapshot
}
