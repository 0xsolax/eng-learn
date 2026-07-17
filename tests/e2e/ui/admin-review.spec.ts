import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const outputDir = path.join(
  process.cwd(),
  'pdoc/design/qa/PLAN_0717_学习版本双路径审阅与反馈重构闭环',
)

test('@admin review keeps the compact boundary and closes the feedback correction loop', async ({
  page,
}) => {
  const width = page.viewportSize()?.width ?? 0
  const evidence = await installReviewFixture(page)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  if (width === 1280) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/admin/source-versions/version-1')
    await expect(page.locator('[data-enter-review]')).toBeVisible()
    await expect(page.locator('[data-approve-all]')).toContainText('全部通过（2 项）')
    await expect(page.locator('[data-approval-list] input[type="checkbox"]')).toHaveCount(0)
    await mkdir(outputDir, { recursive: true })
    await page.screenshot({
      path: path.join(outputDir, 'version-detail-desktop-1280-dual-path.png'),
      fullPage: true,
    })
    await page.locator('[data-enter-review]').click()
  } else {
    await page.goto('/admin/source-versions/version-1/review')
  }
  await expect(page.getByRole('heading', { level: 1, name: '练习审阅' })).toBeVisible()

  if (width < 480) {
    await expect(page.locator('[data-review-readonly]')).toContainText('至少 480px')
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.locator('[data-review-feedback]')).toHaveCount(0)
    await expect(page.locator('[data-review-approve]')).toHaveCount(0)

    if (width === 375) {
      await mkdir(outputDir, { recursive: true })
      await page.screenshot({
        path: path.join(outputDir, 'review-mobile-375-readonly.png'),
        fullPage: true,
      })
    }

    expect(evidence.appRequests).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
    return
  }

  await expect(page.locator('[data-review-readonly]')).toHaveCount(0)
  await expect(page.locator('form.task-form')).toBeVisible()
  await expect(page.locator('[data-review-feedback]')).toBeVisible()

  if (width !== 1280) {
    expect(evidence.appRequests).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
    return
  }

  await page.locator('form.task-form input').fill('apple')
  await page.getByRole('button', { name: '检查答案' }).click()
  await expect(page.locator('[data-review-evaluation]')).toContainText('判定通过')
  await expect(page.locator('[data-review-approve]')).toBeEnabled()

  const feedbackTrigger = page.locator('[data-review-feedback]')
  await feedbackTrigger.click()
  await expect(page.locator('[data-feedback-panel]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-feedback-panel]')).toHaveCount(0)
  await expect(feedbackTrigger).toBeFocused()

  await feedbackTrigger.click()
  await page.locator('[data-review-feedback-text]').fill('中文释义需要更明确')
  await expect(page.locator('[data-review-feedback-count]')).toContainText('9 / 2000')
  await mkdir(outputDir, { recursive: true })
  await page.screenshot({
    path: path.join(outputDir, 'review-desktop-1280-feedback.png'),
    fullPage: true,
  })
  await page.locator('[data-review-request-rework]').click()
  await expect(page).toHaveURL(/\/review\/item-2$/u)
  await expect(page.locator('[data-review-runner]')).toContainText('banana')

  await page.locator('[data-review-previous]').click()
  await expect(page).toHaveURL(/\/review\/item-1$/u)
  await expect(page.locator('[data-review-open-feedback]')).toContainText(
    '中文释义需要更明确',
  )
  await expect(page.locator('[data-review-approve]')).toHaveCount(0)

  await page.locator('[data-review-feedback]').click()
  await page.locator('[data-review-direct-correction]').click()
  await expect(page.locator('[data-review-correction]')).toBeVisible()
  await page.locator('[data-review-correction] input[name="meaning"]').fill('苹果（水果）')
  await page.screenshot({
    path: path.join(outputDir, 'review-desktop-1280-correction.png'),
    fullPage: true,
  })
  await page
    .locator('[data-review-correction]')
    .getByRole('button', { name: '保存练习内容' })
    .click()
  await expect(page.locator('[data-review-open-feedback]')).toHaveCount(0)
  await expect(page.locator('[data-review-runner]')).toContainText('苹果（水果）')
  await expect(page.locator('[data-review-approve]')).toBeDisabled()

  await page.locator('form.task-form input').fill('apple')
  await page.getByRole('button', { name: '检查答案' }).click()
  await expect(page.locator('[data-review-approve]')).toBeEnabled()
  await page.locator('[data-review-approve]').click()
  await expect(page).toHaveURL(/\/review\/item-2$/u)
  await expect(page.locator('[data-review-runner]')).toContainText('banana')

  expect(evidence.decisionActions).toEqual(['request_rework', 'correct', 'approve'])
  expect(evidence.appRequests).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('@admin long version keeps blockers and coverage inside bounded scroll regions', async ({
  page,
}) => {
  const width = page.viewportSize()?.width ?? 0
  test.skip(width !== 375 && width !== 1280, 'Long-region geometry is checked at desktop and mobile')

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await installLongVersionDetailFixture(page)
  await page.goto('/admin/source-versions/version-long')

  const blockerScroll = page.locator('[data-scroll-region="publish-blockers"]')
  const matrixScroll = page.locator('[data-scroll-region="coverage-matrix"]')
  await expect(blockerScroll).toBeVisible()
  await expect(matrixScroll).toBeVisible()
  await expect(page.locator('[data-blocker-item]')).toHaveCount(708)
  await expect(page.locator('[data-matrix-row]')).toHaveCount(118)

  const geometry = await page.evaluate(() => {
    const readRegion = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) throw new Error(`Missing region ${selector}`)
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }
    }
    return {
      blocker: readRegion('[data-scroll-region="publish-blockers"]'),
      matrix: readRegion('[data-scroll-region="coverage-matrix"]'),
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }
  })

  expect(geometry.blocker.overflowY).toMatch(/auto|scroll/u)
  expect(geometry.blocker.scrollHeight).toBeGreaterThan(geometry.blocker.clientHeight)
  expect(geometry.blocker.clientHeight).toBeGreaterThanOrEqual(280)
  expect(geometry.blocker.clientHeight).toBeLessThanOrEqual(560)
  expect(geometry.matrix.overflowY).toMatch(/auto|scroll/u)
  expect(geometry.matrix.scrollHeight).toBeGreaterThan(geometry.matrix.clientHeight)
  expect(geometry.matrix.clientHeight).toBeGreaterThanOrEqual(280)
  expect(geometry.matrix.clientHeight).toBeLessThanOrEqual(560)
  expect(geometry.documentHeight).toBeLessThan(width === 1280 ? 1600 : 2500)
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)

  await blockerScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await matrixScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await blockerScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await matrixScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  if (width === 1280) {
    await expect(page.locator('[data-review-actions]')).toBeVisible()
    await expect(page.locator('[data-enter-review]')).toBeVisible()
    await expect(page.locator('[data-approve-all]')).toBeVisible()
  } else {
    await expect(page.locator('[data-compact-readonly]')).toBeVisible()
    await expect(page.locator('[data-review-actions]')).toHaveCount(0)
  }

  await mkdir(outputDir, { recursive: true })
  await page.screenshot({
    path: path.join(
      outputDir,
      width === 1280
        ? 'version-detail-desktop-1280-bounded-regions.png'
        : 'version-detail-mobile-375-bounded-regions.png',
    ),
    fullPage: true,
  })

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

const installReviewFixture = async (page: Page) => {
  const decisionActions: string[] = []
  const appRequests: string[] = []
  let revision = 7
  let itemOneState: 'pending_review' | 'needs_rework' | 'approved' = 'pending_review'
  let itemOneMeaning = '苹果'
  let feedback: { text: string; requestedAt: string } | undefined

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/app/')) appRequests.push(`${request.method()} ${url.pathname}`)
  })

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
      await fulfill({
        id: 'review-admin',
        source: 'application_session',
        displayName: 'Solazhu',
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1') {
      await fulfill({
        sourceId: 'source-1',
        sourceName: '浏览器审阅词库',
        versionId: 'version-1',
        versionNo: 1,
        status: 'draft',
        wordCount: 2,
        groupCount: 1,
        exerciseItemCount: 2,
        approvedItemCount: 0,
        createdAt: '2026-07-17T08:00:00.000Z',
        readyToPublish: false,
        missingItems: [
          {
            word: 'apple',
            stage: 'S2',
            taskType: 'recall_word',
            reason: 'exercise_item_draft',
          },
          {
            word: 'banana',
            stage: 'S2',
            taskType: 'recall_word',
            reason: 'exercise_item_draft',
          },
        ],
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/coverage') {
      await fulfill({
        sourceVersionId: 'version-1',
        wordCount: 2,
        readyToPublish: false,
        cells: [
          {
            wordId: 'word-1',
            word: 'apple',
            stage: 'S2',
            taskType: 'recall_word',
            status: 'draft',
            itemId: 'item-1',
            reason: 'exercise_item_draft',
          },
          {
            wordId: 'word-2',
            word: 'banana',
            stage: 'S2',
            taskType: 'recall_word',
            status: 'draft',
            itemId: 'item-2',
            reason: 'exercise_item_draft',
          },
        ],
        missingItems: [
          {
            word: 'apple',
            stage: 'S2',
            taskType: 'recall_word',
            reason: 'exercise_item_draft',
          },
          {
            word: 'banana',
            stage: 'S2',
            taskType: 'recall_word',
            reason: 'exercise_item_draft',
          },
        ],
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/exercises') {
      await fulfill([
        {
          id: 'item-1',
          sourceVersionId: 'version-1',
          wordId: 'word-1',
          word: 'apple',
          stage: 'S2',
          taskType: 'recall_word',
          prompt: { meaning: itemOneMeaning },
          answer: { word: 'apple' },
          status: itemOneState === 'approved' ? 'approved' : 'draft',
        },
        {
          id: 'item-2',
          sourceVersionId: 'version-1',
          wordId: 'word-2',
          word: 'banana',
          stage: 'S2',
          taskType: 'recall_word',
          prompt: { meaning: '香蕉' },
          answer: { word: 'banana' },
          status: 'draft',
        },
      ])
      return
    }

    if (key === 'GET /api/admin/source-versions/version-1/review') {
      const explicitItemId = url.searchParams.get('itemId')
      const currentId = explicitItemId ?? (itemOneState === 'pending_review' ? 'item-1' : 'item-2')
      const itemOne = {
        id: 'item-1',
        wordId: 'word-1',
        word: 'apple',
        wordOrderIndex: 1,
        position: 1,
        stage: 'S2',
        taskType: 'recall_word',
        status: itemOneState === 'approved' ? 'approved' : 'draft',
        reviewState: itemOneState,
        prompt: { meaning: itemOneMeaning },
        ...(feedback ? { feedback } : {}),
      }
      const itemTwo = {
        id: 'item-2',
        wordId: 'word-2',
        word: 'banana',
        wordOrderIndex: 2,
        position: 2,
        stage: 'S2',
        taskType: 'recall_word',
        status: 'draft',
        reviewState: 'pending_review',
        prompt: { meaning: '香蕉' },
      }
      const current = currentId === 'item-1' ? itemOne : itemTwo

      await fulfill({
        sourceVersionId: 'version-1',
        sourceName: '浏览器审阅词库',
        versionNo: 1,
        contentRevision: revision,
        totalCount: 2,
        approvedCount: itemOneState === 'approved' ? 1 : 0,
        pendingCount: itemOneState === 'pending_review' ? 2 : 1,
        needsReworkCount: itemOneState === 'needs_rework' ? 1 : 0,
        disabledCount: 0,
        allApproved: false,
        firstItemId: 'item-1',
        ...(currentId === 'item-1' ? { nextItemId: 'item-2' } : { previousItemId: 'item-1' }),
        current,
      })
      return
    }

    if (key === 'GET /api/admin/exercise-items/item-1') {
      await fulfill({
        id: 'item-1',
        sourceVersionId: 'version-1',
        wordId: 'word-1',
        word: 'apple',
        stage: 'S2',
        taskType: 'recall_word',
        prompt: { meaning: itemOneMeaning },
        answer: { word: 'apple' },
        status: itemOneState === 'approved' ? 'approved' : 'draft',
      })
      return
    }

    if (key === 'POST /api/admin/exercise-items/item-1/review/evaluate') {
      await fulfill({
        exerciseItemId: 'item-1',
        score: 2,
        correct: true,
        feedback: { taskType: 'recall_word', correctAnswer: 'apple' },
      })
      return
    }

    if (key === 'POST /api/admin/exercise-items/item-1/review/decision') {
      const body = request.postDataJSON() as {
        action: 'request_rework' | 'correct' | 'approve'
        feedback?: string
        content?: { prompt: { meaning: string } }
      }
      decisionActions.push(body.action)
      revision += 1

      if (body.action === 'request_rework') {
        itemOneState = 'needs_rework'
        feedback = {
          text: body.feedback ?? '',
          requestedAt: '2026-07-17T09:00:00.000Z',
        }
        await fulfill({
          exerciseItemId: 'item-1',
          sourceVersionId: 'version-1',
          action: body.action,
          status: 'draft',
          reviewState: itemOneState,
          contentRevision: revision,
        })
        return
      }

      if (body.action === 'correct') {
        itemOneState = 'pending_review'
        itemOneMeaning = body.content?.prompt.meaning ?? itemOneMeaning
        feedback = undefined
        await fulfill({
          exerciseItemId: 'item-1',
          sourceVersionId: 'version-1',
          action: body.action,
          status: 'draft',
          reviewState: itemOneState,
          contentRevision: revision,
        })
        return
      }

      itemOneState = 'approved'
      await fulfill({
        exerciseItemId: 'item-1',
        sourceVersionId: 'version-1',
        action: body.action,
        status: 'approved',
        reviewState: itemOneState,
        contentRevision: revision,
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'not_found', message: `Unhandled review fixture route ${key}` },
      }),
    })
  })

  return { decisionActions, appRequests }
}

const installLongVersionDetailFixture = async (page: Page): Promise<void> => {
  const stageTasks = [
    { stage: 'S0', taskType: 'recognize_meaning' },
    { stage: 'S1', taskType: 'multiple_choice' },
    { stage: 'S2', taskType: 'recall_word' },
    { stage: 'S3', taskType: 'fill_blank' },
    { stage: 'S4', taskType: 'sentence_build' },
    { stage: 'S5', taskType: 'sentence_output' },
  ] as const
  const words = Array.from({ length: 118 }, (_, index) => ({
    id: `long-word-${String(index + 1)}`,
    word: `word-${String(index + 1).padStart(3, '0')}`,
  }))
  const coverageCells = words.flatMap((word) =>
    stageTasks.map((task) => ({
      wordId: word.id,
      word: word.word,
      stage: task.stage,
      taskType: task.taskType,
      status: 'draft' as const,
      itemId: `matrix-${word.id}-${task.stage}`,
      reason: 'exercise_item_draft' as const,
    })),
  )
  const missingItems = coverageCells.map((cell) => ({
    word: cell.word,
    stage: cell.stage,
    taskType: cell.taskType,
    reason: cell.reason,
  }))
  const exerciseItems = coverageCells.map((cell, index) => ({
    id: `long-item-${String(index + 1)}`,
    sourceVersionId: 'version-long',
    wordId: cell.wordId,
    word: cell.word,
    stage: 'S2' as const,
    taskType: 'recall_word' as const,
    prompt: { meaning: `释义 ${String(index + 1)}` },
    answer: { word: cell.word },
    status: 'draft' as const,
  }))

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
      await fulfill({
        id: 'long-version-admin',
        source: 'application_session',
        displayName: 'Solazhu',
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-long') {
      await fulfill({
        sourceId: 'source-long',
        sourceName: '118 词长列表验收词库',
        versionId: 'version-long',
        versionNo: 1,
        status: 'draft',
        wordCount: words.length,
        groupCount: 24,
        exerciseItemCount: exerciseItems.length,
        approvedItemCount: 0,
        createdAt: '2026-07-17T10:00:00.000Z',
        readyToPublish: false,
        missingItems,
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-long/coverage') {
      await fulfill({
        sourceVersionId: 'version-long',
        wordCount: words.length,
        readyToPublish: false,
        cells: coverageCells,
        missingItems,
      })
      return
    }

    if (key === 'GET /api/admin/source-versions/version-long/exercises') {
      await fulfill(exerciseItems)
      return
    }

    if (key === 'GET /api/admin/source-versions/version-long/review') {
      const current = exerciseItems[0]
      await fulfill({
        sourceVersionId: 'version-long',
        sourceName: '118 词长列表验收词库',
        versionNo: 1,
        contentRevision: 1,
        totalCount: exerciseItems.length,
        approvedCount: 0,
        pendingCount: exerciseItems.length,
        needsReworkCount: 0,
        disabledCount: 0,
        allApproved: false,
        firstItemId: current?.id,
        ...(current
          ? {
              current: {
                id: current.id,
                wordId: current.wordId,
                word: current.word,
                wordOrderIndex: 1,
                position: 1,
                stage: current.stage,
                taskType: current.taskType,
                status: current.status,
                reviewState: 'pending_review',
                prompt: current.prompt,
              },
            }
          : {}),
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'not_found', message: `Unhandled long-version fixture route ${key}` },
      }),
    })
  })
}
