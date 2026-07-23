import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const reviewFile = path.join(
  process.cwd(),
  'pdoc/design/DESIGN_0714_管理员登录与高效内容工作台视觉审阅稿_v1.html',
)
const outputDir = path.join(
  process.cwd(),
  'pdoc/design/qa/PLAN_0714_管理员认证与高效内容工作台',
)

const version = {
  sourceId: 'source-primary',
  sourceName: '小学英语三年级上册',
  versionId: 'version-3',
  versionNo: 3,
  status: 'draft',
  wordCount: 20,
  groupCount: 4,
  exerciseItemCount: 118,
  approvedItemCount: 110,
  createdAt: '2026-07-14T02:00:00.000Z',
  readyToPublish: false,
  missingItems: [
    {
      word: 'book',
      stage: 'S4',
      taskType: 'sentence_build',
      reason: 'exercise_item_required',
    },
    {
      word: 'school',
      stage: 'S4',
      taskType: 'sentence_build',
      reason: 'exercise_item_required',
    },
  ],
} as const

const publishedVersion = {
  ...version,
  versionId: 'version-2',
  versionNo: 2,
  status: 'published',
  exerciseItemCount: 120,
  approvedItemCount: 120,
  readyToPublish: true,
  missingItems: [],
  createdAt: '2026-07-12T02:00:00.000Z',
  publishedAt: '2026-07-13T02:00:00.000Z',
} as const

const readyVersion = {
  ...version,
  exerciseItemCount: 120,
  approvedItemCount: 120,
  readyToPublish: true,
  missingItems: [],
} as const

const publishedCurrentVersion = {
  ...readyVersion,
  status: 'published',
  publishedAt: '2026-07-14T03:00:00.000Z',
} as const

const archivedSourceVersion = {
  sourceId: 'source-archived',
  sourceName: '核心词汇试验集',
  versionId: 'version-archived-1',
  versionNo: 1,
  status: 'archived',
  wordCount: 12,
  groupCount: 3,
  exerciseItemCount: 72,
  approvedItemCount: 0,
  createdAt: '2026-07-10T11:20:00.000Z',
  readyToPublish: false,
  missingItems: [],
} as const

const corePublishedVersion = {
  sourceId: 'source-core',
  sourceName: '核心词汇',
  versionId: 'version-core-1',
  versionNo: 1,
  status: 'published',
  wordCount: 12,
  groupCount: 3,
  exerciseItemCount: 72,
  approvedItemCount: 72,
  createdAt: '2026-07-10T02:00:00.000Z',
  publishedAt: '2026-07-11T02:00:00.000Z',
} as const

const exerciseItem = {
  id: 'item-book-s4',
  sourceVersionId: version.versionId,
  wordId: 'word-book',
  word: 'book',
  status: 'draft',
  stage: 'S4',
  taskType: 'sentence_build',
  prompt: {
    pieces: [
      { id: 'p1', text: 'book.' },
      { id: 'p2', text: 'This' },
      { id: 'p3', text: 'my' },
      { id: 'p4', text: 'is' },
    ],
  },
  answer: {
    pieceIds: ['p2', 'p4', 'p3', 'p1'],
    referenceSentence: 'This is my book.',
  },
} as const

const draftExerciseItems = [
  'apple',
  'school',
  'teacher',
  'pencil',
  'ruler',
  'desk',
  'chair',
  'classroom',
].map((word, index) => ({
  ...exerciseItem,
  id: `item-review-${String(index + 1)}`,
  wordId: `word-review-${String(index + 1)}`,
  word,
}))

const courseEntries = [
  {
    learner: { id: 'learner-1', name: '小明', loginAccount: 'xiaoming' },
    course: {
      id: 'course-1',
      learnerId: 'learner-1',
      sourceVersionId: publishedVersion.versionId,
      currentLessonNo: 8,
      status: 'active',
    },
    credentialVersion: 1,
    learningRunNo: 1,
  },
  {
    learner: { id: 'learner-2', name: '小雨', loginAccount: 'xiaoyu' },
    course: {
      id: 'course-2',
      learnerId: 'learner-2',
      sourceVersionId: publishedVersion.versionId,
      currentLessonNo: 5,
      status: 'paused',
    },
    credentialVersion: 1,
    learningRunNo: 1,
  },
  {
    learner: { id: 'learner-3', name: '小杰', loginAccount: 'xiaojie' },
    course: {
      id: 'course-3',
      learnerId: 'learner-3',
      sourceVersionId: corePublishedVersion.versionId,
      currentLessonNo: 12,
      status: 'completed',
    },
    credentialVersion: 1,
    learningRunNo: 1,
  },
] as const

const coverageCells = ['apple', 'book', 'school', 'teacher'].flatMap((word, wordIndex) =>
  ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map((stage, stageIndex) => {
    const isMissingGap = (word === 'book' || word === 'school') && stage === 'S4'
    const isDraftGap = (word === 'book' || word === 'school') && stage === 'S3'
    return {
      wordId: `word-${String(wordIndex + 1)}`,
      word,
      stage,
      taskType: [
        'recognize_meaning',
        'recall_word',
        'multiple_choice',
        'fill_blank',
        'sentence_build',
        'sentence_output',
      ][stageIndex],
      status: isMissingGap ? 'missing' : isDraftGap ? 'draft' : 'approved',
      ...(!isMissingGap ? { itemId: `item-${word}-${stage}` } : {}),
      ...(isMissingGap
        ? { reason: 'exercise_item_required' }
        : isDraftGap
          ? { reason: 'exercise_item_draft' }
          : {}),
    }
  }),
)

const readyCoverageCells = coverageCells.map((cell) => ({
  ...cell,
  status: 'approved' as const,
}))

const approvedExerciseItems = draftExerciseItems.map((item) => ({
  ...item,
  status: 'approved' as const,
}))

const draftReviewWindow = {
  sourceVersionId: version.versionId,
  sourceName: version.sourceName,
  versionNo: version.versionNo,
  contentRevision: 0,
  totalCount: draftExerciseItems.length,
  approvedCount: 0,
  pendingCount: draftExerciseItems.length,
  needsReworkCount: 0,
  disabledCount: 0,
  allApproved: false,
  firstItemId: draftExerciseItems[0]?.id,
  current: draftExerciseItems[0]
    ? {
        id: draftExerciseItems[0].id,
        wordId: draftExerciseItems[0].wordId,
        word: draftExerciseItems[0].word,
        wordOrderIndex: 1,
        position: 1,
        stage: draftExerciseItems[0].stage,
        taskType: draftExerciseItems[0].taskType,
        status: 'draft' as const,
        reviewState: 'pending_review' as const,
        prompt: draftExerciseItems[0].prompt,
      }
    : undefined,
}

const approvedReviewWindow = {
  ...draftReviewWindow,
  approvedCount: draftExerciseItems.length,
  pendingCount: 0,
  allApproved: true,
  current: undefined,
}

const emptyReviewWindow = {
  ...draftReviewWindow,
  totalCount: 0,
  pendingCount: 0,
  allApproved: false,
  firstItemId: undefined,
  current: undefined,
}

const installAdminFixture = async (page: Page): Promise<void> => {
  await page.route('**/api/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    const fulfill = async (data: unknown): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data }),
      })
    }

    if (key === 'GET /api/admin/session') {
      if (new URL(page.url()).pathname === '/admin/login') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            error: {
              code: 'admin_session_required',
              message: 'Admin session is required',
            },
          }),
        })
        return
      }
      await fulfill({
        id: 'visual-admin',
        source: 'application_session',
        displayName: 'Solazhu',
      })
      return
    }
    if (key === 'GET /api/admin/source-versions') {
      const summaries = new URL(page.url()).pathname === '/admin/courses'
        ? [publishedVersion, corePublishedVersion]
        : [
            {
              ...version,
              exerciseItemCount: 120,
              approvedItemCount: 112,
              createdAt: '2026-07-14T09:32:00.000Z',
            },
            {
              ...publishedVersion,
              createdAt: '2026-07-12T16:08:00.000Z',
            },
            archivedSourceVersion,
          ]
      await fulfill(summaries.map(({ readyToPublish, missingItems, ...summary }) => {
        void readyToPublish
        void missingItems
        return summary
      }))
      return
    }
    if (key === `GET /api/admin/source-versions/${version.versionId}`) {
      await fulfill(version)
      return
    }
    if (key === `GET /api/admin/source-versions/${version.versionId}/coverage`) {
      await fulfill({
        sourceVersionId: version.versionId,
        wordCount: version.wordCount,
        readyToPublish: false,
        cells: coverageCells,
        missingItems: version.missingItems,
      })
      return
    }
    if (key === `GET /api/admin/source-versions/${version.versionId}/exercises`) {
      await fulfill(draftExerciseItems)
      return
    }
    if (key === `GET /api/admin/source-versions/${version.versionId}/review`) {
      await fulfill(draftReviewWindow)
      return
    }
    if (key === `GET /api/admin/exercise-items/${exerciseItem.id}`) {
      await fulfill(exerciseItem)
      return
    }
    if (key === 'GET /api/admin/courses') {
      await fulfill({ courses: courseEntries })
      return
    }
    if (key === 'POST /api/admin/courses') {
      await fulfill({
        learner: {
          id: 'learner-created',
          name: '小明',
          loginAccount: 'xiaoming-new',
        },
        course: {
          id: 'course-created',
          learnerId: 'learner-created',
          sourceVersionId: publishedVersion.versionId,
          currentLessonNo: 1,
          status: 'active',
        },
      })
      return
    }

    await route.abort('failed')
  })
}

type VisualScenario =
  | 'login-default'
  | 'login-checking'
  | 'login-submitting'
  | 'login-invalid-credentials'
  | 'login-cooldown'
  | 'login-uninitialized'
  | 'login-network-error'
  | 'login-service-error'
  | 'login-expired'
  | 'login-logged-out'
  | 'source-empty'
  | 'source-existing'
  | 'source-import-expanded'
  | 'source-preview-success'
  | 'source-field-error'
  | 'source-result-confirming'
  | 'version-unbuilt'
  | 'version-blocked'
  | 'version-ready'
  | 'version-publish-confirmation'
  | 'version-gap-filter-empty'
  | 'version-published-readonly'
  | 'exercise-editing'
  | 'exercise-field-error'
  | 'exercise-dirty-leave-confirmation'
  | 'exercise-conflict-reloaded'
  | 'exercise-approved'
  | 'exercise-disabled'
  | 'exercise-published-readonly'
  | 'course-no-published-version'
  | 'course-create-expanded'
  | 'course-create-success'
  | 'course-login-editor'
  | 'course-reset-confirmation'

const installStateMatrixFixture = async (
  page: Page,
  scenario: VisualScenario,
): Promise<{ releasePending: () => void }> => {
  await installAdminFixture(page)

  let releasePending = (): void => undefined
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve
  })
  let conflictReloaded = false

  await page.route('**/api/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    const fulfill = async (data: unknown): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data }),
      })
    }
    const fail = async (
      status: number,
      error: Record<string, unknown>,
    ): Promise<void> => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error }),
      })
    }

    if (
      scenario === 'login-checking' &&
      key === 'GET /api/admin/session'
    ) {
      await pending
      await route.abort('failed')
      return
    }

    if (
      scenario === 'login-submitting' &&
      key === 'POST /api/admin/auth/login'
    ) {
      await pending
      await route.abort('failed')
      return
    }

    if (key === 'POST /api/admin/auth/login') {
      if (scenario === 'login-invalid-credentials') {
        await fail(401, {
          code: 'invalid_admin_credentials',
          message: 'Invalid credentials',
        })
        return
      }
      if (scenario === 'login-cooldown') {
        await fail(429, {
          code: 'admin_login_rate_limited',
          message: 'Rate limited',
          details: { retryAfterSeconds: 900 },
        })
        return
      }
      if (scenario === 'login-uninitialized') {
        await fail(503, {
          code: 'admin_not_configured',
          message: 'Admin is not configured',
        })
        return
      }
      if (scenario === 'login-network-error') {
        await route.abort('connectionfailed')
        return
      }
      if (scenario === 'login-service-error') {
        await fail(503, {
          code: 'dependency_failure',
          message: 'Login dependency unavailable',
        })
        return
      }
    }

    if (key === 'GET /api/admin/source-versions') {
      if (scenario === 'source-empty') {
        await fulfill([])
        return
      }
      if (scenario === 'course-no-published-version') {
        await fulfill([
          {
            sourceId: version.sourceId,
            sourceName: version.sourceName,
            versionId: version.versionId,
            versionNo: version.versionNo,
            status: version.status,
            wordCount: version.wordCount,
            groupCount: version.groupCount,
            exerciseItemCount: version.exerciseItemCount,
            approvedItemCount: version.approvedItemCount,
            createdAt: version.createdAt,
          },
        ])
        return
      }
    }

    if (
      scenario === 'source-result-confirming' &&
      key === 'POST /api/admin/source-versions/import'
    ) {
      await fail(503, {
        code: 'import_reconcile_required',
        message: 'Import outcome requires reconciliation',
      })
      return
    }

    if (key === `GET /api/admin/source-versions/${version.versionId}`) {
      if (scenario === 'version-unbuilt') {
        await fulfill({
          ...version,
          exerciseItemCount: 0,
          approvedItemCount: 0,
        })
        return
      }
      if (
        scenario === 'version-ready' ||
        scenario === 'version-publish-confirmation' ||
        scenario === 'version-gap-filter-empty'
      ) {
        await fulfill(readyVersion)
        return
      }
      if (
        scenario === 'version-published-readonly' ||
        scenario === 'exercise-published-readonly'
      ) {
        await fulfill(publishedCurrentVersion)
        return
      }
    }

    if (key === `GET /api/admin/source-versions/${version.versionId}/coverage`) {
      if (scenario === 'version-unbuilt') {
        await fulfill({
          sourceVersionId: version.versionId,
          wordCount: version.wordCount,
          readyToPublish: false,
          cells: [],
          missingItems: version.missingItems,
        })
        return
      }
      if (
        scenario === 'version-ready' ||
        scenario === 'version-publish-confirmation' ||
        scenario === 'version-gap-filter-empty' ||
        scenario === 'version-published-readonly'
      ) {
        await fulfill({
          sourceVersionId: version.versionId,
          wordCount: version.wordCount,
          readyToPublish: true,
          cells: readyCoverageCells,
          missingItems: [],
        })
        return
      }
    }

    if (key === `GET /api/admin/source-versions/${version.versionId}/exercises`) {
      if (
        scenario === 'version-ready' ||
        scenario === 'version-publish-confirmation' ||
        scenario === 'version-gap-filter-empty' ||
        scenario === 'version-published-readonly'
      ) {
        await fulfill(approvedExerciseItems)
        return
      }
    }

    if (key === `GET /api/admin/source-versions/${version.versionId}/review`) {
      if (scenario === 'version-unbuilt') {
        await fulfill(emptyReviewWindow)
        return
      }
      if (
        scenario === 'version-ready' ||
        scenario === 'version-publish-confirmation' ||
        scenario === 'version-gap-filter-empty'
      ) {
        await fulfill(approvedReviewWindow)
        return
      }
      await fulfill(draftReviewWindow)
      return
    }

    if (key === `GET /api/admin/exercise-items/${exerciseItem.id}`) {
      if (scenario === 'exercise-approved') {
        await fulfill({ ...exerciseItem, status: 'draft' })
        return
      }
      if (scenario === 'exercise-disabled') {
        await fulfill({ ...exerciseItem, status: 'draft' })
        return
      }
      if (scenario === 'exercise-published-readonly') {
        await fulfill({ ...exerciseItem, status: 'approved' })
        return
      }
      if (scenario === 'exercise-conflict-reloaded' && conflictReloaded) {
        await fulfill({
          ...exerciseItem,
          prompt: {
            ...exerciseItem.prompt,
            pieces: exerciseItem.prompt.pieces.map((piece) =>
              piece.id === 'p1' ? { ...piece, text: 'book!' } : piece,
            ),
          },
          answer: {
            ...exerciseItem.answer,
            referenceSentence: 'This is my book!',
          },
        })
        return
      }
    }

    if (
      scenario === 'exercise-conflict-reloaded' &&
      key === `PUT /api/admin/exercise-items/${exerciseItem.id}`
    ) {
      conflictReloaded = true
      await fail(409, {
        code: 'conflict',
        message: 'Another editor updated this item',
      })
      return
    }

    if (
      scenario === 'exercise-approved' &&
      key === `POST /api/admin/exercise-items/${exerciseItem.id}/approve`
    ) {
      await fulfill({ itemId: exerciseItem.id, status: 'approved' })
      return
    }

    if (
      scenario === 'exercise-disabled' &&
      key === `POST /api/admin/exercise-items/${exerciseItem.id}/disable`
    ) {
      await fulfill({ itemId: exerciseItem.id, status: 'disabled' })
      return
    }

    if (scenario === 'course-no-published-version' && key === 'GET /api/admin/courses') {
      await fulfill({ courses: [] })
      return
    }

    await route.fallback()
  })

  return { releasePending }
}

const captureReference = async (
  page: Page,
  input: {
    name: string
    selector: string
    viewport: { width: number; height: number }
    dialogSelector?: string
  },
): Promise<string> => {
  await page.setViewportSize(input.viewport)
  await page.goto(pathToFileURL(reviewFile).href, { waitUntil: 'domcontentloaded' })
  await page.locator(input.selector).waitFor()
  await page.evaluate(
    async ({ selector, dialogSelector }) => {
      const source = document.querySelector<HTMLElement>(selector)
      if (!source) {
        throw new Error(`Reference selector missing: ${selector}`)
      }

      const clone = source.cloneNode(true) as HTMLElement
      const dialog = dialogSelector
        ? document.querySelector<HTMLDialogElement>(dialogSelector)?.cloneNode(true)
        : undefined
      if (dialogSelector && !dialog) {
        throw new Error(`Reference dialog missing: ${dialogSelector}`)
      }
      document.body.replaceChildren()
      document.body.style.margin = '0'
      document.body.style.minHeight = '100vh'
      document.body.style.background = 'var(--color-canvas)'

      const root = document.createElement('main')
      root.style.display = 'grid'
      root.style.minHeight = '100vh'
      root.style.placeItems = 'center'
      root.style.padding = selector.includes('login-card') ? '16px' : '0'
      root.style.overflow = 'hidden'

      if (clone.classList.contains('admin-shell')) {
        clone.style.width = '100vw'
        clone.style.minHeight = '100vh'
        clone.style.margin = '0'
        clone.style.border = '0'
        clone.style.borderRadius = '0'
        clone.style.boxShadow = 'none'
      } else {
        clone.style.width = 'min(420px, 100%)'
      }

      root.append(clone)
      document.body.append(root)

      if (dialog) {
        const dialogElement = dialog as HTMLDialogElement
        document.body.append(dialogElement)
        dialogElement.showModal()
      }

      await document.fonts.ready
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
    },
    { selector: input.selector, dialogSelector: input.dialogSelector },
  )
  const target = path.join(outputDir, `${input.name}-reference.png`)
  await page.screenshot({ path: target })
  return target
}

const captureProduction = async (
  page: Page,
  input: {
    name: string
    route: string
    viewport: { width: number; height: number }
    ready: () => ReturnType<Page['locator']>
    prepare?: () => Promise<void>
  },
): Promise<{ path: string; consoleErrors: string[]; pageErrors: string[] } & Record<string, unknown>> => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const handleConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  }
  const handlePageError = (error: Error): void => {
    pageErrors.push(error.message)
  }
  page.on('console', handleConsole)
  page.on('pageerror', handlePageError)

  try {
    await page.setViewportSize(input.viewport)
    await page.goto(input.route)
    await expect(input.ready()).toBeVisible()
    await input.prepare?.()
    await page.evaluate(async () => {
      await document.fonts.ready
      window.scrollTo(0, 0)
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        resolve()
      }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        resolve()
      }))
    })

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      allowedRegions: Array.from(
        document.querySelectorAll<HTMLElement>('.table-scroll, .matrix-scroll'),
      ).map((element) => ({
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      })),
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
    if (input.route === '/admin/login') {
      expect(consoleErrors.length).toBeGreaterThanOrEqual(1)
      expect(
        consoleErrors.every(
          (message) =>
            message ===
            'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
        ),
      ).toBe(true)
    } else {
      expect(consoleErrors).toEqual([])
    }
    expect(pageErrors).toEqual([])

    const target = path.join(outputDir, `${input.name}-production.png`)
    await page.screenshot({ path: target })
    return {
      path: target,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      ...overflow,
    }
  } finally {
    page.off('console', handleConsole)
    page.off('pageerror', handlePageError)
  }
}

const captureComparison = async (
  page: Page,
  input: {
    name: string
    viewport: { width: number; height: number }
    referencePath: string
    productionPath: string
  },
): Promise<string> => {
  const [reference, production] = await Promise.all([
    readFile(input.referencePath),
    readFile(input.productionPath),
  ])
  await page.setViewportSize({
    width: input.viewport.width * 2,
    height: input.viewport.height + 40,
  })
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #23343a; color: white; font: 600 14px system-ui; }
          main { display: grid; grid-template-columns: repeat(2, ${String(input.viewport.width)}px); width: ${String(input.viewport.width * 2)}px; }
          figure { width: ${String(input.viewport.width)}px; margin: 0; min-width: 0; }
          figcaption { height: 40px; padding: 10px 16px; background: #23343a; }
          img { display: block; width: 100%; height: ${String(input.viewport.height)}px; object-fit: cover; object-position: top; }
        </style>
      </head>
      <body>
        <main>
          <figure><figcaption>视觉审阅稿</figcaption><img alt="视觉审阅稿" src="data:image/png;base64,${reference.toString('base64')}"></figure>
          <figure><figcaption>生产实现</figcaption><img alt="生产实现" src="data:image/png;base64,${production.toString('base64')}"></figure>
        </main>
      </body>
    </html>
  `)
  await expect(page.locator('img')).toHaveCount(2)
  await page.locator('img').evaluateAll(async (images) => {
    await Promise.all(
      images.map(
        (image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener('load', () => {
                  resolve()
                }, { once: true })
              }),
      ),
    )
  })
  const target = path.join(outputDir, `${input.name}-comparison.png`)
  await page.screenshot({ path: target })
  return target
}

type VisualStateCase = {
  page: 'login' | 'sources' | 'version' | 'exercise' | 'courses'
  state: string
  slug: string
  scenario: VisualScenario
  route: string
  viewport: { width: number; height: number }
  ready: (page: Page) => ReturnType<Page['locator']>
  prepare?: (page: Page) => Promise<void>
  visualTarget?: (page: Page) => ReturnType<Page['locator']>
  evidence?: string
}

type VisualStateMetric = {
  page: VisualStateCase['page']
  state: string
  slug: string
  path: string
  viewport: { width: number; height: number }
  consoleErrors: string[]
  pageErrors: string[]
  clientWidth: number
  scrollWidth: number
  allowedRegions: Array<{
    className: string
    clientWidth: number
    scrollWidth: number
    overflowX: string
  }>
  evidence?: string
}

const loginRoute = '/admin/login'
const sourceRoute = '/admin/source-versions'
const versionRoute = `/admin/source-versions/${version.versionId}`
const exerciseRoute = `${versionRoute}/exercises/${exerciseItem.id}`
const courseRoute = '/admin/courses'
const loginViewport = { width: 375, height: 812 }
const workspaceViewport = { width: 1280, height: 800 }
const versionViewport = { width: 1280, height: 900 }
const ephemeralVisualPassword = `visual-input-${crypto.randomUUID()}`
const validCsv = [
  'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
  'apple,苹果,An apple,I eat an apple,I eat an apple every day,noun',
  'book,书,A book,This is my book,This is my favorite book to read,noun',
].join('\n')
const invalidCsv = [
  'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech',
  ',苹果,An apple,I eat an apple,I eat an apple every day,noun',
].join('\n')

const fillLoginFormAndSubmit = async (page: Page): Promise<void> => {
  await page.getByLabel('管理员账号').fill('visual-admin')
  await page.getByLabel('密码').fill(ephemeralVisualPassword)
  await page.getByRole('button', { name: '登录管理台' }).click()
}

const openSourceImport = async (page: Page): Promise<void> => {
  if (!(await page.locator('[data-import-workspace]').isVisible())) {
    await page.getByRole('button', { name: '导入词表' }).click()
  }
  await expect(page.locator('[data-import-workspace]')).toBeVisible()
}

const setSourceCsv = async (page: Page, contents: string): Promise<void> => {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'visual-state.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(contents),
  })
}

const createCourseWithAccount = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '创建课程' }).click()
  await page.getByLabel('学习者姓名').fill('小明')
  await page.getByLabel('学习账号').fill('xiaoming-new')
  await page.getByLabel('6 位 PIN').fill('123456')
  await page.getByRole('button', { name: '创建课程', exact: true }).click()
  await expect(page.locator('[data-action-success]')).toContainText('xiaoming-new')
}

const stateCases: VisualStateCase[] = [
  {
    page: 'login',
    state: '默认',
    slug: 'login-default',
    scenario: 'login-default',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
  },
  {
    page: 'login',
    state: '检查',
    slug: 'login-checking',
    scenario: 'login-checking',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByText('正在检查管理员会话…'),
  },
  {
    page: 'login',
    state: '提交',
    slug: 'login-submitting',
    scenario: 'login-submitting',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByRole('button', { name: '正在登录…' })).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '凭证错误',
    slug: 'login-invalid-credentials',
    scenario: 'login-invalid-credentials',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByText('账号或密码不正确')).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '冷却',
    slug: 'login-cooldown',
    scenario: 'login-cooldown',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByText(/尝试次数过多/)).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '未初始化',
    slug: 'login-uninitialized',
    scenario: 'login-uninitialized',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByText(/管理员登录尚未配置/)).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '网络失败',
    slug: 'login-network-error',
    scenario: 'login-network-error',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByText(/无法连接服务器/)).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '服务异常',
    slug: 'login-service-error',
    scenario: 'login-service-error',
    route: loginRoute,
    viewport: loginViewport,
    ready: (page) => page.getByRole('button', { name: '登录管理台' }),
    prepare: async (page) => {
      await fillLoginFormAndSubmit(page)
      await expect(page.getByText(/登录服务暂不可用/)).toBeVisible()
    },
  },
  {
    page: 'login',
    state: '会话过期',
    slug: 'login-expired',
    scenario: 'login-expired',
    route: `${loginRoute}?reason=expired`,
    viewport: loginViewport,
    ready: (page) => page.getByText('登录已过期，请重新登录'),
  },
  {
    page: 'login',
    state: '已退出',
    slug: 'login-logged-out',
    scenario: 'login-logged-out',
    route: `${loginRoute}?reason=logged_out`,
    viewport: loginViewport,
    ready: (page) => page.getByText('已安全退出'),
  },
  {
    page: 'sources',
    state: '空状态',
    slug: 'sources-empty',
    scenario: 'source-empty',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.getByText('还没有词库版本'),
  },
  {
    page: 'sources',
    state: '已有版本',
    slug: 'sources-existing',
    scenario: 'source-existing',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-version-table]'),
  },
  {
    page: 'sources',
    state: '导入展开',
    slug: 'sources-import-expanded',
    scenario: 'source-import-expanded',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-version-table]'),
    prepare: openSourceImport,
  },
  {
    page: 'sources',
    state: 'CSV 预览成功',
    slug: 'sources-preview-success',
    scenario: 'source-preview-success',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-version-table]'),
    prepare: async (page) => {
      await openSourceImport(page)
      await page.getByLabel('词库名称').fill('小学英语三年级上册')
      await setSourceCsv(page, validCsv)
      await expect(page.locator('[data-csv-preview]')).toBeVisible()
    },
    visualTarget: (page) => page.locator('[data-csv-preview]'),
  },
  {
    page: 'sources',
    state: '字段错误',
    slug: 'sources-field-error',
    scenario: 'source-field-error',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-version-table]'),
    prepare: async (page) => {
      await openSourceImport(page)
      await setSourceCsv(page, invalidCsv)
      await expect(page.getByText('CSV 预览未通过')).toBeVisible()
    },
    visualTarget: (page) => page.getByText('CSV 预览未通过'),
  },
  {
    page: 'sources',
    state: '自动确认中',
    slug: 'sources-result-confirming',
    scenario: 'source-result-confirming',
    route: sourceRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-version-table]'),
    prepare: async (page) => {
      await openSourceImport(page)
      await page.getByLabel('词库名称').fill('小学英语三年级上册')
      await setSourceCsv(page, validCsv)
      await page.getByRole('button', { name: '导入并创建草稿' }).click()
      await expect(page.locator('[data-import-confirming]')).toBeVisible()
    },
    visualTarget: (page) => page.locator('[data-import-confirming]'),
  },
  {
    page: 'version',
    state: '未构建',
    slug: 'version-unbuilt',
    scenario: 'version-unbuilt',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.getByRole('heading', { level: 1, name: '版本 v3' }),
  },
  {
    page: 'version',
    state: '存在阻断',
    slug: 'version-blocked',
    scenario: 'version-blocked',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.locator('[data-blockers]'),
  },
  {
    page: 'version',
    state: '可发布',
    slug: 'version-ready',
    scenario: 'version-ready',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.getByText('服务端已确认覆盖完备，可进入发布确认。'),
  },
  {
    page: 'version',
    state: '发布确认',
    slug: 'version-publish-confirmation',
    scenario: 'version-publish-confirmation',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.locator('[data-publish]'),
    prepare: async (page) => {
      await page.locator('[data-publish]').click()
      await expect(page.locator('[data-inline-confirmation]')).toBeVisible()
    },
  },
  {
    page: 'version',
    state: '缺口筛选无结果',
    slug: 'version-gap-filter-empty',
    scenario: 'version-gap-filter-empty',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.locator('[data-gap-filter]'),
    prepare: async (page) => {
      await page.locator('[data-gap-filter]').check()
      await expect(page.locator('[data-gap-empty]')).toBeVisible()
    },
  },
  {
    page: 'version',
    state: '已发布只读',
    slug: 'version-published-readonly',
    scenario: 'version-published-readonly',
    route: versionRoute,
    viewport: versionViewport,
    ready: (page) => page.getByText('已发布，只读', { exact: true }),
  },
  {
    page: 'exercise',
    state: '编辑',
    slug: 'exercise-editing',
    scenario: 'exercise-editing',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-exercise-workbench]'),
  },
  {
    page: 'exercise',
    state: '字段错误',
    slug: 'exercise-field-error',
    scenario: 'exercise-field-error',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-exercise-workbench]'),
    prepare: async (page) => {
      await page.locator('textarea[name="pieces"]').fill('p2|This\np4|is\np3|my')
      await page.getByRole('button', { name: '保存练习内容' }).click()
      await expect(page.locator('[data-form-error-summary]')).toBeVisible()
    },
  },
  {
    page: 'exercise',
    state: 'dirty 离开确认',
    slug: 'exercise-dirty-leave-confirmation',
    scenario: 'exercise-dirty-leave-confirmation',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-exercise-workbench]'),
    prepare: async (page) => {
      await page.locator('textarea[name="reference-sentence"]').fill('This is my book!')
      await expect(page.locator('[data-review-dirty-hint]')).toBeVisible()
      const dialogMessage = new Promise<string>((resolve) => {
        page.once('dialog', (dialog) => {
          resolve(dialog.message())
          void dialog.dismiss()
        })
      })
      await page.getByRole('link', { name: '返回版本 v3' }).click()
      await expect(dialogMessage).resolves.toBe('当前练习有未保存修改，确定离开吗？')
      await expect(page.locator('[data-review-dirty-hint]')).toBeVisible()
    },
    evidence: 'PNG 显示 dirty 提示；原生离开确认由真实 dialog 消息断言覆盖，不进入页面截图。',
  },
  {
    page: 'exercise',
    state: '并发冲突重读',
    slug: 'exercise-conflict-reloaded',
    scenario: 'exercise-conflict-reloaded',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-exercise-workbench]'),
    prepare: async (page) => {
      await page.locator('textarea[name="pieces"]').fill(
        'p1|book!\np2|This\np3|my\np4|is',
      )
      await page.locator('textarea[name="reference-sentence"]').fill('This is my book!')
      await page.getByRole('button', { name: '保存练习内容' }).click()
      await expect(page.getByText(/检测到其他编辑已更新内容/)).toBeVisible()
    },
  },
  {
    page: 'exercise',
    state: '批准',
    slug: 'exercise-approved',
    scenario: 'exercise-approved',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-approve]'),
    prepare: async (page) => {
      await page.locator('[data-approve]').click()
      await expect(page.locator('[data-status="approved"]')).toBeVisible()
    },
  },
  {
    page: 'exercise',
    state: '禁用',
    slug: 'exercise-disabled',
    scenario: 'exercise-disabled',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.getByRole('button', { name: '禁用项目' }),
    prepare: async (page) => {
      await page.getByRole('button', { name: '禁用项目' }).click()
      await page.getByRole('button', { name: '确认禁用' }).click()
      await expect(page.locator('[data-status="disabled"]')).toBeVisible()
    },
  },
  {
    page: 'exercise',
    state: '已发布只读',
    slug: 'exercise-published-readonly',
    scenario: 'exercise-published-readonly',
    route: exerciseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.getByText('已发布版本只读'),
  },
  {
    page: 'courses',
    state: '无已发布版本',
    slug: 'courses-no-published-version',
    scenario: 'course-no-published-version',
    route: courseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-no-published]'),
  },
  {
    page: 'courses',
    state: '创建展开',
    slug: 'courses-create-expanded',
    scenario: 'course-create-expanded',
    route: courseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-scroll-region="courses"]'),
    prepare: async (page) => {
      await page.getByRole('button', { name: '创建课程' }).click()
      await expect(page.locator('#create-course-region')).toBeVisible()
    },
  },
  {
    page: 'courses',
    state: '创建成功',
    slug: 'courses-create-success',
    scenario: 'course-create-success',
    route: courseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-scroll-region="courses"]'),
    prepare: createCourseWithAccount,
  },
  {
    page: 'courses',
    state: '修改登录',
    slug: 'courses-login-editor',
    scenario: 'course-login-editor',
    route: courseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-scroll-region="courses"]'),
    prepare: async (page) => {
      await page.locator('[data-edit-login]').first().click()
      await expect(page.locator('[data-login-form]')).toBeVisible()
    },
  },
  {
    page: 'courses',
    state: '重新学习确认',
    slug: 'courses-reset-confirmation',
    scenario: 'course-reset-confirmation',
    route: courseRoute,
    viewport: workspaceViewport,
    ready: (page) => page.locator('[data-scroll-region="courses"]'),
    prepare: async (page) => {
      await page.locator('[data-reset-progress]').first().click()
      await expect(page.locator('[data-reset-confirmation]')).toBeVisible()
    },
  },
]

const settleVisualFrame = async (page: Page, resetScroll = true): Promise<void> => {
  await page.evaluate(async (shouldResetScroll) => {
    await document.fonts.ready
    if (shouldResetScroll) window.scrollTo(0, 0)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  }, resetScroll)
}

const captureProductionState = async (
  browser: Browser,
  input: VisualStateCase,
  stateOutputDir: string,
): Promise<VisualStateMetric> => {
  const context = await browser.newContext({
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  const fixture = await installStateMatrixFixture(page, input.scenario)

  try {
    await page.setViewportSize(input.viewport)
    await page.goto(input.route)
    await expect(input.ready(page)).toBeVisible()
    await input.prepare?.(page)
    await settleVisualFrame(page)
    if (input.visualTarget) {
      await input.visualTarget(page).evaluate((element) => {
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
      })
      await settleVisualFrame(page, false)
    }

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      allowedRegions: Array.from(
        document.querySelectorAll<HTMLElement>('.table-scroll, .matrix-scroll'),
      ).map((element) => ({
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      })),
    }))

    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
    expect(pageErrors).toEqual([])
    expect(
      consoleErrors.filter(
        (message) => !message.startsWith('Failed to load resource:'),
      ),
    ).toEqual([])

    const target = path.join(stateOutputDir, `${input.slug}.png`)
    await page.screenshot({ path: target })

    return {
      page: input.page,
      state: input.state,
      slug: input.slug,
      path: path.relative(process.cwd(), target),
      viewport: input.viewport,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      ...overflow,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    }
  } finally {
    fixture.releasePending()
    await context.close()
  }
}

const captureStateContactSheet = async (
  browser: Browser,
  pageName: VisualStateCase['page'],
  metrics: VisualStateMetric[],
  stateOutputDir: string,
): Promise<string> => {
  const cards = await Promise.all(
    metrics.map(async (metric) => ({
      state: metric.state,
      slug: metric.slug,
      image: (await readFile(path.join(process.cwd(), metric.path))).toString('base64'),
    })),
  )
  const context = await browser.newContext({ colorScheme: 'light' })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1080, height: 720 })
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 24px; background: #eef4f2; color: #23343a; font-family: system-ui, sans-serif; }
          h1 { margin: 0 0 20px; font-size: 24px; }
          main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
          figure { margin: 0; overflow: hidden; border: 1px solid #b9ceca; border-radius: 8px; background: white; box-shadow: 0 2px 8px rgb(35 52 58 / 8%); }
          figcaption { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 44px; padding: 11px 14px; border-bottom: 1px solid #dde8e5; }
          figcaption strong { font-size: 15px; }
          figcaption span { color: #60737a; font-size: 11px; }
          img { display: block; width: 100%; height: 300px; object-fit: contain; object-position: top center; background: #f4f8f7; }
        </style>
      </head>
      <body>
        <h1>${pageName} · 生产状态覆盖</h1>
        <main>
          ${cards.map((card) => `
            <figure>
              <figcaption><strong>${card.state}</strong><span>${card.slug}</span></figcaption>
              <img alt="${card.state}" src="data:image/png;base64,${card.image}">
            </figure>
          `).join('')}
        </main>
      </body>
    </html>
  `)
  await expect(page.locator('img')).toHaveCount(cards.length)
  await page.locator('img').evaluateAll(async (images) => {
    await Promise.all(
      images.map(
        (image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener('load', () => {
                  resolve()
                }, { once: true })
              }),
      ),
    )
  })
  const target = path.join(stateOutputDir, `${pageName}-contact-sheet.png`)
  await page.screenshot({ path: target, fullPage: true })
  await context.close()
  return path.relative(process.cwd(), target)
}

test('@visual-qa captures same-viewport reference and production comparisons', async ({
  browser,
}) => {
  await mkdir(outputDir, { recursive: true })
  const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' })
  const referencePage = await context.newPage()
  const productionPage = await context.newPage()
  const comparisonPage = await context.newPage()
  await installAdminFixture(productionPage)

  const captures = [
    {
      name: 'login-375x812',
      selector: '#login .login-card',
      route: '/admin/login',
      viewport: { width: 375, height: 812 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '管理员登录' }),
    },
    {
      name: 'login-1280x800',
      selector: '#login .login-card',
      route: '/admin/login',
      viewport: { width: 1280, height: 800 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '管理员登录' }),
    },
    {
      name: 'sources-1280x800',
      selector: '#sources .admin-shell',
      route: '/admin/source-versions',
      viewport: { width: 1280, height: 800 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '词库版本' }),
      prepare: async () => {
        await productionPage.getByRole('button', { name: '导入词表' }).click()
        await productionPage.getByLabel('词库名称').fill('小学英语三年级上册')
      },
    },
    {
      name: 'version-1280x900',
      selector: '#version .admin-shell',
      route: `/admin/source-versions/${version.versionId}`,
      viewport: { width: 1280, height: 900 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '版本 v3' }),
    },
    {
      name: 'exercise-1280x800',
      selector: '#exercise .admin-shell',
      route: `/admin/source-versions/${version.versionId}/exercises/${exerciseItem.id}`,
      viewport: { width: 1280, height: 800 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: 'book 的练习项目' }),
      prepare: async () => {
        await productionPage.locator('textarea[name="pieces"]').fill('p2|This\np4|is\np3|my')
        const saveButton = productionPage.getByRole('button', { name: '保存练习内容' })
        await saveButton.click()
        await expect(productionPage.locator('[data-form-error-summary]')).toBeVisible()
        const saveButtonBox = await saveButton.boundingBox()
        expect(saveButtonBox).not.toBeNull()
        expect((saveButtonBox?.y ?? 0) + (saveButtonBox?.height ?? 0)).toBeLessThanOrEqual(800)
      },
    },
    {
      name: 'courses-1280x800',
      selector: '#courses .admin-shell',
      route: '/admin/courses',
      viewport: { width: 1280, height: 800 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '课程工作台' }),
      prepare: async () => {
        await expect(productionPage.locator('[data-scroll-region="courses"]'))
          .toHaveAttribute('tabindex', '0')
        await productionPage.getByRole('button', { name: '创建课程' }).click()
        await productionPage.getByLabel('学习者姓名').fill('小明')
        await productionPage.getByLabel('学习账号').fill('xiaoming-new')
        await productionPage.getByLabel('6 位 PIN').fill('123456')
      },
    },
  ]

  const metrics: Array<Record<string, unknown>> = []
  for (const capture of captures) {
    const referencePath = await captureReference(referencePage, capture)
    const production = await captureProduction(productionPage, capture)
    const comparisonPath = await captureComparison(comparisonPage, {
      name: capture.name,
      viewport: capture.viewport,
      referencePath,
      productionPath: production.path,
    })
    metrics.push({
      name: capture.name,
      referencePath,
      productionPath: production.path,
      comparisonPath,
      consoleErrors: production.consoleErrors,
      pageErrors: production.pageErrors,
      clientWidth: production.clientWidth,
      scrollWidth: production.scrollWidth,
      allowedRegions: production.allowedRegions,
    })
  }

  console.log(`ADMIN_VISUAL_QA ${JSON.stringify(metrics)}`)
  await context.close()
})

test('@visual-qa captures the complete production state matrix', async ({ browser }) => {
  test.setTimeout(180_000)
  const stateOutputDir = path.join(outputDir, 'state-matrix')
  await mkdir(stateOutputDir, { recursive: true })

  const metrics: VisualStateMetric[] = []
  for (const stateCase of stateCases) {
    metrics.push(await captureProductionState(browser, stateCase, stateOutputDir))
  }

  const contactSheets: Record<string, string> = {}
  for (const pageName of ['login', 'sources', 'version', 'exercise', 'courses'] as const) {
    contactSheets[pageName] = await captureStateContactSheet(
      browser,
      pageName,
      metrics.filter((metric) => metric.page === pageName),
      stateOutputDir,
    )
  }

  const manifest = {
    generatedAt: '2026-07-14',
    source: 'PLAN_0714 §14 state coverage matrix',
    contactSheets,
    states: metrics,
  }
  const manifestPath = path.join(stateOutputDir, 'state-matrix.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  expect(metrics).toHaveLength(stateCases.length)
  expect(metrics.every((metric) => metric.pageErrors.length === 0)).toBe(true)
  console.log(
    `ADMIN_VISUAL_STATE_MATRIX ${JSON.stringify({
      manifestPath: path.relative(process.cwd(), manifestPath),
      contactSheets,
      stateCount: metrics.length,
    })}`,
  )
})
