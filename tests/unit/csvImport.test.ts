import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_CSV_TEMPLATE_CONTENT,
  ADMIN_CSV_TEMPLATE_FILENAME,
  parseAdminCsv,
} from '@/features/admin-content/csvImport'

const csvFile = (contents: string): File =>
  new File([new TextEncoder().encode(contents)], 'words.csv', { type: 'text/csv' })

describe('admin CSV import', () => {
  it('provides a header-only Excel-compatible template that remains valid when filled in', async () => {
    expect(ADMIN_CSV_TEMPLATE_FILENAME).toBe('eng-learn-word-import-template.csv')
    expect(ADMIN_CSV_TEMPLATE_CONTENT).toBe(
      '\uFEFFword,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\r\n',
    )

    await expect(
      parseAdminCsv(
        csvFile(
          `${ADMIN_CSV_TEMPLATE_CONTENT}apple,苹果,An apple,I eat an apple,I eat an apple every day,noun\r\n`,
        ),
      ),
    ).resolves.toEqual({
      ok: true,
      words: [
        {
          word: 'apple',
          meaning: '苹果',
          examplePhrase: 'An apple',
          exampleSentence: 'I eat an apple',
          exampleSentenceExtended: 'I eat an apple every day',
          partOfSpeech: 'noun',
        },
      ],
    })
  })

  it('decodes an optional UTF-8 BOM and RFC4180 quoted fields into structured words', async () => {
    const file = csvFile(
      '\uFEFFword,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\r\n' +
        'apple,"red, round fruit","an apple","She said ""apple"".\r\nThen she ate it.","She ate the apple after lunch.",noun\r\n',
    )

    await expect(parseAdminCsv(file)).resolves.toEqual({
      ok: true,
      words: [
        {
          word: 'apple',
          meaning: 'red, round fruit',
          examplePhrase: 'an apple',
          exampleSentence: 'She said "apple".\r\nThen she ate it.',
          exampleSentenceExtended: 'She ate the apple after lunch.',
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
      'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\n' +
        'app\uFFFDle,fruit,a phrase,a sentence,an extended sentence,noun',
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
          message:
            'Expected header: word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
        },
      ],
    }

    await expect(
      parseAdminCsv(
        csvFile(
          'word,meaning,example_phrase,example_sentence,example_sentence_extended,part_of_speech\n' +
            'apple,fruit,an apple,I eat an apple,I eat an apple every day,noun',
        ),
      ),
    ).resolves.toEqual(expected)
    await expect(
      parseAdminCsv(
        csvFile(
          'meaning,word,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\n' +
            'fruit,apple,an apple,I eat an apple,I eat an apple every day,noun',
        ),
      ),
    ).resolves.toEqual(expected)
    await expect(
      parseAdminCsv(
        csvFile(
          'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech,notes\n' +
            'apple,fruit,an apple,I eat an apple,I eat an apple every day,noun,x',
        ),
      ),
    ).resolves.toEqual(expected)
  })

  it('rejects files larger than 256 KiB before parsing', async () => {
    const header =
      'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech'
    let paddingBytes = 256 * 1024 - new TextEncoder().encode([
      header,
      ...Array.from(
        { length: 500 },
        (_, index) => `word-${String(index + 1)},${'m'.repeat(500)},p,s,e,noun`,
      ),
    ].join('\n')).byteLength
    const atLimitRows = Array.from({ length: 500 }, (_, index) => {
      const padding = Math.min(paddingBytes, 1_999)

      paddingBytes -= padding
      return `word-${String(index + 1)},${'m'.repeat(500)},p,s,${'e'.repeat(padding + 1)},noun`
    })
    const atLimit = csvFile([header, ...atLimitRows].join('\n'))
    const oversized = new File([new Uint8Array(256 * 1024 + 1)], 'oversized.csv', {
      type: 'text/csv',
    })

    expect(paddingBytes).toBe(0)
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
          csvFile(
            'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\n' +
              'apple,fruit,an apple,I eat an apple,I eat an apple every day,noun',
          ),
        ),
      ).resolves.toMatchObject({ ok: true })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts at most 500 data rows', async () => {
    const header =
      'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech'
    const rows = Array.from(
      { length: 501 },
      (_, index) =>
        `word-${String(index + 1)},meaning-${String(index + 1)},phrase-${String(index + 1)},sentence-${String(index + 1)},extended-${String(index + 1)},noun`,
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
          'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
          '  ,fruit,a phrase,a sentence,an extended sentence,noun',
          'pear,   ,a pear,I eat a pear,I eat a pear every day,',
          'Apple,fruit,an apple,I eat an apple,I eat an apple every day,noun',
          ' apple ,different fruit,an apple,I buy an apple,I buy an apple today,noun',
          'plum,fruit,   ,I eat a plum,I eat a plum every day,noun',
          'peach,fruit,a peach,   ,I eat a peach every day,noun',
          'grape,fruit,a grape,I eat a grape,   ,noun',
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
        {
          code: 'required_field',
          message: 'examplePhrase is required',
          row: 6,
          field: 'examplePhrase',
        },
        {
          code: 'required_field',
          message: 'exampleSentence is required',
          row: 7,
          field: 'exampleSentence',
        },
        {
          code: 'required_field',
          message: 'exampleSentenceExtended is required',
          row: 8,
          field: 'exampleSentenceExtended',
        },
      ],
    })
  })

  it('reports canonically equivalent Unicode words as duplicates', async () => {
    await expect(
      parseAdminCsv(
        csvFile(
          [
            'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
            'café,咖啡,un café,I drink café,I drink café every morning,noun',
            'cafe\u0301,同一咖啡,un café,I like café,I like café after lunch,noun',
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
          'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
          `${'w'.repeat(121)},${'m'.repeat(501)},${'p'.repeat(2_001)},${'s'.repeat(2_001)},${'e'.repeat(2_001)},${'x'.repeat(65)}`,
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
          message: 'examplePhrase must not exceed 2000 characters',
          row: 2,
          field: 'examplePhrase',
        },
        {
          code: 'field_too_long',
          message: 'exampleSentence must not exceed 2000 characters',
          row: 2,
          field: 'exampleSentence',
        },
        {
          code: 'field_too_long',
          message: 'exampleSentenceExtended must not exceed 2000 characters',
          row: 2,
          field: 'exampleSentenceExtended',
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
    const header =
      'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech'

    await expect(
      parseAdminCsv(csvFile(`${header}\n"apple,fruit,an apple,a sentence,extended,noun`)),
    ).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'invalid_csv',
          message: 'CSV quoting is malformed',
          row: 2,
        },
      ],
    })
    await expect(
      parseAdminCsv(csvFile(`${header}\napple,fruit,an apple,a sentence,extended`)),
    ).resolves.toEqual({
      ok: false,
      issues: [
        {
          code: 'invalid_column_count',
          message: 'Expected 6 fields',
          row: 2,
        },
      ],
    })
  })

  it('rejects a header-only file with no data rows', async () => {
    await expect(
      parseAdminCsv(
        csvFile(
          'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\n',
        ),
      ),
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
