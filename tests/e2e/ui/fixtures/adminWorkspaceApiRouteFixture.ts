import type { Page, Route } from '@playwright/test'

type VersionStatus = 'draft' | 'published'
type ExerciseStatus = 'draft' | 'approved' | 'disabled'

type FixtureExerciseItem = {
  id: string
  sourceVersionId: string
  wordId: string
  word: string
  status: ExerciseStatus
  stage: 'S1'
  taskType: 'recall_word'
  prompt: { meaning: string }
  answer: { word: string }
}

type FixtureCourse = {
  learner: { id: string; name: string }
  course: {
    id: string
    learnerId: string
    sourceVersionId: string
    currentLessonNo: number
    status: 'active'
  }
  credentialVersion: number
}

type FixtureOptions = {
  authenticated?: boolean
  withExistingCourse?: boolean
}

const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const createTemporaryAccessCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return [...bytes]
    .map((byte) => ACCESS_CODE_ALPHABET[byte % ACCESS_CODE_ALPHABET.length])
    .join('')
}

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export const installMockedAdminWorkspaceApiRouteFixture = async (
  page: Page,
  options: FixtureOptions = {},
) => {
  let authenticated = options.authenticated ?? true
  let versionStatus: VersionStatus = 'draft'
  let exerciseItem: FixtureExerciseItem = {
    id: 'item-1',
    sourceVersionId: 'version-1',
    wordId: 'word-1',
    word: 'apple',
    status: 'draft',
    stage: 'S1',
    taskType: 'recall_word',
    prompt: { meaning: '苹果' },
    answer: { word: 'apple' },
  }
  const importedVersions: Array<Record<string, unknown>> = []
  const courses: FixtureCourse[] = options.withExistingCourse
    ? [
        {
          learner: { id: 'learner-existing', name: '小明' },
          course: {
            id: 'course-existing',
            learnerId: 'learner-existing',
            sourceVersionId: 'version-published',
            currentLessonNo: 2,
            status: 'active',
          },
          credentialVersion: 1,
        },
      ]
    : []
  const apiCalls: string[] = []
  const requestBodies: Array<{ key: string; body: unknown }> = []
  const unhandledRequests: string[] = []

  const primarySummary = () => ({
    sourceId: 'source-1',
    sourceName: 'Starter words',
    versionId: 'version-1',
    versionNo: 1,
    status: versionStatus,
    wordCount: 1,
    groupCount: 1,
    exerciseItemCount: 1,
    approvedItemCount: exerciseItem.status === 'approved' ? 1 : 0,
    createdAt: '2026-07-13T00:00:00.000Z',
    ...(versionStatus === 'published'
      ? { publishedAt: '2026-07-14T00:00:00.000Z' }
      : {}),
  })

  const publishedSummary = {
    sourceId: 'source-published',
    sourceName: 'Published words',
    versionId: 'version-published',
    versionNo: 2,
    status: 'published' as const,
    wordCount: 20,
    groupCount: 4,
    exerciseItemCount: 120,
    approvedItemCount: 120,
    createdAt: '2026-07-12T00:00:00.000Z',
    publishedAt: '2026-07-13T00:00:00.000Z',
  }

  const missingItems = () =>
    exerciseItem.status === 'approved'
      ? []
      : [
          {
            word: 'apple',
            stage: 'S1',
            taskType: 'recall_word',
            reason:
              exerciseItem.status === 'disabled'
                ? 'exercise_item_disabled'
                : 'exercise_item_draft',
          },
        ]

  const detail = () => ({
    ...primarySummary(),
    readyToPublish: exerciseItem.status === 'approved',
    missingItems: missingItems(),
  })

  const coverage = () => ({
    sourceVersionId: 'version-1',
    wordCount: 1,
    readyToPublish: exerciseItem.status === 'approved',
    cells: [
      {
        wordId: 'word-1',
        word: 'apple',
        stage: 'S1',
        taskType: 'recall_word',
        status: exerciseItem.status,
        itemId: 'item-1',
        ...(exerciseItem.status === 'approved'
          ? {}
          : {
              reason:
                exerciseItem.status === 'disabled'
                  ? 'exercise_item_disabled'
                  : 'exercise_item_draft',
            }),
      },
    ],
    missingItems: missingItems(),
  })

  await page.route('**/api/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    apiCalls.push(key)

    if (key === 'GET /api/admin/session') {
      await fulfillJson(
        route,
        authenticated ? 200 : 401,
        authenticated
          ? {
              ok: true,
              data: {
                id: 'fixture-admin',
                source: 'application_session',
                displayName: 'Solazhu',
              },
            }
          : {
              ok: false,
              error: {
                code: 'admin_session_required',
                message: 'Admin session is required',
              },
            },
      )
      return
    }

    if (key === 'POST /api/admin/auth/login') {
      const body = request.postDataJSON() as { username?: unknown; password?: unknown }
      requestBodies.push({
        key,
        body: {
          username: body.username,
          passwordProvided: typeof body.password === 'string' && body.password.length > 0,
        },
      })
      authenticated = true
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          id: 'fixture-admin',
          source: 'application_session',
          displayName: 'Solazhu',
        },
      })
      return
    }

    if (key === 'POST /api/admin/auth/logout') {
      authenticated = false
      await fulfillJson(route, 200, {
        ok: true,
        data: { loggedOut: true },
      })
      return
    }

    if (key === 'GET /api/admin/source-versions') {
      await fulfillJson(route, 200, {
        ok: true,
        data: [primarySummary(), publishedSummary, ...importedVersions],
      })
      return
    }

    if (key === 'POST /api/admin/source-versions/import') {
      requestBodies.push({ key, body: request.postDataJSON() })
      importedVersions.push({
        sourceId: 'source-imported',
        sourceName: 'Keyboard import',
        versionId: 'version-imported',
        versionNo: 1,
        status: 'draft',
        wordCount: 1,
        groupCount: 1,
        exerciseItemCount: 0,
        approvedItemCount: 0,
        createdAt: '2026-07-14T01:00:00.000Z',
      })
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          sourceId: 'source-imported',
          versionId: 'version-imported',
          versionNo: 1,
          status: 'draft',
          wordCount: 1,
          groupCount: 1,
        },
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1') {
      await fulfillJson(route, 200, { ok: true, data: detail() })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/coverage') {
      await fulfillJson(route, 200, { ok: true, data: coverage() })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/exercises') {
      await fulfillJson(route, 200, { ok: true, data: [exerciseItem] })
      return
    }

    if (key === 'GET /api/admin/exercise-items/item-1') {
      await fulfillJson(route, 200, { ok: true, data: exerciseItem })
      return
    }

    if (key === 'PUT /api/admin/exercise-items/item-1') {
      const body = request.postDataJSON() as {
        content: Pick<FixtureExerciseItem, 'stage' | 'taskType' | 'prompt' | 'answer'>
      }
      requestBodies.push({ key, body })
      exerciseItem = { ...exerciseItem, ...body.content }
      await fulfillJson(route, 200, { ok: true, data: exerciseItem })
      return
    }

    if (key === 'POST /api/admin/exercise-items/item-1/approve') {
      exerciseItem = { ...exerciseItem, status: 'approved' }
      await fulfillJson(route, 200, {
        ok: true,
        data: { itemId: 'item-1', status: 'approved' },
      })
      return
    }

    if (key === 'POST /api/admin/source-versions/version-1/publish') {
      versionStatus = 'published'
      await fulfillJson(route, 200, {
        ok: true,
        data: { sourceVersionId: 'version-1', status: 'published' },
      })
      return
    }

    if (key === 'GET /api/admin/courses') {
      await fulfillJson(route, 200, { ok: true, data: { courses } })
      return
    }

    if (key === 'POST /api/admin/courses') {
      const body = request.postDataJSON() as {
        learnerName: string
        sourceVersionId: string
      }
      requestBodies.push({ key, body })
      const learnerId = 'learner-created'
      const course: FixtureCourse = {
        learner: { id: learnerId, name: body.learnerName },
        course: {
          id: 'course-created',
          learnerId,
          sourceVersionId: body.sourceVersionId,
          currentLessonNo: 1,
          status: 'active',
        },
        credentialVersion: 1,
      }
      courses.push(course)
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          learner: {
            ...course.learner,
            accessCode: createTemporaryAccessCode(),
          },
          course: course.course,
        },
      })
      return
    }

    unhandledRequests.push(key)
    await route.abort('failed')
  })

  return {
    apiCalls,
    requestBodies,
    unhandledRequests,
  }
}
