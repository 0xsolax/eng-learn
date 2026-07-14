import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
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
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([])
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

    if (expireAdminBusinessRequest && key !== 'GET /api/admin/session') {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'unauthorized', message: 'Admin identity expired' },
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

    await route.abort('failed')
  })
  await page.route('**/api/app/**', async (route) => {
    appRequests.push(route.request().url())
    await route.abort('failed')
  })
  await page.goto('/admin')

  await expect(page).toHaveURL(/\/admin\/source-versions$/u)
  await expect(page.getByRole('heading', { level: 1, name: '词库版本' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '管理端主导航' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: '还没有词库版本' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建草稿版本' })).toBeDisabled()
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
    await expect(page.getByRole('link', { name: '词库工作台' }))
      .toHaveAttribute('title', '词库工作台')
    await expect(page.getByRole('link', { name: '课程工作台' }))
      .toHaveAttribute('title', '课程工作台')
  } else {
    expect(sidebarWidth).toBeGreaterThanOrEqual(200)
    await expect(page.locator('.admin-mobile-notice')).toBeHidden()
  }

  if ((viewportWidth ?? 0) >= 1200) {
    expect(
      await contrastRatio(page, '.admin-sidebar__meta', '.admin-sidebar'),
    ).toBeGreaterThanOrEqual(4.5)
  }

  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()

  await page.goto('/admin/source-versions/version-1')
  await expect(page.getByRole('heading', { level: 1, name: '版本 v1' })).toBeVisible()
  await expectNoSeriousAccessibilityViolations(page)
  const reviewLink = page.getByRole('link', { name: '先查看' })
  await expect(reviewLink).toBeVisible()
  expect((await reviewLink.boundingBox())?.height).toBeGreaterThanOrEqual(40)

  const discardButton = page.getByRole('button', { name: '丢弃草稿' })
  await discardButton.click()
  const confirmation = page.locator('[data-inline-confirmation]')
  await expect(confirmation).toHaveAttribute('aria-live', 'polite')
  await expect(confirmation).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden()
  await expect(discardButton).toBeFocused()

  expireAdminBusinessRequest = true
  await page.getByRole('link', { name: '课程工作台' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '管理端身份验证' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('管理员身份未通过')
  await expect(page.locator('[data-layout="admin"]')).toHaveCount(0)
  await expectNoSeriousAccessibilityViolations(page)
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
    const selectedChoice = page.locator('[data-renderer="s2"] input[value="apple"]')
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

  for (const option of await page.locator('[data-renderer="s2"] .choice-row').all()) {
    expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  }
  for (const response of await page.locator('[data-renderer="s0"] button').all()) {
    expect((await response.boundingBox())?.height).toBeGreaterThanOrEqual(56)
  }
  expect((await page.locator('[data-renderer="s1"] input').boundingBox())?.height)
    .toBeGreaterThanOrEqual(52)
  expect((await page.locator('[data-renderer="s3"] input').boundingBox())?.height)
    .toBeGreaterThanOrEqual(52)
  for (const piece of await page.locator('[data-renderer="s4"] .piece-bank button').all()) {
    const bounds = await piece.boundingBox()
    expect(bounds?.height).toBeGreaterThanOrEqual(56)
    expect(bounds?.width).toBeGreaterThanOrEqual(48)
  }

  const recallInput = page.locator('[data-renderer="s1"] input')
  await recallInput.focus()
  await page.keyboard.type('apple')
  await page.keyboard.press('Enter')
  await expect(recallInput).toBeDisabled()

  const choice = page.locator('[data-renderer="s2"] input[value="apple"]')
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
