import {
  IMPORT_FIELD_LIMITS,
  type importWordRequestSchema,
} from '@shared/api/schemas'
import { canonicalizeLearningText } from '@shared/api/taskContentSafety'
import Papa from 'papaparse'
import type { z } from 'zod'

const CSV_HEADERS = ['word', 'meaning', 'exampleSentence', 'partOfSpeech'] as const
const MAX_CSV_BYTES = 256 * 1024
const MAX_DATA_ROWS = 500

export const ADMIN_CSV_TEMPLATE_FILENAME = 'eng-learn-word-import-template.csv'
export const ADMIN_CSV_TEMPLATE_CONTENT = `\uFEFF${CSV_HEADERS.join(',')}\r\n`
export const ADMIN_CSV_TEMPLATE_URL =
  `data:text/csv;charset=utf-8,${encodeURIComponent(ADMIN_CSV_TEMPLATE_CONTENT)}`

export type CsvImportWord = z.output<typeof importWordRequestSchema>

export type CsvImportIssue = {
  code:
    | 'duplicate_word'
    | 'field_too_long'
    | 'file_too_large'
    | 'invalid_column_count'
    | 'invalid_csv'
    | 'invalid_encoding'
    | 'invalid_header'
    | 'no_data_rows'
    | 'required_field'
    | 'too_many_rows'
  message: string
  row?: number
  field?: (typeof CSV_HEADERS)[number]
  firstRow?: number
}

export type CsvImportResult =
  | { ok: true; words: CsvImportWord[] }
  | { ok: false; issues: CsvImportIssue[] }

export const parseAdminCsv = async (file: File): Promise<CsvImportResult> => {
  if (file.size > MAX_CSV_BYTES) {
    return {
      ok: false,
      issues: [{ code: 'file_too_large', message: 'CSV must not exceed 256 KiB' }],
    }
  }

  let contents: string

  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    return invalidEncoding()
  }

  if (contents.includes('\uFFFD')) {
    return invalidEncoding()
  }

  const parsed = Papa.parse<string[]>(contents.replace(/^\uFEFF/u, ''), {
    delimiter: ',',
    skipEmptyLines: false,
  })
  const [header, ...rows] = parsed.data
  const quotingIssues: CsvImportIssue[] = parsed.errors
    .filter((error) => error.type === 'Quotes')
    .map((error) => ({
      code: 'invalid_csv',
      message: 'CSV quoting is malformed',
      row: (error.row ?? 0) + 1,
    }))

  if (quotingIssues.length > 0) {
    return { ok: false, issues: quotingIssues }
  }

  if (!hasExpectedHeader(header)) {
    return {
      ok: false,
      issues: [{ code: 'invalid_header', message: `Expected header: ${CSV_HEADERS.join(',')}` }],
    }
  }

  while (isBlankRow(rows.at(-1))) {
    rows.pop()
  }

  if (rows.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'no_data_rows', message: 'CSV must contain at least one data row' }],
    }
  }

  if (rows.length > MAX_DATA_ROWS) {
    return {
      ok: false,
      issues: [{ code: 'too_many_rows', message: 'CSV must contain at most 500 data rows' }],
    }
  }

  const columnIssues = rows.flatMap<CsvImportIssue>((row, index) =>
    row.length === CSV_HEADERS.length
      ? []
      : [
          {
            code: 'invalid_column_count',
            message: `Expected ${String(CSV_HEADERS.length)} fields`,
            row: index + 2,
          },
        ],
  )

  if (columnIssues.length > 0) {
    return { ok: false, issues: columnIssues }
  }

  const issues: CsvImportIssue[] = []
  const seenWords = new Map<string, number>()
  const words = rows.map(([rawWord = '', rawMeaning = '', exampleSentence = '', rawPart = ''], index) => {
    const row = index + 2
    const word = rawWord.trim()
    const meaning = rawMeaning.trim()
    const partOfSpeech = rawPart.trim()

    if (!word) {
      issues.push({ code: 'required_field', message: 'word is required', row, field: 'word' })
    }
    if (!meaning) {
      issues.push({
        code: 'required_field',
        message: 'meaning is required',
        row,
        field: 'meaning',
      })
    }

    const boundedFields = {
      word,
      meaning,
      exampleSentence,
      partOfSpeech,
    }

    for (const field of CSV_HEADERS) {
      if (boundedFields[field].length > IMPORT_FIELD_LIMITS[field]) {
        issues.push({
          code: 'field_too_long',
          message: `${field} must not exceed ${String(IMPORT_FIELD_LIMITS[field])} characters`,
          row,
          field,
        })
      }
    }

    if (word) {
      const duplicateKey = canonicalizeLearningText(word)
      const firstRow = seenWords.get(duplicateKey)

      if (firstRow === undefined) {
        seenWords.set(duplicateKey, row)
      } else {
        issues.push({
          code: 'duplicate_word',
          message: `Duplicate word; first seen on row ${String(firstRow)}`,
          row,
          field: 'word',
          firstRow,
        })
      }
    }

    return {
      word,
      meaning,
      exampleSentence,
      ...(partOfSpeech ? { partOfSpeech } : {}),
    }
  })

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return {
    ok: true,
    words,
  }
}

const hasExpectedHeader = (header: string[] | undefined): boolean =>
  header?.length === CSV_HEADERS.length &&
  CSV_HEADERS.every((expected, index) => header[index] === expected)

const isBlankRow = (row: string[] | undefined): boolean =>
  row !== undefined && row.every((field) => field.trim() === '')

const invalidEncoding = (): CsvImportResult => ({
  ok: false,
  issues: [
    {
      code: 'invalid_encoding',
      message: 'CSV must be valid UTF-8 without replacement characters',
    },
  ],
})
