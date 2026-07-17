import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { installMockedAdminWorkspaceApiRouteFixture } from './fixtures/adminWorkspaceApiRouteFixture'
import { installMockedLearnerApiRouteFixture } from './fixtures/learnerApiRouteFixture'

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
}

const expectTwoHundredPercentEquivalentReflow = async (
  page: Page,
  nominalViewportWidth: number,
): Promise<void> => {
  const metrics = await page.evaluate(() => ({
    cssViewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    documentScrollWidth: document.documentElement.scrollWidth,
    rootZoom: getComputedStyle(document.documentElement).zoom,
    bodyZoom: getComputedStyle(document.body).zoom,
  }))

  // This is standards-equivalent reflow coverage, not automation of the
  // browser UI zoom control: half the nominal CSS viewport plus DPR 2 models
  // the layout metrics, while CSS zoom is deliberately kept at 1.
  expect(metrics.cssViewportWidth * 2).toBe(nominalViewportWidth)
  expect(metrics.devicePixelRatio).toBe(2)
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.cssViewportWidth)
  expect(metrics.rootZoom).toBe('1')
  expect(metrics.bodyZoom).toBe('1')
}

const expectNoSeriousAccessibilityViolations = async (page: Page): Promise<void> => {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  )
  const result = await new AxeBuilder({ page }).analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  )

  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
      })),
    })),
  ).toEqual([])
}

const moveFocusWithKeyboard = async (
  page: Page,
  target: Locator,
  direction: 'forward' | 'backward' = 'forward',
): Promise<void> => {
  await expect(target).toBeVisible()

  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab')
  }

  await expect(target).toBeFocused()
}

const contrastRatio = async (
  page: Page,
  foregroundSelector: string,
  backgroundSelector: string,
  foregroundProperty: 'color' | 'outlineColor' = 'color',
): Promise<number> =>
  page.evaluate(
    ({ foregroundSelector, backgroundSelector, foregroundProperty }) => {
      const foreground = document.querySelector(foregroundSelector)
      const background = document.querySelector(backgroundSelector)
      if (!foreground || !background) {
        throw new Error('Contrast target is missing')
      }

      const toRgb = (color: string): [number, number, number] => {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('Canvas context is unavailable')
        }
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data
        return [red, green, blue]
      }

      const luminance = ([red, green, blue]: [number, number, number]): number => {
        const channels = [red, green, blue].map((channel) => {
          const normalized = channel / 255
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
      }

      const foregroundLuminance = luminance(
        toRgb(getComputedStyle(foreground)[foregroundProperty]),
      )
      const backgroundLuminance = luminance(toRgb(getComputedStyle(background).backgroundColor))
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      )
    },
    { foregroundSelector, backgroundSelector, foregroundProperty },
  )

test('@learner [mocked route fixture] keeps one quiet focus across learner viewports', async ({ page }) => {
  await installMockedLearnerApiRouteFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/app')

  expect(
    await page.evaluate(() =>
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    ),
  ).toBe(true)

  await expect(page.getByRole('heading', { level: 1, name: '进入你的课程' })).toBeVisible()
  await expect(page.locator('[data-layout="learner"]')).toBeVisible()
  await expect(page.getByLabel('10 位学习码')).toBeVisible()
  await expect(page.getByRole('button', { name: '进入课程' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  expect(
    await contrastRatio(page, '.learner-brand__mark', '.learner-brand__mark'),
  ).toBeGreaterThanOrEqual(4.5)

  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()

  const motionDuration = await page.locator('.page-enter').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).animationDuration),
  )
  expect(motionDuration).toBeLessThanOrEqual(0.001)
})

test('@learner @reflow-200-learner keeps the learner entry usable with 200%-equivalent reflow metrics', async ({
  page,
}) => {
  await installMockedLearnerApiRouteFixture(page)
  await page.goto('/app')

  await expect(page.getByRole('heading', { level: 1, name: '进入你的课程' })).toBeVisible()
  await expect(page.getByLabel('10 位学习码')).toBeVisible()
  await expect(page.getByRole('button', { name: '进入课程' })).toBeVisible()
  await expectTwoHundredPercentEquivalentReflow(page, 640)
})

test('@admin keeps a dense segmented workspace across admin viewports', async ({ page }) => {
  const adminRequests: string[] = []
  const appRequests: string[] = []
  let expireAdminBusinessRequest = false

  await page.route('**/api/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    adminRequests.push(key)

    if (expireAdminBusinessRequest) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'admin_session_expired', message: 'Admin session expired' },
        }),
      })
      return
    }

    if (key === 'GET /api/admin/session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            id: 'fixture-admin',
            source: 'cloudflare_access',
            displayName: '内容管理员',
            email: 'fixture-admin@example.test',
          },
        }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            sourceId: 'source-1',
            sourceName: 'Starter words',
            versionId: 'version-1',
            versionNo: 1,
            status: 'draft',
            wordCount: 1,
            groupCount: 1,
            exerciseItemCount: 1,
            approvedItemCount: 0,
            createdAt: '2026-07-13T00:00:00.000Z',
            readyToPublish: false,
            missingItems: [
              {
                word: 'apple',
                stage: 'S1',
                taskType: 'recall_word',
                reason: 'exercise_item_draft',
              },
            ],
          },
        }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/coverage') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            sourceVersionId: 'version-1',
            wordCount: 1,
            readyToPublish: false,
            cells: [
              {
                wordId: 'word-1',
                word: 'apple',
                stage: 'S1',
                taskType: 'recall_word',
                status: 'draft',
                itemId: 'item-1',
                reason: 'exercise_item_draft',
              },
            ],
            missingItems: [
              {
                word: 'apple',
                stage: 'S1',
                taskType: 'recall_word',
                reason: 'exercise_item_draft',
              },
            ],
          },
        }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/exercises') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: [
            {
              id: 'item-1',
              sourceVersionId: 'version-1',
              wordId: 'word-1',
              word: 'apple',
              status: 'draft',
              stage: 'S1',
              taskType: 'recall_word',
              prompt: { meaning: '苹果' },
              answer: { word: 'apple' },
            },
          ],
        }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/review') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            sourceVersionId: 'version-1',
            sourceName: 'Starter words',
            versionNo: 1,
            contentRevision: 0,
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
              status: 'draft',
              reviewState: 'pending_review',
              stage: 'S1',
              taskType: 'recall_word',
              prompt: { meaning: '苹果' },
            },
          },
        }),
      })
      return
    }

    await route.abort('failed')
  })
  await page.route('**/api/app/**', async (route) => {
    appRequests.push(route.request().url())
    await route.abort('failed')
  })
  await page.goto('/admin')

  await expect(page).toHaveURL(/\/admin\/source-versions$/u)
  const sourceHeading = page.getByRole('heading', { level: 1, name: '词库版本' })
  await expect(sourceHeading).toBeVisible()
  await expect(sourceHeading).toBeFocused()
  await expect(page.getByRole('navigation', { name: '管理端主导航' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: '还没有词库版本' })).toBeVisible()
  const createDraftButton = page.getByRole('button', { name: '导入并创建草稿' })
  const currentViewportWidth = page.viewportSize()?.width ?? 0
  if (currentViewportWidth < 480) {
    await expect(createDraftButton).toHaveCount(0)
  } else {
    await expect(createDraftButton).toBeDisabled()
  }
  expect(adminRequests.slice(0, 2)).toEqual([
    'GET /api/admin/session',
    'GET /api/admin/source-versions',
  ])
  expect(appRequests).toEqual([])
  await expectNoHorizontalOverflow(page)
  await expectNoSeriousAccessibilityViolations(page)

  const sidebarWidth = await page.locator('.admin-sidebar').evaluate((element) =>
    element.getBoundingClientRect().width,
  )
  const viewportWidth = page.viewportSize()?.width
  expect(viewportWidth).toBeDefined()

  if ((viewportWidth ?? 0) < 768) {
    await expect(page.locator('.admin-mobile-notice')).toBeVisible()
    await expect(page.locator('.admin-mobile-notice')).toContainText('窄屏可查看')
  } else if ((viewportWidth ?? 0) < 1200) {
    expect(sidebarWidth).toBeGreaterThanOrEqual(64)
    expect(sidebarWidth).toBeLessThanOrEqual(96)
    const sourceWorkspaceLink = page.getByRole('link', { name: '词库工作台' })
    const courseWorkspaceLink = page.getByRole('link', { name: '课程工作台' })
    await expect(sourceWorkspaceLink).toHaveAttribute('aria-label', '词库工作台')
    await expect(courseWorkspaceLink).toHaveAttribute('aria-label', '课程工作台')
    await sourceWorkspaceLink.focus()
    await expect(sourceWorkspaceLink.locator('.admin-nav__label')).toBeVisible()
  } else {
    expect(sidebarWidth).toBeGreaterThanOrEqual(200)
    await expect(page.locator('.admin-mobile-notice')).toBeHidden()
  }

  if ((viewportWidth ?? 0) >= 1200) {
    expect(
      await contrastRatio(page, '.admin-identity--sidebar span', '.admin-sidebar'),
    ).toBeGreaterThanOrEqual(4.5)
  }

  const skipLink = page.locator('.skip-link')
  await skipLink.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#admin-main')).toBeFocused()

  await page.goto('/admin/source-versions/version-1')
  await expect(page.getByRole('heading', { level: 1, name: '版本 v1' })).toBeVisible()
  await expectNoSeriousAccessibilityViolations(page)
  const reviewLink = page.getByRole('link', { name: '进入审阅模式' })
  if ((viewportWidth ?? 0) < 480) {
    await expect(reviewLink).toHaveCount(0)
  } else {
    await expect(reviewLink).toBeVisible()
    expect((await reviewLink.boundingBox())?.height).toBeGreaterThanOrEqual(40)
  }

  const discardButton = page.getByRole('button', { name: '丢弃草稿' })
  if ((viewportWidth ?? 0) < 480) {
    await expect(discardButton).toHaveCount(0)
  } else {
    await discardButton.click()
    const confirmation = page.locator('[data-inline-confirmation]')
    await expect(confirmation).toHaveAttribute('aria-live', 'polite')
    await expect(confirmation).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirmation).toBeHidden()
    await expect(discardButton).toBeFocused()
  }

  expireAdminBusinessRequest = true
  await page.getByRole('link', { name: '课程工作台' }).click()
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=expired/u)
  await expect(page.getByRole('heading', { level: 1, name: '管理员登录' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('登录已过期')
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)
  await expectNoSeriousAccessibilityViolations(page)
})

test('@admin verifies exercise and course mutation boundaries at 479 and 480 pixels', async ({
  page,
}) => {
  const viewportWidth = page.viewportSize()?.width ?? 0
  test.skip(
    viewportWidth !== 479 && viewportWidth !== 480,
    'This boundary contract only applies to the adjacent 479px and 480px projects.',
  )

  const fixture = await installMockedAdminWorkspaceApiRouteFixture(page, {
    withExistingCourse: true,
  })

  await page.goto('/admin/source-versions/version-1/exercises/item-1')
  await expect(page.getByRole('heading', { level: 1, name: 'apple 的练习项目' })).toBeVisible()

  if (viewportWidth === 479) {
    await expect(page.locator('[data-mobile-exercise-summary]')).toBeVisible()
    await expect(page.locator('.exercise-form')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存练习内容' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '批准项目' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '禁用项目' })).toHaveCount(0)
  } else {
    await expect(page.locator('[data-mobile-exercise-summary]')).toHaveCount(0)
    await expect(page.locator('.exercise-form')).toBeVisible()
    await expect(page.getByRole('button', { name: '保存练习内容' })).toBeVisible()
    await expect(page.getByRole('button', { name: '批准项目' })).toBeVisible()
    await expect(page.getByRole('button', { name: '禁用项目' })).toBeVisible()
  }

  await expectNoHorizontalOverflow(page)
  await expectNoSeriousAccessibilityViolations(page)

  await page.goto('/admin/courses')
  await expect(page.getByRole('heading', { level: 1, name: '课程工作台' })).toBeVisible()

  const createCourseButton = page.locator('[data-toggle-create]')
  const rotateCodeButton = page.locator('[data-rotate-code]')
  if (viewportWidth === 479) {
    await expect(page.locator('[data-mobile-readonly]')).toBeVisible()
    await expect(createCourseButton).toHaveCount(0)
    await expect(rotateCodeButton).toHaveCount(0)
    await expect(page.locator('[data-course-form]')).toHaveCount(0)
    await expect(page.locator('[data-copy-code]')).toHaveCount(0)
  } else {
    await expect(page.locator('[data-mobile-readonly]')).toHaveCount(0)
    await expect(createCourseButton).toBeVisible()
    await expect(rotateCodeButton).toBeVisible()
  }

  await expectNoHorizontalOverflow(page)
  await expectNoSeriousAccessibilityViolations(page)
  expect(fixture.unhandledRequests).toEqual([])
})

test('@admin completes the content workbench with keyboard-only critical actions', async ({
  context,
  page,
}) => {
  test.skip(
    page.viewportSize()?.width !== 1280,
    'The continuous keyboard workflow runs once in the desktop project.',
  )

  const fixturePassword = ['fixture', 'keyboard', 'password'].join('-')
  const fixture = await installMockedAdminWorkspaceApiRouteFixture(page, {
    authenticated: false,
  })

  await page.goto('/admin/login')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  })
  const usernameInput = page.getByLabel('管理员账号')
  const passwordInput = page.getByLabel('密码')
  await expect(usernameInput).toBeVisible()
  await moveFocusWithKeyboard(page, usernameInput)
  await page.keyboard.type('solazhu')
  await page.keyboard.press('Tab')
  await expect(passwordInput).toBeFocused()
  await page.keyboard.type(fixturePassword)
  await page.keyboard.press('Tab')
  const loginButton = page.getByRole('button', { name: '登录管理台' })
  await expect(loginButton).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/\/admin\/source-versions$/u)
  await expect(page.getByRole('heading', { level: 1, name: '词库版本' })).toBeFocused()

  const importToggle = page.getByRole('button', { name: '导入词表' })
  await moveFocusWithKeyboard(page, importToggle)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-import-workspace]')).toBeVisible()

  const sourceNameInput = page.getByLabel('词库名称')
  await moveFocusWithKeyboard(page, sourceNameInput)
  await page.keyboard.type('Keyboard import')
  const csvInput = page.getByLabel('CSV 文件')
  await moveFocusWithKeyboard(page, csvInput)
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles({
    name: 'keyboard-import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech\napple,苹果,An apple,I eat an apple,I eat an apple every day,noun\n',
    ),
  })
  await expect(page.locator('[data-csv-preview]')).toContainText('预览通过 · 1 个词')

  const importButton = page.getByRole('button', { name: '导入并创建草稿' })
  await moveFocusWithKeyboard(page, importButton)
  await page.keyboard.press('Enter')
  await expect(page.getByText(/服务端已创建 v1/u)).toBeVisible()

  const detailLink = page.getByRole('link', { name: '查看详情' }).first()
  await moveFocusWithKeyboard(page, detailLink, 'backward')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/source-versions\/version-1$/u)
  await expect(page.getByRole('heading', { level: 1, name: '版本 v1' })).toBeFocused()

  const openExerciseLink = page.getByRole('link', { name: '打开练习', exact: true })
  await moveFocusWithKeyboard(page, openExerciseLink)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/source-versions\/version-1\/exercises\/item-1$/u)

  const meaningInput = page.getByLabel('中文词义')
  await moveFocusWithKeyboard(page, meaningInput)
  await page.keyboard.press('Control+A')
  await page.keyboard.type('苹果水果')
  const saveButton = page.getByRole('button', { name: '保存练习内容' })
  await moveFocusWithKeyboard(page, saveButton)
  await page.keyboard.press('Enter')
  await expect(page.getByText('练习内容已保存，项目状态以服务端返回为准。')).toBeVisible()

  const approveButton = page.getByRole('button', { name: '批准项目' })
  await moveFocusWithKeyboard(page, approveButton)
  await page.keyboard.press('Enter')
  await expect(page.getByText('练习项目已批准；覆盖率需回到版本页重新读取。')).toBeVisible()

  const backToVersionLink = page.getByRole('link', { name: '返回版本 v1' })
  await moveFocusWithKeyboard(page, backToVersionLink, 'backward')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: '版本 v1' })).toBeFocused()

  const publishButton = page.getByRole('button', { name: '发布版本' })
  await expect(publishButton).toBeEnabled()
  await moveFocusWithKeyboard(page, publishButton)
  await page.keyboard.press('Enter')
  const publishConfirmation = page.locator('[data-inline-confirmation]')
  await expect(publishConfirmation).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(publishConfirmation).toHaveCount(0)
  await expect(publishButton).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(publishConfirmation).toBeFocused()
  const confirmPublishButton = page.getByRole('button', { name: '确认发布' })
  await moveFocusWithKeyboard(page, confirmPublishButton)
  await page.keyboard.press('Enter')
  await expect(page.getByText('版本已发布，只读。后续修改请创建下一草稿版本。')).toBeVisible()

  const courseWorkspaceLink = page.getByRole('link', { name: '课程工作台' })
  await moveFocusWithKeyboard(page, courseWorkspaceLink, 'backward')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/courses$/u)
  await expect(page.getByRole('heading', { level: 1, name: '课程工作台' })).toBeFocused()

  const learnerNameInput = page.getByLabel('学习者姓名')
  await moveFocusWithKeyboard(page, learnerNameInput)
  await page.keyboard.type('小红')
  const sourceVersionSelect = page.getByLabel('已发布词库版本')
  await moveFocusWithKeyboard(page, sourceVersionSelect)
  await expect(sourceVersionSelect).toHaveValue('version-1')
  const createCourseButton = page.getByRole('button', { name: '创建课程并生成学习码' })
  await moveFocusWithKeyboard(page, createCourseButton)
  await page.keyboard.press('Enter')

  const oneTimeCodeDialog = page.locator('[data-one-time-code]')
  let clipboardMatches = false
  try {
    await expect(oneTimeCodeDialog).toBeFocused()
    const copyCodeButton = page.getByRole('button', { name: '复制学习码' })
    await moveFocusWithKeyboard(page, copyCodeButton)
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-copy-feedback]')).toHaveText(
      '复制成功，请保存到安全位置。',
    )
    clipboardMatches = await page.evaluate(async () => {
      const expected = document.querySelector('[data-one-time-code] code')?.textContent
      return Boolean(expected) && (await navigator.clipboard.readText()) === expected
    })
  } finally {
    await oneTimeCodeDialog
      .locator('code')
      .evaluateAll((nodes) => {
        for (const node of nodes) node.textContent = '•••• •••• ••'
      })
      .catch(() => undefined)
  }
  expect(clipboardMatches).toBe(true)
  const dismissCodeButton = page.getByRole('button', { name: '我已安全记录' })
  await moveFocusWithKeyboard(page, dismissCodeButton)
  await page.keyboard.press('Enter')
  await expect(oneTimeCodeDialog).toHaveCount(0)

  const logoutButton = page.getByRole('button', { name: '退出' })
  await moveFocusWithKeyboard(page, logoutButton, 'backward')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/login\?reason=logged_out$/u)
  await expect(page.getByRole('status')).toContainText('已安全退出')
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)

  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: '管理员登录' })).toBeVisible()
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)
  await expect(page.locator('[data-version-workspace], [data-exercise-workbench], [data-course-form]')).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: '管理员登录' })).toBeVisible()
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)
  await expect(page.locator('[data-version-workspace], [data-exercise-workbench], [data-course-form]')).toHaveCount(0)

  expect(fixture.apiCalls).toEqual(
    expect.arrayContaining([
      'POST /api/admin/auth/login',
      'POST /api/admin/source-versions/import',
      'PUT /api/admin/exercise-items/item-1',
      'POST /api/admin/exercise-items/item-1/approve',
      'POST /api/admin/source-versions/version-1/publish',
      'POST /api/admin/courses',
      'POST /api/admin/auth/logout',
    ]),
  )
  expect(fixture.requestBodies).toEqual(
    expect.arrayContaining([
      {
        key: 'POST /api/admin/auth/login',
        body: { username: 'solazhu', passwordProvided: true },
      },
    ]),
  )
  expect(fixture.unhandledRequests).toEqual([])
})

test('@admin keeps login, session mount and logout keyboard-usable', async ({ page }) => {
  let authenticated = false
  const fixturePassword = ['fixture', 'only', 'value'].join('-')

  await page.route('**/api/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`

    if (key === 'GET /api/admin/session') {
      await route.fulfill({
        status: authenticated ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
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
        ),
      })
      return
    }

    if (key === 'POST /api/admin/auth/login') {
      const body = request.postDataJSON() as { username?: unknown; password?: unknown }
      expect(body.username).toBe('solazhu')
      expect(typeof body.password === 'string' && body.password.length > 0).toBe(true)
      authenticated = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            id: 'fixture-admin',
            source: 'application_session',
            displayName: 'Solazhu',
          },
        }),
      })
      return
    }

    if (key === 'POST /api/admin/auth/logout') {
      authenticated = false
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { loggedOut: true } }),
      })
      return
    }

    if (key === 'GET /api/admin/source-versions') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      })
      return
    }

    await route.abort('failed')
  })

  await page.goto('/admin/login')
  const usernameInput = page.getByLabel('管理员账号')
  const passwordInput = page.getByLabel('密码')
  await expect(page.getByRole('heading', { level: 1, name: '管理员登录' })).toBeVisible()
  await expect(usernameInput).toBeVisible()
  await expect(passwordInput).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expectNoSeriousAccessibilityViolations(page)

  await usernameInput.fill('solazhu')
  await passwordInput.fill(fixturePassword)
  await passwordInput.press('Enter')

  await expect(page).toHaveURL(/\/admin\/source-versions$/u)
  const workspaceHeading = page.getByRole('heading', { level: 1, name: '词库版本' })
  await expect(workspaceHeading).toBeVisible()
  await expect(workspaceHeading).toBeFocused()
  await expect(page.getByText('Solazhu', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '退出' }).click()
  await expect(page).toHaveURL(/\/admin\/login\?reason=logged_out$/u)
  await expect(page.getByRole('status')).toContainText('已安全退出')
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)
})

test('@admin @reflow-200-admin keeps the admin shell readable with 200%-equivalent reflow metrics', async ({
  page,
}) => {
  await page.route('**/api/admin/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          id: 'fixture-admin',
          source: 'cloudflare_access',
          displayName: '内容管理员',
          email: 'fixture-admin@example.test',
        },
      }),
    })
  })
  await page.route('**/api/admin/source-versions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [] }),
    })
  })

  await page.goto('/admin')

  await expect(page.getByRole('heading', { level: 1, name: '词库版本' })).toBeVisible()
  await expect(page.locator('.admin-mobile-notice')).toContainText('窄屏可查看')
  await expectTwoHundredPercentEquivalentReflow(page, 1280)
})

test('@controls exposes real keyboard, size and forced-colors behavior', async ({ page }) => {
  await page.goto('/tests/e2e/ui/fixtures/basic-controls.html')

  const learnerButton = page.getByTestId('learner-button')
  const learnerInput = page.getByTestId('learner-input')
  const adminButton = page.getByTestId('admin-button')
  const adminInput = page.getByTestId('admin-input')

  await expect(page.getByRole('heading', { level: 1, name: '基础控件浏览器夹具' })).toBeVisible()
  await expect(learnerButton).toBeVisible()
  await expect(learnerInput).toBeVisible()
  await expect(adminButton).toBeVisible()
  await expect(adminInput).toBeVisible()

  expect((await learnerButton.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  expect((await learnerInput.boundingBox())?.height).toBeGreaterThanOrEqual(52)
  expect((await adminButton.boundingBox())?.height).toBeGreaterThanOrEqual(40)
  expect((await adminInput.boundingBox())?.height).toBeGreaterThanOrEqual(40)
  await expectNoHorizontalOverflow(page)

  await page.keyboard.press('Tab')
  await expect(learnerButton).toBeFocused()
  expect(await learnerButton.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  expect(
    await contrastRatio(page, '[data-testid="learner-button"]', 'html', 'outlineColor'),
  ).toBeGreaterThanOrEqual(3)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('activation-status')).toHaveText('学习按钮已激活 1 次')

  await page.keyboard.press('Tab')
  await expect(learnerInput).toBeFocused()
  expect(await learnerInput.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  expect(
    await contrastRatio(page, '[data-testid="learner-input"]', 'html', 'outlineColor'),
  ).toBeGreaterThanOrEqual(3)
  await page.keyboard.type('ABCD12')
  await expect(learnerInput).toHaveValue('ABCD12')

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  expect(
    await page.evaluate(() => window.matchMedia('(forced-colors: active)').matches),
  ).toBe(true)
  await learnerInput.focus()
  expect(await learnerInput.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  const maximumTransitionDuration = await page.locator('button, input').evaluateAll((elements) =>
    Math.max(
      ...elements.flatMap((element) =>
        getComputedStyle(element)
          .transitionDuration.split(',')
          .map((duration) => Number.parseFloat(duration) * (duration.includes('ms') ? 0.001 : 1)),
      ),
    ),
  )
  expect(maximumTransitionDuration).toBeLessThanOrEqual(0.001)
})

test('@controls keeps long Chinese and English content inside narrow viewports', async ({
  page,
}) => {
  await page.goto('/tests/e2e/ui/fixtures/basic-controls.html')

  const longChineseAction = page.getByTestId('long-chinese-action')
  const longEnglishStatus = page.getByTestId('long-english-status')

  await expect(longChineseAction).toBeVisible()
  await expect(longEnglishStatus).toBeVisible()
  await expectNoHorizontalOverflow(page)

  for (const target of [longChineseAction, longEnglishStatus]) {
    const metrics = await target.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: document.documentElement.clientWidth,
      }
    })

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
    expect(metrics.left).toBeGreaterThanOrEqual(0)
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth)
  }
})

test('@controls keeps state meaning visible when Chromium removes color', async ({ page }) => {
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Emulation.setEmulatedVisionDeficiency', {
    type: 'achromatopsia',
  })

  try {
    await page.goto('/tests/e2e/ui/fixtures/basic-controls.html')

    const correctState = page.getByTestId('state-correct')
    const errorState = page.getByTestId('state-error')
    const disabledState = page.getByTestId('state-disabled')

    await expect(correctState).toContainText('回答正确')
    await expect(errorState).toContainText('回答错误')
    await expect(errorState).toHaveAttribute('role', 'alert')
    await expect(disabledState).toBeDisabled()
    await expect(disabledState).toContainText('已禁用')

    const correctMarker = correctState.locator('.ui-status__marker')
    const errorMarker = errorState.locator('.ui-status__marker')
    expect(await correctMarker.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
    expect(await errorMarker.evaluate((element) => getComputedStyle(element).transform)).not.toBe('none')

    await page.goto('/tests/e2e/ui/fixtures/task-renderers.html')
    const selectedChoice = page.locator('[data-renderer="s1"] input[value="apple"]')
    await selectedChoice.check()
    await expect(selectedChoice).toBeChecked()
    expect((await selectedChoice.boundingBox())?.width).toBeGreaterThanOrEqual(20)

    await page.route('**/api/admin/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            id: 'fixture-admin',
            source: 'cloudflare_access',
            displayName: '内容管理员',
            email: 'fixture-admin@example.test',
          },
        }),
      })
    })
    await page.route('**/api/admin/source-versions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: [
            {
              sourceId: 'source-published',
              sourceName: 'Starter words',
              versionId: 'version-published',
              versionNo: 2,
              status: 'published',
              wordCount: 20,
              groupCount: 4,
              exerciseItemCount: 120,
              approvedItemCount: 120,
              createdAt: '2026-07-13T00:00:00.000Z',
              publishedAt: '2026-07-14T00:00:00.000Z',
            },
          ],
        }),
      })
    })
    await page.goto('/admin/source-versions')

    const publishedState = page.locator('.status-badge[data-status="published"]')
    await expect(publishedState).toBeVisible()
    await expect(publishedState).toHaveText('已发布')
  } finally {
    await devtools.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' })
    await devtools.detach()
  }
})

test('@renderers keep six task types keyboard-operable and answer-safe', async ({ page }) => {
  await page.goto('/tests/e2e/ui/fixtures/task-renderers.html')

  await expect(page.locator('[data-renderer]')).toHaveCount(6)
  await expectNoHorizontalOverflow(page)
  expect(await page.content()).not.toContain('correct-position-')
  expect(await page.content()).not.toContain('PRIVATE REFERENCE SENTENCE')

  for (const option of await page.locator('[data-renderer="s1"] .choice-row').all()) {
    expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  }
  for (const response of await page.locator('[data-renderer="s0"] button').all()) {
    expect((await response.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  }
  expect((await page.locator('[data-renderer="s2"] input').boundingBox())?.height)
    .toBeGreaterThanOrEqual(52)
  expect((await page.locator('[data-renderer="s3"] input').boundingBox())?.height)
    .toBeGreaterThanOrEqual(52)
  for (const piece of await page.locator('[data-renderer="s4"] .piece-bank button').all()) {
    const bounds = await piece.boundingBox()
    expect(bounds?.height).toBeGreaterThanOrEqual(56)
    expect(bounds?.width).toBeGreaterThanOrEqual(48)
  }

  const recallInput = page.locator('[data-renderer="s2"] input')
  await recallInput.focus()
  await page.keyboard.type('apple')
  await page.keyboard.press('Enter')
  await expect(recallInput).toBeDisabled()

  const choice = page.locator('[data-renderer="s1"] input[value="apple"]')
  await choice.focus()
  await page.keyboard.press('Space')
  await expect(choice).toBeChecked()

  const firstPiece = page.getByRole('button', { name: '选择词块 I' })
  await firstPiece.focus()
  await page.keyboard.press('Space')
  const removePiece = page.getByRole('button', { name: '移除词块 I' })
  await expect(removePiece).toBeVisible()
  await removePiece.focus()
  await page.keyboard.press('Enter')
  await expect(firstPiece).toBeVisible()
  await firstPiece.focus()
  expect(
    await contrastRatio(
      page,
      '[data-renderer="s4"] [aria-label="选择词块 I"]',
      '[data-renderer="s4"] .piece-bank',
      'outlineColor',
    ),
  ).toBeGreaterThanOrEqual(3)

  const output = page.locator('[data-renderer="s5"] textarea')
  await output.focus()
  await page.keyboard.type('I see an apple.')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-renderer="s5"] [data-action="preview"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-renderer="s5"] [role="status"]'))
    .toContainText('PRIVATE REFERENCE SENTENCE')

  const score = page.locator('[data-renderer="s5"] [data-self-score="3"]')
  await score.focus()
  await page.keyboard.press('Space')
  await expect(score).toBeDisabled()
  expect(await score.evaluate((element) => getComputedStyle(element).cursor)).toBe('not-allowed')
  for (const scoreButton of await page.locator('[data-renderer="s5"] [data-self-score]').all()) {
    expect((await scoreButton.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  }

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  await firstPiece.focus()
  expect(await firstPiece.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  expect(
    await page.evaluate(() => window.matchMedia('(forced-colors: active)').matches),
  ).toBe(true)
  const maximumTransitionDuration = await page
    .locator('[data-renderer] button, [data-renderer] input, [data-renderer] textarea')
    .evaluateAll((elements) =>
      Math.max(
        ...elements.flatMap((element) =>
          getComputedStyle(element)
            .transitionDuration.split(',')
            .map((duration) => Number.parseFloat(duration) * (duration.includes('ms') ? 0.001 : 1)),
        ),
      ),
    )
  expect(maximumTransitionDuration).toBeLessThanOrEqual(0.001)
  await expectNoHorizontalOverflow(page)
})
