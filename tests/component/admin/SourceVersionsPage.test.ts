import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import SourceVersionsPage from '@/pages/admin/SourceVersionsPage.vue'

const publishedVersion = {
  sourceId: 'source-1',
  sourceName: 'Starter words',
  versionId: 'version-1',
  versionNo: 1,
  status: 'published' as const,
  wordCount: 20,
  groupCount: 4,
  exerciseItemCount: 120,
  approvedItemCount: 120,
  createdAt: '2026-07-13T00:00:00.000Z',
  publishedAt: '2026-07-13T01:00:00.000Z',
}

const setCsvFile = async (wrapper: ReturnType<typeof mount>, contents: string): Promise<void> => {
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File([contents], 'words.csv', { type: 'text/csv' })],
  })
  await input.trigger('change')
  await flushPromises()
}

describe('SourceVersionsPage', () => {
  it('separates loading, empty and a server-refreshed successful import', async () => {
    let resolveVersions: ((value: never[]) => void) | undefined
    const initialVersions = new Promise<never[]>((resolve) => {
      resolveVersions = resolve
    })
    const api = {
      listSourceVersions: vi
        .fn()
        .mockReturnValueOnce(initialVersions)
        .mockResolvedValueOnce([publishedVersion]),
      importSourceVersion: vi.fn().mockResolvedValue({
        sourceId: 'source-1',
        versionId: 'version-1',
        versionNo: 1,
        status: 'draft' as const,
        wordCount: 1,
        groupCount: 1,
      }),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })

    expect(wrapper.get('[role="status"]').text()).toContain('正在读取词库版本')
    expect(wrapper.find('table').exists()).toBe(false)

    resolveVersions?.([])
    await flushPromises()
    expect(wrapper.text()).toContain('还没有词库版本')

    await wrapper.get('input[name="source-name"]').setValue('Starter words')
    await setCsvFile(
      wrapper,
      'word,meaning,exampleSentence,partOfSpeech\napple,苹果,I eat an apple.,noun',
    )

    expect(wrapper.get('[data-csv-preview]').text()).toContain('1 个词')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()

    const command = requireRecord(
      (api.importSourceVersion.mock.calls as unknown[][])[0]?.[0],
    )
    expect(command).toMatchObject({
      mode: 'new_source',
      sourceName: 'Starter words',
      words: [
        {
          word: 'apple',
          meaning: '苹果',
          exampleSentence: 'I eat an apple.',
          partOfSpeech: 'noun',
        },
      ],
    })
    expect(command.operationToken).toMatch(/^[0-9a-f]{64}$/)
    expect(api.listSourceVersions).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="status"]').text()).toContain('服务端已创建 v1')
    expect(wrapper.get('table').text()).toContain('Starter words')
  })

  it('creates a next version with the selected server source id', async () => {
    const api = {
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      importSourceVersion: vi.fn().mockResolvedValue({
        sourceId: 'source-1',
        versionId: 'version-2',
        versionNo: 2,
        status: 'draft' as const,
        wordCount: 1,
        groupCount: 1,
      }),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api, initialMode: 'next_version', initialSourceId: 'source-1' },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    await setCsvFile(
      wrapper,
      'word,meaning,exampleSentence,partOfSpeech\npear,梨,I eat a pear.,noun',
    )

    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()

    expect(api.importSourceVersion).toHaveBeenCalledWith({
      mode: 'next_version',
      sourceId: 'source-1',
      words: [
        {
          word: 'pear',
          meaning: '梨',
          exampleSentence: 'I eat a pear.',
          partOfSpeech: 'noun',
        },
      ],
    })
  })

  it('keeps a validated preview available when an import conflicts', async () => {
    const api = {
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      importSourceVersion: vi.fn().mockRejectedValue(
        new ApiFailureError(409, {
          code: 'source_draft_exists',
          message: 'A draft already exists',
        }),
      ),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    await wrapper.get('input[name="source-name"]').setValue('Starter words')
    await setCsvFile(
      wrapper,
      'word,meaning,exampleSentence,partOfSpeech\napple,苹果,I eat an apple.,noun',
    )
    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('已有草稿版本')
    expect(wrapper.get('[data-csv-preview]').text()).toContain('1 个词')
  })

  it('offers a page-level retry when the version list cannot be read', async () => {
    const api = {
      listSourceVersions: vi
        .fn()
        .mockRejectedValueOnce(new ApiNetworkError(new Error('offline')))
        .mockResolvedValueOnce([]),
      importSourceVersion: vi.fn(),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('无法读取词库版本')
    await wrapper.get('button[data-retry-list]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('还没有词库版本')
    expect(api.listSourceVersions).toHaveBeenCalledTimes(2)
  })

  it('safely retries a lost new-source response with the exact token and payload', async () => {
    const committed = {
      sourceId: 'source-2',
      versionId: 'version-2',
      versionNo: 1,
      status: 'draft' as const,
      wordCount: 1,
      groupCount: 1,
    }
    const api = {
      listSourceVersions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            ...publishedVersion,
            sourceId: committed.sourceId,
            versionId: committed.versionId,
            status: 'draft' as const,
            publishedAt: undefined,
          },
        ]),
      importSourceVersion: vi
        .fn()
        .mockImplementationOnce(async () => {
          await Promise.resolve(committed)
          throw new InvalidApiResponseError(200)
        })
        .mockRejectedValueOnce(
          new ApiFailureError(503, {
            code: 'dependency_failure',
            message: 'Committed, but outcome read failed',
          }),
        )
        .mockResolvedValueOnce(committed),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    await wrapper.get('input[name="source-name"]').setValue('Starter words')
    await setCsvFile(
      wrapper,
      'word,meaning,exampleSentence,partOfSpeech\napple,苹果,I eat an apple.,noun',
    )
    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain('结果未知')
    expect(wrapper.text()).not.toContain('可直接重试')
    const firstCommand = requireRecord(
      (api.importSourceVersion.mock.calls as unknown[][])[0]?.[0],
    )
    expect(firstCommand.operationToken).toMatch(/^[0-9a-f]{64}$/)

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()

    expect((api.importSourceVersion.mock.calls as unknown[][])[1]?.[0]).toEqual(
      firstCommand,
    )
    expect(wrapper.get('[data-unknown-result]').text()).toContain('结果未知')

    await wrapper.get('[data-retry-unknown]').trigger('click')
    await flushPromises()

    expect((api.importSourceVersion.mock.calls as unknown[][])[2]?.[0]).toEqual(
      firstCommand,
    )
    expect(wrapper.get('[role="status"]').text()).toContain('服务端已创建 v1')
  })

  it('does not offer a blind retry when a next-version result is unknown', async () => {
    const api = {
      listSourceVersions: vi.fn().mockResolvedValue([publishedVersion]),
      importSourceVersion: vi
        .fn()
        .mockRejectedValue(new ApiNetworkError(new Error('response lost'))),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api, initialMode: 'next_version', initialSourceId: 'source-1' },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    await setCsvFile(
      wrapper,
      'word,meaning,exampleSentence,partOfSpeech\npear,梨,I eat a pear.,noun',
    )
    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-unknown-result]').text()).toContain('重新读取服务端状态')
    expect(wrapper.find('[data-retry-unknown]').exists()).toBe(false)
  })

  it('keeps only the newest CSV parse when an older file finishes last', async () => {
    const firstBuffer = deferred<ArrayBuffer>()
    const secondBuffer = deferred<ArrayBuffer>()
    const firstFile = createDeferredCsvFile('first.csv', firstBuffer.promise)
    const secondFile = createDeferredCsvFile('second.csv', secondBuffer.promise)
    const api = {
      listSourceVersions: vi.fn().mockResolvedValue([]),
      importSourceVersion: vi.fn().mockResolvedValue({
        sourceId: 'source-pear',
        versionId: 'version-pear',
        versionNo: 1,
        status: 'draft' as const,
        wordCount: 1,
        groupCount: 1,
      }),
    }
    const wrapper = mount(SourceVersionsPage, {
      props: { api },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    await flushPromises()
    await wrapper.get('input[name="source-name"]').setValue('Newest file')
    const input = wrapper.get('input[type="file"]')

    setInputFile(input.element, firstFile)
    const firstChange = input.trigger('change')
    await Promise.resolve()
    setInputFile(input.element, secondFile)
    const secondChange = input.trigger('change')
    await Promise.resolve()

    secondBuffer.resolve(
      encodeCsv(
        'word,meaning,exampleSentence,partOfSpeech\npear,梨,I eat a pear.,noun',
      ),
    )
    await secondChange
    await flushPromises()
    expect(wrapper.get('[data-csv-preview]').text()).toContain('pear')

    firstBuffer.resolve(
      encodeCsv(
        'word,meaning,exampleSentence,partOfSpeech\napple,苹果,I eat an apple.,noun',
      ),
    )
    await firstChange
    await flushPromises()
    expect(wrapper.get('[data-csv-preview]').text()).toContain('pear')
    expect(wrapper.get('[data-csv-preview]').text()).not.toContain('apple')

    await wrapper.get('form[data-import-form]').trigger('submit')
    await flushPromises()
    const command = requireRecord(
      (api.importSourceVersion.mock.calls as unknown[][])[0]?.[0],
    )
    expect(command).toMatchObject({
      mode: 'new_source',
      sourceName: 'Newest file',
      words: [
        {
          word: 'pear',
          meaning: '梨',
          exampleSentence: 'I eat a pear.',
          partOfSpeech: 'noun',
        },
      ],
    })
    expect(command.operationToken).toMatch(/^[0-9a-f]{64}$/)
  })
})

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

const createDeferredCsvFile = (name: string, contents: Promise<ArrayBuffer>): File => {
  const file = new File(['pending'], name, { type: 'text/csv' })
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: () => contents,
  })

  return file
}

const setInputFile = (input: Element, file: File): void => {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [file],
  })
}

const encodeCsv = (contents: string): ArrayBuffer =>
  new TextEncoder().encode(contents).buffer

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a recorded command object')
  }

  return value as Record<string, unknown>
}
