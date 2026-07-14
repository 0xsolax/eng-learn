import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

interface ReleaseMetadataSanitizer {
  sanitizeGeneratedReleaseMetadata: (paths: {
    outputConfigPath: string
    workerPath: string
  }) => Promise<void>
  stripGeneratedSourceRegionComments: (source: string) => string
}

const sanitizerModuleUrl = new URL(
  '../../scripts/release-metadata-sanitizer.mjs',
  import.meta.url,
).href
const sanitizerModule: unknown = await import(sanitizerModuleUrl)
const {
  sanitizeGeneratedReleaseMetadata,
  stripGeneratedSourceRegionComments,
} = sanitizerModule as ReleaseMetadataSanitizer

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('release metadata sanitizer', () => {
  it('removes real region comments without changing lookalike runtime values', () => {
    const sourceLines = [
      '//#region /Users/build-agent/work/index.js',
      'const plain = "//#region string"',
      'const regex = /^\\/\\/#region regex$/',
      'const noInterpolation = `before',
      '//#region template',
      'after`',
      'const interpolated = `head',
      '//#region template-head',
      '${1}',
      '//#region template-middle',
      '${2}',
      '//#endregion template-tail',
      'end`',
      '  //#region indented real comment',
      'const value = 2',
      '\t//#endregion',
      '//#regional ordinary comment',
      'return {',
      '  interpolated,',
      '  noInterpolation,',
      '  plain,',
      '  regexMatches: regex.test("//#region regex"),',
      '  value,',
      '}',
      '//#endregion',
    ]
    const expectedLines = sourceLines.filter(
      (_, index) => ![0, 13, 15, 24].includes(index),
    )

    const sanitized = stripGeneratedSourceRegionComments(sourceLines.join('\n'))

    expect(sanitized).toBe(`${expectedLines.join('\n')}\n`)
    const runtimeValue: unknown = runInNewContext(`(() => {\n${sanitized}\n})()`)
    expect(runtimeValue).toEqual({
      interpolated:
        'head\n//#region template-head\n1\n//#region template-middle\n2\n//#endregion template-tail\nend',
      noInterpolation: 'before\n//#region template\nafter',
      plain: '//#region string',
      regexMatches: true,
      value: 2,
    })
  })

  it('removes generated Wrangler host paths without changing runtime fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-learn-release-sanitizer-'))
    temporaryRoots.push(root)
    const workerPath = join(root, 'index.js')
    const outputConfigPath = join(root, 'wrangler.json')
    await writeFile(workerPath, '//#region generated\nconst ready = true\n//#endregion\n')
    await writeFile(
      outputConfigPath,
      JSON.stringify({
        assets: { directory: '../client' },
        configPath: '/private/build/wrangler.jsonc',
        main: 'index.js',
        userConfigPath: '/private/build/wrangler.jsonc',
      }),
    )

    await sanitizeGeneratedReleaseMetadata({ outputConfigPath, workerPath })

    expect(await readFile(workerPath, 'utf8')).toBe('const ready = true\n')
    expect(JSON.parse(await readFile(outputConfigPath, 'utf8'))).toEqual({
      assets: { directory: '../client' },
      main: 'index.js',
    })
  })
})
