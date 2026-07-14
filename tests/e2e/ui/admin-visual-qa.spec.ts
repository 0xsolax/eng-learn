import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
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
  wordCount: 4,
  groupCount: 1,
  exerciseItemCount: 23,
  approvedItemCount: 20,
  createdAt: '2026-07-14T02:00:00.000Z',
  readyToPublish: false,
  missingItems: [
    {
      word: 'book',
      stage: 'S4',
      taskType: 'sentence_build',
      reason: 'exercise_item_draft',
    },
  ],
} as const

const publishedVersion = {
  ...version,
  versionId: 'version-2',
  versionNo: 2,
  status: 'published',
  exerciseItemCount: 24,
  approvedItemCount: 24,
  readyToPublish: true,
  missingItems: [],
  createdAt: '2026-07-12T02:00:00.000Z',
  publishedAt: '2026-07-13T02:00:00.000Z',
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

const courseEntries = [
  {
    learner: { id: 'learner-1', name: '小明' },
    course: {
      id: 'course-1',
      learnerId: 'learner-1',
      sourceVersionId: publishedVersion.versionId,
      currentLessonNo: 8,
      status: 'active',
    },
    credentialVersion: 1,
  },
  {
    learner: { id: 'learner-2', name: '小雨' },
    course: {
      id: 'course-2',
      learnerId: 'learner-2',
      sourceVersionId: publishedVersion.versionId,
      currentLessonNo: 5,
      status: 'paused',
    },
    credentialVersion: 1,
  },
] as const

const coverageCells = ['apple', 'book', 'school', 'teacher'].flatMap((word, wordIndex) =>
  ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map((stage, stageIndex) => {
    const isDraftGap = word === 'book' && stage === 'S4'
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
      status: isDraftGap ? 'draft' : 'approved',
      itemId: isDraftGap ? exerciseItem.id : `item-${word}-${stage}`,
      ...(isDraftGap ? { reason: 'exercise_item_draft' } : {}),
    }
  }),
)

const installAdminFixture = async (page: Page): Promise<void> => {
  let courseCreated = false

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
      await fulfill([
        version,
        publishedVersion,
        {
          ...publishedVersion,
          sourceId: 'source-core',
          sourceName: '核心词汇',
          versionId: 'version-core-1',
          versionNo: 1,
        },
      ].map(({ readyToPublish, missingItems, ...summary }) => {
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
      await fulfill([exerciseItem])
      return
    }
    if (key === `GET /api/admin/exercise-items/${exerciseItem.id}`) {
      await fulfill(exerciseItem)
      return
    }
    if (key === 'GET /api/admin/courses') {
      await fulfill({
        courses: courseCreated
          ? [
              ...courseEntries,
              {
                learner: { id: 'learner-3', name: '小杰' },
                course: {
                  id: 'course-3',
                  learnerId: 'learner-3',
                  sourceVersionId: publishedVersion.versionId,
                  currentLessonNo: 1,
                  status: 'active',
                },
                credentialVersion: 1,
              },
            ]
          : courseEntries,
      })
      return
    }
    if (key === 'POST /api/admin/courses') {
      courseCreated = true
      await fulfill({
        learner: {
          id: 'learner-3',
          name: '小杰',
          accessCode: 'ABCDEFGH23',
        },
        course: {
          id: 'course-3',
          learnerId: 'learner-3',
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
  await page.goto(pathToFileURL(reviewFile).href)
  await page.locator(input.selector).waitFor()
  await page.evaluate(
    ({ selector, dialogSelector }) => {
      const source = document.querySelector<HTMLElement>(selector)
      if (!source) {
        throw new Error(`Reference selector missing: ${selector}`)
      }

      const clone = source.cloneNode(true) as HTMLElement
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

      if (dialogSelector) {
        const sourceDialog = document.querySelector<HTMLDialogElement>(dialogSelector)
        if (!sourceDialog) {
          throw new Error(`Reference dialog missing: ${dialogSelector}`)
        }
        const dialog = sourceDialog.cloneNode(true) as HTMLDialogElement
        document.body.append(dialog)
        dialog.showModal()
      }
    },
    { selector: input.selector, dialogSelector: input.dialogSelector },
  )
  await page.evaluate(() => document.fonts.ready)
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
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize(input.viewport)
  await page.goto(input.route)
  await expect(input.ready()).toBeVisible()
  await input.prepare?.()
  await page.evaluate(() => document.fonts.ready)

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
    expect(consoleErrors).toEqual([
      'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    ])
  } else {
    expect(consoleErrors).toEqual([])
  }
  expect(pageErrors).toEqual([])

  const target = path.join(outputDir, `${input.name}-production.png`)
  await page.screenshot({ path: target })
  return { path: target, consoleErrors, pageErrors, ...overflow }
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
          main { display: grid; grid-template-columns: 1fr 1fr; }
          figure { margin: 0; min-width: 0; }
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
  const target = path.join(outputDir, `${input.name}-comparison.png`)
  await page.screenshot({ path: target })
  return target
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
        await productionPage.getByRole('button', { name: '保存练习内容' }).click()
        await expect(productionPage.locator('[data-form-error-summary]')).toBeVisible()
      },
    },
    {
      name: 'courses-1280x800',
      selector: '#courses .admin-shell',
      dialogSelector: '#code-dialog',
      route: '/admin/courses',
      viewport: { width: 1280, height: 800 },
      ready: () => productionPage.getByRole('heading', { level: 1, name: '课程工作台' }),
      prepare: async () => {
        await productionPage.getByRole('button', { name: '创建课程' }).click()
        await productionPage.getByLabel('学习者姓名').fill('小杰')
        await productionPage.getByRole('button', { name: '创建课程并生成学习码' }).click()
        const dialog = productionPage.locator('[data-one-time-code]')
        await expect(dialog).toBeVisible()
        await dialog.locator('code').evaluate((element) => {
          element.textContent = '•••• •••• ••'
        })
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
