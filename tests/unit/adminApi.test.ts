import { describe, expect, it, vi } from 'vitest'
import { createAdminApi } from '@/api/adminApi'
import { subscribeAdminAuthorizationFailure } from '@/api/adminAuthorizationBoundary'
import { InvalidApiResponseError } from '@/api/errors'
import { createHttpClient, type FetchImplementation } from '@/api/httpClient'

const OPERATION_TOKEN = 'a'.repeat(64)

const sourceVersionSummary = {
  sourceId: 'source-1',
  sourceName: 'Starter words',
  versionId: 'version-1',
  versionNo: 1,
  status: 'draft',
  wordCount: 5,
  groupCount: 1,
  exerciseItemCount: 0,
  approvedItemCount: 0,
  createdAt: '2026-07-13T00:00:00.000Z',
} as const

const exerciseItem = {
  id: 'item-1',
  sourceVersionId: 'version-1',
  wordId: 'word-1',
  word: 'apple',
  status: 'draft',
  stage: 'S1',
  taskType: 'recall_word',
  prompt: { meaning: '苹果' },
  answer: { word: 'apple' },
} as const

describe('admin API client', () => {
  it('does not broadcast a session code carried by a non-authentication HTTP status', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAdminAuthorizationFailure(listener)
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: {
            code: 'admin_session_required',
            message: 'Session dependency unavailable',
          },
        },
        { status: 503 },
      ),
    )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.listSourceVersions()).rejects.toMatchObject({ status: 503 })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('never broadcasts login or logout failures through the mounted-workspace boundary', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAdminAuthorizationFailure(listener)
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: { code: 'admin_session_required', message: 'Session required' },
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: { code: 'admin_session_expired', message: 'Session expired' },
          },
          { status: 401 },
        ),
      )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.loginAdmin({ username: 'admin', password: 'fixture-password' }),
    ).rejects.toMatchObject({ status: 401 })
    await expect(api.logoutAdmin()).rejects.toMatchObject({ status: 401 })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('logs in and out through same-origin credential requests', async () => {
    const session = {
      id: 'credential-1',
      source: 'application_session',
      displayName: 'Solazhu',
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: session }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { loggedOut: true } }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.loginAdmin({ username: ' Admin ', password: '  exact password  ' }),
    ).resolves.toEqual(session)
    await expect(api.logoutAdmin()).resolves.toEqual({ loggedOut: true })

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/admin/auth/login', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        username: 'admin',
        password: '  exact password  ',
      }),
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/admin/auth/logout', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    })
  })

  it('restores the authenticated admin session through the admin namespace', async () => {
    const session = {
      id: 'admin-1',
      source: 'cloudflare_access',
      displayName: 'admin@example.test',
      email: 'admin@example.test',
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: session }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.getAdminSession()).resolves.toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/session', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('lists source versions through the admin namespace with runtime validation', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: [sourceVersionSummary] }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.listSourceVersions()).resolves.toEqual([sourceVersionSummary])
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/source-versions', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('gets one source-version detail without allowing an id to escape the admin path', async () => {
    const detail = {
      ...sourceVersionSummary,
      readyToPublish: false,
      missingItems: [],
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: detail }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.getSourceVersion('version/../app?x=1')).resolves.toEqual(detail)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/source-versions/version%2F..%2Fapp%3Fx%3D1',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'GET',
      },
    )
  })

  it('imports only the structured command produced from the local CSV', async () => {
    const command = {
      mode: 'new_source',
      operationToken: OPERATION_TOKEN,
      sourceName: 'Starter words',
      words: [
        {
          word: 'apple',
          meaning: '苹果',
          examplePhrase: 'An apple',
          exampleSentence: 'I eat an apple.',
          exampleSentenceExtended: 'I eat an apple every day.',
          partOfSpeech: 'noun',
        },
      ],
    } as const
    const imported = {
      sourceId: 'source-1',
      versionId: 'version-1',
      versionNo: 1,
      status: 'draft',
      wordCount: 1,
      groupCount: 1,
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: imported }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.importSourceVersion(command)).resolves.toEqual(imported)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/source-versions/import', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(command),
    })
  })

  it('builds a source version and validates the returned coverage matrix', async () => {
    const coverage = {
      sourceVersionId: 'version-1',
      wordCount: 1,
      readyToPublish: false,
      cells: [],
      missingItems: [],
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: coverage }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.buildSourceVersion('version-1')).resolves.toEqual(coverage)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/source-versions/version-1/build', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'POST',
    })
  })

  it('reads current coverage without triggering a rebuild', async () => {
    const coverage = {
      sourceVersionId: 'version-1',
      wordCount: 1,
      readyToPublish: true,
      cells: [],
      missingItems: [],
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: coverage }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.getCoverage('version-1')).resolves.toEqual(coverage)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/source-versions/version-1/coverage', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('lists admin-only exercise content through the source-version namespace', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: [exerciseItem] }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.listExerciseItems('version-1')).resolves.toEqual([exerciseItem])
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/source-versions/version-1/exercises', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
  })

  it('gets one exercise item without allowing its id to escape the admin path', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: exerciseItem }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.getExerciseItem('item/../app?x=1')).resolves.toEqual(exerciseItem)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/exercise-items/item%2F..%2Fapp%3Fx%3D1',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'GET',
      },
    )
  })

  it('reads a prompt-only review window with encoded version and item ids', async () => {
    const reviewWindow = {
      sourceVersionId: 'version-1',
      sourceName: 'Starter words',
      versionNo: 1,
      contentRevision: 7,
      totalCount: 1,
      approvedCount: 0,
      pendingCount: 1,
      needsReworkCount: 0,
      disabledCount: 0,
      allApproved: false,
      firstItemId: 'item-1',
      current: {
        id: 'item-1',
        wordId: 'word-1',
        word: 'apple',
        wordOrderIndex: 1,
        position: 1,
        stage: 'S1',
        taskType: 'recall_word',
        status: 'draft',
        reviewState: 'pending_review',
        prompt: { meaning: '苹果' },
      },
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: reviewWindow }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.getExerciseReviewWindow('version/1', 'item?1'),
    ).resolves.toEqual(reviewWindow)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/source-versions/version%2F1/review?itemId=item%3F1',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'GET',
      },
    )
  })

  it('uses strict admin-only review preview, evaluate, and decision writes', async () => {
    const preview = {
      exerciseItemId: 'item-1',
      referenceSentence: 'I eat an apple.',
      revealedAt: '2026-07-17T00:00:00.000Z',
    }
    const evaluation = {
      exerciseItemId: 'item-1',
      score: 2,
      correct: true,
      feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
    }
    const decision = {
      exerciseItemId: 'item-1',
      sourceVersionId: 'version-1',
      action: 'approve',
      status: 'approved',
      reviewState: 'approved',
      contentRevision: 8,
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: preview }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: evaluation }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: decision }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await api.previewExerciseReview('item-1', {
      expectedContentRevision: 7,
      taskType: 'sentence_output',
      draft: ' I eat an apple. ',
    })
    await api.evaluateExerciseReview('item-1', {
      expectedContentRevision: 7,
      submission: { taskType: 'recall_word', answer: ' apple ' },
    })
    await api.decideExerciseReview('item-1', {
      action: 'approve',
      expectedContentRevision: 7,
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/admin/exercise-items/item-1/review/preview', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        expectedContentRevision: 7,
        taskType: 'sentence_output',
        draft: 'I eat an apple.',
      }),
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/admin/exercise-items/item-1/review/evaluate', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        expectedContentRevision: 7,
        submission: { taskType: 'recall_word', answer: 'apple' },
      }),
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(3, '/api/admin/exercise-items/item-1/review/decision', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ action: 'approve', expectedContentRevision: 7 }),
    })
  })

  it('edits an exercise with the shared content contract and validates the result', async () => {
    const command = {
      content: {
        stage: 'S1',
        taskType: 'recall_word',
        prompt: { meaning: ' 水果 ' },
        answer: { word: ' apple ' },
      },
    } as const
    const edited = {
      ...exerciseItem,
      prompt: { meaning: '水果' },
      answer: { word: 'apple' },
    }
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: edited }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.editExerciseItem('item-1', command)).resolves.toEqual(edited)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/exercise-items/item-1', {
      credentials: 'same-origin',
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        content: {
          stage: 'S1',
          taskType: 'recall_word',
          prompt: { meaning: '水果' },
          answer: { word: 'apple' },
        },
      }),
    })
  })

  it('approves one exercise through its explicit admin action', async () => {
    const result = { itemId: 'item-1', status: 'approved' } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: result }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.approveExerciseItem('item/1')).resolves.toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/exercise-items/item%2F1/approve',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('disables one exercise through its explicit admin action', async () => {
    const result = { itemId: 'item-1', status: 'disabled' } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: result }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.disableExerciseItem('item-1')).resolves.toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/exercise-items/item-1/disable',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('batch approves a non-empty validated exercise selection', async () => {
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        Response.json({ ok: true, data: { approvedCount: 2 } }),
      )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.approveExerciseItems({ itemIds: [' item-1 ', 'item-2'] }),
    ).resolves.toEqual({ approvedCount: 2 })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/exercise-items/batch-approve',
      {
        credentials: 'same-origin',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({ itemIds: ['item-1', 'item-2'] }),
      },
    )
  })

  it('publishes a source version through the explicit admin action', async () => {
    const result = { sourceVersionId: 'version-1', status: 'published' } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: result }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.publishSourceVersion('version/1')).resolves.toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/source-versions/version%2F1/publish',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('discards only a draft source version through the explicit admin action', async () => {
    const result = {
      sourceVersionId: 'version-1',
      sourceId: 'source-1',
      status: 'archived',
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: result }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.discardSourceVersion('version-1')).resolves.toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/source-versions/version-1/discard',
      {
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
        method: 'POST',
      },
    )
  })

  it('creates a course and exposes the one-time learning code only in the response', async () => {
    const created = {
      learner: {
        id: 'learner-1',
        name: 'Alice',
        accessCode: 'ABCDEFGH23',
      },
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
        status: 'active',
      },
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: created }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.createCourse({
        operationToken: OPERATION_TOKEN,
        learnerName: ' Alice ',
        sourceVersionId: ' version-1 ',
      }),
    ).resolves.toEqual(created)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/courses', {
      credentials: 'same-origin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        operationToken: OPERATION_TOKEN,
        learnerName: 'Alice',
        sourceVersionId: 'version-1',
      }),
    })
  })

  it('lists courses without accepting a learning code in the persisted view', async () => {
    const listed = {
      courses: [
        {
          learner: { id: 'learner-1', name: 'Alice' },
          credentialVersion: 1,
          learningRunNo: 1,
          course: {
            id: 'course-1',
            learnerId: 'learner-1',
            sourceVersionId: 'version-1',
            currentLessonNo: 1,
            status: 'active',
          },
        },
      ],
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: listed }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.listCourses()).resolves.toEqual(listed)
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/courses', {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      method: 'GET',
    })
    expect(JSON.stringify(listed)).not.toContain('accessCode')
  })

  it('restarts a course through a CAS-protected admin command', async () => {
    const reset = {
      course: {
        id: 'course-1',
        learnerId: 'learner-1',
        sourceVersionId: 'version-1',
        currentLessonNo: 1,
        status: 'active',
      },
      learningRunNo: 2,
      abandonedSessionCount: 1,
      historyPreserved: true,
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: reset }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.resetCourseProgress('course/1', {
        operationToken: OPERATION_TOKEN,
        expectedLearningRunNo: 1,
        expectedCurrentLessonNo: 2,
      }),
    ).resolves.toEqual(reset)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/courses/course%2F1/learning-progress/reset',
      {
        credentials: 'same-origin',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          operationToken: OPERATION_TOKEN,
          expectedLearningRunNo: 1,
          expectedCurrentLessonNo: 2,
        }),
      },
    )
  })

  it('rotates a learner code by learner id and validates session revocation count', async () => {
    const rotated = {
      accessCode: 'BCDEFGHJ34',
      credentialVersion: 2,
      revokedSessionCount: 2,
    } as const
    const fetchImpl = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(Response.json({ ok: true, data: rotated }))
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.rotateAccessCode('learner/1', {
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 1,
      }),
    ).resolves.toEqual(rotated)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/learners/learner%2F1/access-code/rotate',
      {
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        method: 'POST',
        body: JSON.stringify({
          operationToken: OPERATION_TOKEN,
          expectedCredentialVersion: 1,
        }),
      },
    )
  })

  it('rejects invalid admin resource ids and commands before any network request', () => {
    const fetchImpl = vi.fn<FetchImplementation>()
    const api = createAdminApi(createHttpClient(fetchImpl))

    expect(() => api.getSourceVersion('   ')).toThrow()
    expect(() => api.getExerciseItem('   ')).toThrow()
    expect(() =>
      api.editExerciseItem('item-1', {
        content: {
          stage: 'S1',
          taskType: 'recall_word',
          prompt: { meaning: '   ' },
          answer: { word: 'apple' },
        },
      }),
    ).toThrow()
    expect(() => api.approveExerciseItems({ itemIds: [] })).toThrow()
    expect(() =>
      api.createCourse({
        operationToken: OPERATION_TOKEN,
        learnerName: '   ',
        sourceVersionId: 'version-1',
      }),
    ).toThrow()
    expect(() =>
      api.rotateAccessCode('   ', {
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 1,
      }),
    ).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a rotated learning code that drifts from the shared contract', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          accessCode: 'INVALID001',
          credentialVersion: 2,
          revokedSessionCount: 0,
        },
      }),
    )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(
      api.rotateAccessCode('learner-1', {
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidApiResponseError)
  })

  it('keeps every public admin operation inside the admin namespace', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            ok: false,
            error: { code: 'not_found', message: 'Controlled contract failure' },
          },
          { status: 404 },
        ),
      ),
    )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await Promise.allSettled([
      api.getAdminSession(),
      api.listSourceVersions(),
      api.getSourceVersion('version-1'),
      api.importSourceVersion({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: 'Starter words',
        words: [
          {
            word: 'apple',
            meaning: '苹果',
            examplePhrase: 'An apple',
            exampleSentence: 'I eat an apple.',
            exampleSentenceExtended: 'I eat an apple every day.',
          },
        ],
      }),
      api.buildSourceVersion('version-1'),
      api.getCoverage('version-1'),
      api.listExerciseItems('version-1'),
      api.getExerciseItem('item-1'),
      api.editExerciseItem('item-1', {
        content: {
          stage: 'S1',
          taskType: 'recall_word',
          prompt: { meaning: '苹果' },
          answer: { word: 'apple' },
        },
      }),
      api.approveExerciseItem('item-1'),
      api.disableExerciseItem('item-1'),
      api.approveExerciseItems({ itemIds: ['item-1'] }),
      api.publishSourceVersion('version-1'),
      api.discardSourceVersion('version-1'),
      api.createCourse({
        operationToken: OPERATION_TOKEN,
        learnerName: 'Alice',
        sourceVersionId: 'version-1',
      }),
      api.listCourses(),
      api.rotateAccessCode('learner-1', {
        operationToken: OPERATION_TOKEN,
        expectedCredentialVersion: 1,
      }),
      api.resetCourseProgress('course-1', {
        operationToken: OPERATION_TOKEN,
        expectedLearningRunNo: 1,
        expectedCurrentLessonNo: 1,
      }),
    ])

    const paths = fetchImpl.mock.calls.map(([path]) => requestPath(path))
    expect(paths).toHaveLength(18)
    expect(paths.every((path) => path.startsWith('/api/admin/'))).toBe(true)
    expect(paths.some((path) => path.startsWith('/api/app/'))).toBe(false)
  })

  it('rejects an invalid import command before any network request', () => {
    const fetchImpl = vi.fn<FetchImplementation>()
    const api = createAdminApi(createHttpClient(fetchImpl))

    expect(() =>
      api.importSourceVersion({
        mode: 'new_source',
        operationToken: OPERATION_TOKEN,
        sourceName: '   ',
        words: [],
      }),
    ).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects admin response data that drifts from the shared runtime schema', async () => {
    const fetchImpl = vi.fn<FetchImplementation>().mockResolvedValue(
      Response.json({
        ok: true,
        data: [{ ...sourceVersionSummary, wordCount: '5' }],
      }),
    )
    const api = createAdminApi(createHttpClient(fetchImpl))

    await expect(api.listSourceVersions()).rejects.toBeInstanceOf(InvalidApiResponseError)
  })
})

const requestPath = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
