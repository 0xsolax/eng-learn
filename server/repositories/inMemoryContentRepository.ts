import type {
  ContentRepository,
  CreateSourceVersionInput,
  ExerciseItemRecord,
  SourceRecord,
  SourceVersionRecord,
  SourceVersionSnapshot,
  WordGroupRecord,
  WordRecord,
} from './contentRepository'

export const createInMemoryContentRepository = (): ContentRepository => {
  const sources = new Map<string, SourceRecord>()
  const versions = new Map<string, SourceVersionRecord>()
  const wordsByVersion = new Map<string, WordRecord[]>()
  const groupsByVersion = new Map<string, WordGroupRecord[]>()
  const exerciseItemsByVersion = new Map<string, ExerciseItemRecord[]>()

  const snapshotFor = (version: SourceVersionRecord): SourceVersionSnapshot => {
    const source = sources.get(version.sourceId)

    if (!source) {
      throw new Error(`Source ${version.sourceId} is missing`)
    }

    return {
      source,
      version,
      words: wordsByVersion.get(version.id) ?? [],
      groups: groupsByVersion.get(version.id) ?? [],
      exerciseItems: exerciseItemsByVersion.get(version.id) ?? [],
    }
  }

  return {
    async createSourceVersion(input: CreateSourceVersionInput) {
      sources.set(input.source.id, input.source)
      versions.set(input.version.id, input.version)
      wordsByVersion.set(input.version.id, input.words)
      groupsByVersion.set(input.version.id, input.groups)
      exerciseItemsByVersion.set(input.version.id, [])

      return snapshotFor(input.version)
    },

    async getSourceVersion(versionId: string) {
      const version = versions.get(versionId)

      return version ? snapshotFor(version) : undefined
    },

    async replaceExerciseItems(versionId: string, items: ExerciseItemRecord[]) {
      if (!versions.has(versionId)) {
        throw new Error(`Source version ${versionId} is missing`)
      }

      exerciseItemsByVersion.set(versionId, items)
    },

    async publishSourceVersion(versionId: string, publishedAt: string) {
      const version = versions.get(versionId)

      if (!version) {
        throw new Error(`Source version ${versionId} is missing`)
      }

      const published: SourceVersionRecord = {
        ...version,
        status: 'published',
        publishedAt,
      }

      versions.set(versionId, published)

      return published
    },
  }
}

