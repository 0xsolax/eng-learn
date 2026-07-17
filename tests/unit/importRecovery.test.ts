import { describe, expect, it } from 'vitest'
import {
  PENDING_SOURCE_VERSION_IMPORT_KEY,
  restorePendingSourceVersionImport,
} from '../../src/features/admin-content/importRecovery'

const createStorage = (): Storage => {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

describe('source-version import recovery', () => {
  it('clears schema-valid recovery data that is too large to trust', () => {
    const storage = createStorage()
    const serialized = JSON.stringify({
      mode: 'new_source',
      operationToken: 'a'.repeat(64),
      sourceName: 'Oversized source',
      words: Array.from({ length: 500 }, (_, index) => ({
        word: `word-${String(index)}`,
        meaning: '含义',
        examplePhrase: 'p'.repeat(1_100),
        exampleSentence: 'A valid sentence.',
        exampleSentenceExtended: 'A longer valid sentence for learning.',
        partOfSpeech: 'noun',
      })),
    })

    expect(serialized.length).toBeGreaterThan(512 * 1024)
    storage.setItem(PENDING_SOURCE_VERSION_IMPORT_KEY, serialized)

    expect(restorePendingSourceVersionImport(storage)).toEqual({ status: 'invalid' })
    expect(storage.getItem(PENDING_SOURCE_VERSION_IMPORT_KEY)).toBeNull()
  })
})
