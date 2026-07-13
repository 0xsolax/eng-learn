import { describe, expect, it, vi } from 'vitest'
import { parseAdminCsv } from '@/features/admin-content/csvImport'

const csvFile = (contents: string): File =>
  new File([new TextEncoder().encode(contents)], 'words.csv', { type: 'text/csv' })

describe('admin CSV import', () => {
  it('decodes an optional UTF-8 BOM and RFC4180 quoted fields into structured words', async () => {
    const file = csvFile(
      '\uFEFFword,meaning,exampleSentence,partOfSpeech\r\n' +
        'apple,"red, round fruit","She said ""apple"".\r\nThen she ate it.",noun\r\n',
    )

    await expect(parseAdminCsv(file)).resolves.toEqual({
      ok: true,
      words: [
        {
          word: 'apple',
          meaning: 'red, round fruit',
          exampleSentence: 'She said "apple".\r\nThen she ate it.',
          partOfSpeech: 'noun',
        },
      ],
    })
  })

  it('rejects invalid UTF-8 bytes and replacement characters', async () => {
    const invalidBytes = new File([Uint8Array.from([0xff])], 'invalid.csv', {
      type: 'text/csv',
    })
    const replacementCharacter = csvFile(
      'word,meaning,exampleSentence,partOfSpeech\napp\uFFFDle,fruit,,noun',
    )
    const expected = {
      ok: false,
      issues: [
        {
          code: 'invalid_encoding',
          message: 'CSV must be valid UTF-8 without replacement characters',
        },
      ],
    }

    await expect(parseAdminCsv(invalidBytes)).resolves.toEqual(expected)
    await expect(parseAdminCsv(replacementCharacter)).resolves.toEqual(expected)
  })

  it('requires the exact camelCase header names in the frozen order', async () => {
    const expected = {
      ok: false,
      issues: [
        {
          code: 'invalid_header',
          message: 'Expected header: word,meaning,exampleSentence,partOfSpeech',
        },
      ],
    }

    await expect(
      parseAdminCsv(
        csvFile('word,meaning,example_sentence,part_of_speech\napple,fruit,,noun'),
      ),
    ).resolves.toEqual(expected)
    await expect(
      parseAdminCsv(
        csvFile('meaning,word,exampleSentence,partOfSpeech\nfruit,apple,,noun'),
      ),
    ).resolves.toEqual(expected)
    await expect(
      parseAdminCsv(
        csvFile('word,meaning,exampleSentence,partOfSpeech,notes\napple,fruit,,noun,x'),
      ),
    ).resolves.toEqual(expected)
  })

  it('rejects files larger than 256 KiB before parsing', async () => {
    const header = 'word,meaning,exampleSentence,partOfSpeech'
    const atLimitRows = Array.from({ length: 500 }, (_, index) => {
      const exampleLength = index < 2 ? 2_000 : index === 2 ? 211 : 0

      return `word-${String(index + 1)},${'m'.repeat(500)},${'e'.repeat(exampleLength)},noun`
    })
    const atLimit = csvFile([header, ...atLimitRows].join('\n'))
    const oversized = new File([new Uint8Array(256 * 1024 + 1)], 'oversized.csv', {
      type: 'text/csv',
    })

    expect(atLimit.size).toBe(256 * 1024)
    expect((await parseAdminCsv(atLimit)).ok).toBe(true)
    await expect(parseAdminCsv(oversized)).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'file_too_large',
          message: 'CSV must not exceed 256 KiB',
        },
      ],
    })
  })

  it('parses the browser File locally without issuing a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      await expect(
        parseAdminCsv(
          csvFile('word,meaning,exampleSentence,partOfSpeech\napple,fruit,,noun'),
        ),
      ).resolves.toMatchObject({ ok: true })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts at most 500 data rows', async () => {
    const header = 'word,meaning,exampleSentence,partOfSpeech'
    const rows = Array.from(
      { length: 501 },
      (_, index) => `word-${String(index + 1)},meaning-${String(index + 1)},,noun`,
    )
    const accepted = await parseAdminCsv(csvFile([header, ...rows.slice(0, 500)].join('\n')))

    expect(accepted.ok).toBe(true)
    expect(accepted.ok ? accepted.words : []).toHaveLength(500)
    await expect(parseAdminCsv(csvFile([header, ...rows].join('\n')))).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'too_many_rows',
          message: 'CSV must contain at most 500 data rows',
        },
      ],
    })
  })

  it('reports required fields and case-insensitive duplicate words with CSV row numbers', async () => {
    const result = await parseAdminCsv(
      csvFile(
        [
          'word,meaning,exampleSentence,partOfSpeech',
          '  ,fruit,,noun',
          'pear,   ,,',
          'Apple,fruit,,noun',
          ' apple ,different fruit,,noun',
        ].join('\n'),
      ),
    )

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: 'required_field',
          message: 'word is required',
          row: 2,
          field: 'word',
        },
        {
          code: 'required_field',
          message: 'meaning is required',
          row: 3,
          field: 'meaning',
        },
        {
          code: 'duplicate_word',
          message: 'Duplicate word; first seen on row 4',
          row: 5,
          field: 'word',
          firstRow: 4,
        },
      ],
    })
  })

  it('reports canonically equivalent Unicode words as duplicates', async () => {
    await expect(
      parseAdminCsv(
        csvFile(
          [
            'word,meaning,exampleSentence,partOfSpeech',
            'café,咖啡,,noun',
            'cafe\u0301,同一咖啡,,noun',
          ].join('\n'),
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'duplicate_word',
          message: 'Duplicate word; first seen on row 2',
          row: 3,
          field: 'word',
          firstRow: 2,
        },
      ],
    })
  })

  it('rejects fields that exceed the shared API limits before submission', async () => {
    const result = await parseAdminCsv(
      csvFile(
        [
          'word,meaning,exampleSentence,partOfSpeech',
          `${'w'.repeat(121)},${'m'.repeat(501)},${'e'.repeat(2_001)},${'p'.repeat(65)}`,
        ].join('\n'),
      ),
    )

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: 'field_too_long',
          message: 'word must not exceed 120 characters',
          row: 2,
          field: 'word',
        },
        {
          code: 'field_too_long',
          message: 'meaning must not exceed 500 characters',
          row: 2,
          field: 'meaning',
        },
        {
          code: 'field_too_long',
          message: 'exampleSentence must not exceed 2000 characters',
          row: 2,
          field: 'exampleSentence',
        },
        {
          code: 'field_too_long',
          message: 'partOfSpeech must not exceed 64 characters',
          row: 2,
          field: 'partOfSpeech',
        },
      ],
    })
  })

  it('rejects malformed RFC4180 quoting and data rows with the wrong field count', async () => {
    const header = 'word,meaning,exampleSentence,partOfSpeech'

    await expect(parseAdminCsv(csvFile(`${header}\n"apple,fruit,,noun`))).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'invalid_csv',
          message: 'CSV quoting is malformed',
          row: 2,
        },
      ],
    })
    await expect(parseAdminCsv(csvFile(`${header}\napple,fruit,,noun,extra`))).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'invalid_column_count',
          message: 'Expected 4 fields',
          row: 2,
        },
      ],
    })
  })

  it('rejects a header-only file with no data rows', async () => {
    await expect(
      parseAdminCsv(csvFile('word,meaning,exampleSentence,partOfSpeech\n')),
    ).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'no_data_rows',
          message: 'CSV must contain at least one data row',
        },
      ],
    })
  })
})
