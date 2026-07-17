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
import type { SourceVersionSummary } from '../../shared/domain/content'
import {
  createInMemoryAdminOperationLedger,
  type InMemoryAdminOperationLedger,
} from './adminOperationLedger'
import { DomainError } from '../errors/DomainError'

export const createInMemoryContentRepository = (
  input: { ledger?: InMemoryAdminOperationLedger } = {},
): ContentRepository => {
  const ledger = input.ledger ?? createInMemoryAdminOperationLedger()
  const sources = new Map<string, SourceRecord>()
  const versions = new Map<string, SourceVersionRecord>()
  const wordsByVersion = new Map<string, WordRecord[]>()
  const groupsByVersion = new Map<string, WordGroupRecord[]>()
  const exerciseItemsByVersion = new Map<string, ExerciseItemRecord[]>()

  const requireMutableVersion = (
    versionId: string,
    expectedRevision: number,
  ): SourceVersionRecord => {
    const version = versions.get(versionId)

    if (!version) {
      throw new Error(`Source version ${versionId} is missing`)
    }

    if (version.status !== 'draft') {
      throw new DomainError(
        'source_version_immutable',
        'Published source versions are immutable',
      )
    }

    if (version.contentRevision !== expectedRevision) {
      throw new DomainError('conflict', 'Source version changed concurrently')
    }

    return version
  }

  const incrementRevision = (version: SourceVersionRecord): number => {
    const contentRevision = version.contentRevision + 1

    versions.set(version.id, {
      ...version,
      contentRevision,
    })

    return contentRevision
  }

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

  const summaryFor = (version: SourceVersionRecord): SourceVersionSummary => {
    const source = sources.get(version.sourceId)

    if (!source) {
      throw new Error(`Source ${version.sourceId} is missing`)
    }

    const exerciseItems = exerciseItemsByVersion.get(version.id) ?? []

    return {
      sourceId: source.id,
      sourceName: source.name,
      versionId: version.id,
      versionNo: version.versionNo,
      status: version.status,
      wordCount: (wordsByVersion.get(version.id) ?? []).length,
      groupCount: (groupsByVersion.get(version.id) ?? []).length,
      exerciseItemCount: exerciseItems.length,
      approvedItemCount: exerciseItems.filter((item) => item.status === 'approved').length,
      createdAt: version.createdAt,
      ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
    }
  }

  return {
    adminOperationLedger: ledger,

    async assertImportSchemaReady() {},

    async createSourceVersion(input: CreateSourceVersionInput) {
      const create = async (): Promise<SourceVersionSnapshot> => {
        if (
          input.adminOperation &&
          (await ledger.get(input.adminOperation.operationHash))
        ) {
          throw new Error('Admin operation already exists')
        }

        const source = input.source ?? sources.get(input.version.sourceId)

        if (!source) {
          throw new Error(`Source ${input.version.sourceId} is missing`)
        }

        const hasDraft = Array.from(versions.values()).some(
          (version) => version.sourceId === source.id && version.status === 'draft',
        )

        if (hasDraft) {
          throw new Error('Source already has a draft version')
        }

        const hasVersionNumber = Array.from(versions.values()).some(
          (version) =>
            version.sourceId === source.id && version.versionNo === input.version.versionNo,
        )

        if (hasVersionNumber) {
          throw new Error(`Source version ${String(input.version.versionNo)} already exists`)
        }

        sources.set(source.id, source)
        versions.set(input.version.id, input.version)
        wordsByVersion.set(input.version.id, input.words)
        groupsByVersion.set(input.version.id, input.groups)
        exerciseItemsByVersion.set(input.version.id, [])
        if (input.adminOperation) ledger.insert(input.adminOperation)

        return snapshotFor(input.version)
      }

      return input.adminOperation ? ledger.runExclusive(create) : create()
    },

    async getSource(sourceId: string) {
      return sources.get(sourceId)
    },

    async listSourceVersions() {
      return Array.from(versions.values())
        .sort((left, right) => {
          const createdOrder = right.createdAt.localeCompare(left.createdAt)

          return createdOrder === 0 ? right.versionNo - left.versionNo : createdOrder
        })
        .map(summaryFor)
    },

    async listSourceVersionsBySource(sourceId: string) {
      return Array.from(versions.values())
        .filter((version) => version.sourceId === sourceId)
        .sort((left, right) => left.versionNo - right.versionNo)
    },

    async getSourceVersion(versionId: string) {
      const version = versions.get(versionId)

      return version ? snapshotFor(version) : undefined
    },

    async addExerciseItems(
      versionId: string,
      items: ExerciseItemRecord[],
      expectedRevision: number,
    ) {
      const version = requireMutableVersion(versionId, expectedRevision)

      if (items.length === 0) {
        return version.contentRevision
      }

      const existingItems = exerciseItemsByVersion.get(versionId) ?? []
      const nextItems = [...existingItems]
      let addedItemCount = 0

      for (const item of items) {
        const exists = nextItems.some(
          (candidate) =>
            candidate.wordId === item.wordId &&
            candidate.stage === item.stage &&
            candidate.taskType === item.taskType,
        )

        if (!exists) {
          nextItems.push(item)
          addedItemCount += 1
        }
      }

      exerciseItemsByVersion.set(versionId, nextItems)

      return addedItemCount > 0 ? incrementRevision(version) : version.contentRevision
    },

    async getExerciseItem(itemId: string) {
      for (const items of exerciseItemsByVersion.values()) {
        const item = items.find((candidate) => candidate.id === itemId)

        if (item) {
          return item
        }
      }

      return undefined
    },

    async getExerciseItems(itemIds: string[]) {
      const itemsById = new Map<string, ExerciseItemRecord>()

      for (const items of exerciseItemsByVersion.values()) {
        for (const item of items) {
          itemsById.set(item.id, item)
        }
      }

      return itemIds.flatMap((itemId) => {
        const item = itemsById.get(itemId)

        return item ? [item] : []
      })
    },

    async updateExerciseItems(
      versionId: string,
      items: ExerciseItemRecord[],
      expectedRevision: number,
    ) {
      const version = requireMutableVersion(versionId, expectedRevision)

      if (items.length === 0) {
        return version.contentRevision
      }

      for (const item of items) {
        if (item.sourceVersionId !== versionId) {
          throw new Error(`Exercise item ${item.id} belongs to another source version`)
        }

        const currentItems = exerciseItemsByVersion.get(versionId)

        if (!currentItems?.some((candidate) => candidate.id === item.id)) {
          throw new Error(`Exercise item ${item.id} is missing`)
        }
      }

      for (const item of items) {
        const currentItems = exerciseItemsByVersion.get(versionId) ?? []

        exerciseItemsByVersion.set(
          versionId,
          currentItems.map((candidate) => (candidate.id === item.id ? item : candidate)),
        )
      }

      return incrementRevision(version)
    },

    async publishSourceVersion(
      versionId: string,
      publishedAt: string,
      expectedRevision: number,
    ) {
      const version = requireMutableVersion(versionId, expectedRevision)

      const published: SourceVersionRecord = {
        ...version,
        status: 'published',
        publishedAt,
      }

      versions.set(versionId, published)

      return published
    },

    async archiveDraftVersion(versionId: string, expectedRevision: number) {
      const version = requireMutableVersion(versionId, expectedRevision)
      const archived: SourceVersionRecord = {
        ...version,
        status: 'archived',
      }

      versions.set(versionId, archived)

      return archived
    },
  }
}
