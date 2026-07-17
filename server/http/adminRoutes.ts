import { z } from 'zod'
import {
  approveExerciseItemsRequestSchema,
  editExerciseItemRequestSchema,
} from '../../shared/api/contentSchemas'
import {
  importSourceVersionCommandSchema,
} from '../../shared/api/schemas'
import type { ContentBuilder } from '../services/ContentBuilder'
import type { ImportWordInput } from '../../shared/domain/content'
import { DomainError } from '../errors/DomainError'
import { apiOk } from './apiResponse'
import { MAX_IMPORT_JSON_REQUEST_BYTES, parseJsonRequest } from './request'

const emptyRequestSchema = z.object({}).strict()

export const routeAdminContentRequest = async (
  request: Request,
  url: URL,
  contentBuilder: ContentBuilder,
): Promise<Response | undefined> => {
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  if (request.method === 'GET' && url.pathname === '/api/admin/health') {
    return apiOk({ scope: 'admin' })
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/source-versions') {
    return apiOk(await contentBuilder.listSourceVersions())
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/source-versions/import') {
    const input = await parseJsonRequest(request, importSourceVersionCommandSchema, {
      maxBytes: MAX_IMPORT_JSON_REQUEST_BYTES,
    })

    return apiOk(
      input.mode === 'new_source'
        ? await contentBuilder.importNewSourceIdempotently({
            operationToken: input.operationToken,
            sourceName: input.sourceName,
            words: toImportWords(input.words),
          })
        : await contentBuilder.importNextVersion({
            sourceId: input.sourceId,
            words: toImportWords(input.words),
          }),
    )
  }

  if (isSourceVersionRoute(path, 4) && request.method === 'GET') {
    return apiOk(await contentBuilder.getSourceVersionDetail(requireSegment(path, 3)))
  }

  if (isSourceVersionAction(path, 'build') && request.method === 'POST') {
    await parseOptionalEmptyJson(request)

    return apiOk(await contentBuilder.buildExerciseItems(requireSegment(path, 3)))
  }

  if (isSourceVersionAction(path, 'coverage') && request.method === 'GET') {
    return apiOk(await contentBuilder.getCoverage(requireSegment(path, 3)))
  }

  if (isSourceVersionAction(path, 'exercises') && request.method === 'GET') {
    return apiOk(await contentBuilder.listExerciseItems(requireSegment(path, 3)))
  }

  if (isSourceVersionAction(path, 'discard') && request.method === 'POST') {
    await parseOptionalEmptyJson(request)

    return apiOk(await contentBuilder.discardDraft(requireSegment(path, 3)))
  }

  if (isSourceVersionAction(path, 'publish') && request.method === 'POST') {
    await parseOptionalEmptyJson(request)

    return apiOk(await contentBuilder.publishVersion(requireSegment(path, 3)))
  }

  if (isExerciseItemRoute(path) && request.method === 'GET') {
    return apiOk(await contentBuilder.getExerciseItem(requireSegment(path, 3)))
  }

  if (isExerciseItemRoute(path) && request.method === 'PUT') {
    const itemId = requireSegment(path, 3)
    const input = await parseJsonRequest(request, editExerciseItemRequestSchema)
    const existing = await contentBuilder.getExerciseItem(itemId)

    if (
      input.content.stage !== existing.stage ||
      input.content.taskType !== existing.taskType
    ) {
      throw new DomainError('task_type_mismatch', 'Exercise task type cannot be changed')
    }

    return apiOk(
      await contentBuilder.editExerciseItem(itemId, {
        prompt: input.content.prompt,
        answer: input.content.answer,
      }),
    )
  }

  if (isExerciseItemAction(path, 'approve') && request.method === 'POST') {
    await parseOptionalEmptyJson(request)
    const itemId = requireSegment(path, 3)
    await contentBuilder.approveExerciseItem(itemId)

    return apiOk({ itemId, status: 'approved' })
  }

  if (isExerciseItemAction(path, 'disable') && request.method === 'POST') {
    await parseOptionalEmptyJson(request)
    const itemId = requireSegment(path, 3)
    await contentBuilder.disableExerciseItem(itemId)

    return apiOk({ itemId, status: 'disabled' })
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/exercise-items/batch-approve') {
    const input = await parseJsonRequest(request, approveExerciseItemsRequestSchema)
    await contentBuilder.approveExerciseItems(input.itemIds)

    return apiOk({ approvedCount: new Set(input.itemIds).size })
  }

  return undefined
}

const isSourceVersionRoute = (path: string[], length: number): boolean =>
  path.length === length &&
  path[0] === 'api' &&
  path[1] === 'admin' &&
  path[2] === 'source-versions'

const isSourceVersionAction = (path: string[], action: string): boolean =>
  isSourceVersionRoute(path, 5) && path[4] === action

const isExerciseItemRoute = (path: string[]): boolean =>
  path.length === 4 &&
  path[0] === 'api' &&
  path[1] === 'admin' &&
  path[2] === 'exercise-items'

const isExerciseItemAction = (path: string[], action: string): boolean =>
  path.length === 5 && isExerciseItemRoute(path.slice(0, 4)) && path[4] === action

const requireSegment = (path: string[], index: number): string => {
  const segment = path[index]

  if (!segment) throw new DomainError('not_found', 'Route parameter is missing')

  return segment
}

const parseOptionalEmptyJson = async (request: Request): Promise<void> => {
  if (request.headers.has('content-type')) {
    await parseJsonRequest(request, emptyRequestSchema)
  }
}

const toImportWords = (
  words: Array<{
    word: string
    meaning: string
    examplePhrase: string
    exampleSentence: string
    exampleSentenceExtended: string
    partOfSpeech?: string | undefined
  }>,
): ImportWordInput[] =>
  words.map((word) => ({
    word: word.word,
    meaning: word.meaning,
    examplePhrase: word.examplePhrase,
    exampleSentence: word.exampleSentence,
    exampleSentenceExtended: word.exampleSentenceExtended,
    ...(word.partOfSpeech ? { partOfSpeech: word.partOfSpeech } : {}),
  }))
