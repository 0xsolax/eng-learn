import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'
import {
  installCappedWrongAnswerLearnerFixture,
  installMockedLearnerApiRouteFixture,
} from './fixtures/learnerApiRouteFixture'

const isExpectedSessionProbeError = (message: ConsoleMessage): boolean => {
  if (message.text() !== 'Failed to load resource: the server responded with a status of 401 (Unauthorized)') {
    return false
  }

  try {
    return new URL(message.location().url).pathname === '/api/app/session'
  } catch {
    return false
  }
}

const observePageErrors = (page: Page): (() => void) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && !isExpectedSessionProbeError(message)) {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  return () => {
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  }
}

const enterCourse = async (page: Page): Promise<void> => {
  await page.getByLabel('学习账号').fill('xiaolin')
  await page.getByLabel('6 位 PIN').fill('123456')
  await page.getByRole('button', { name: '进入课程' }).click()
}

test('@learner [mocked route fixture] closes account → course → lesson → report', async ({ page }) => {
  const expectNoPageErrors = observePageErrors(page)
  await installMockedLearnerApiRouteFixture(page)
  await page.goto('/app')

  await enterCourse(page)
  await expect(page).toHaveURL(/\/app\/course$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课' })).toBeVisible()
  await expect(page.getByText('1 个新词 · 0 个复习词')).toBeVisible()

  await page.getByRole('button', { name: '继续第 7 课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-7$/u)
  await page.getByLabel('apple').check()
  const correctSoundResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/sounds/answer-feedback-correct.wav',
  )
  await page.getByRole('button', { name: '检查答案' }).click()
  const correctSound = await correctSoundResponse
  expect(correctSound.ok()).toBe(true)
  expect(correctSound.headers()['content-type']).toContain('audio')
  await expect(page.getByRole('status')).toContainText('参考答案：apple')

  const continueAction = page.getByRole('button', { name: '继续' })
  await expect(continueAction).toBeFocused()

  await continueAction.click()
  const completeAction = page.getByRole('button', { name: '完成本课' })
  await expect(completeAction).toBeFocused()
  await completeAction.click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-7\/report$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课完成' })).toBeVisible()
  await expect(page.getByText('核心任务正确率：100%')).toBeVisible()
  await expect(page.getByText('apple')).toBeVisible()

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
  expectNoPageErrors()
})

test('@learner [mocked route fixture] reselects a completed lesson without moving formal progress', async ({
  page,
}) => {
  const expectNoPageErrors = observePageErrors(page)
  await installMockedLearnerApiRouteFixture(page)
  await page.goto('/app')

  await enterCourse(page)
  await expect(page.getByRole('heading', { level: 2, name: '选择已完成课时重新练习' })).toBeVisible()

  await page.getByRole('button', { name: '第 6 课，再练一次' }).click()
  await expect(page).toHaveURL(/\/app\/replay\/replay-6$/u)
  await expect(page.getByText('重复练习', { exact: true })).toBeVisible()
  await page.getByLabel('apple').check()
  const replayCorrectSoundResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/sounds/answer-feedback-correct.wav',
  )
  await page.getByRole('button', { name: '检查答案' }).click()
  const replayCorrectSound = await replayCorrectSoundResponse
  expect(replayCorrectSound.ok()).toBe(true)
  expect(replayCorrectSound.headers()['content-type']).toContain('audio')
  await expect(page.getByRole('status')).toContainText('参考答案：apple')
  await page.getByRole('button', { name: '继续' }).click()
  await page.getByRole('button', { name: '完成重复练习' }).click()
  await expect(page.getByText('本次答对 1 / 1 道')).toBeVisible()
  await page.getByRole('button', { name: '返回课程' }).click()

  await expect(page).toHaveURL(/\/app\/course$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 6 课，再练一次' })).toBeVisible()
  expectNoPageErrors()
})

test('@learner [mocked route fixture] finishes fifteen capped wrong answers across refresh', async ({
  page,
}) => {
  const expectNoPageErrors = observePageErrors(page)
  const fixture = await installCappedWrongAnswerLearnerFixture(page)
  await page.goto('/app')

  await enterCourse(page)
  await page.getByRole('button', { name: '继续第 7 课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-cap$/u)
  const wrongSoundResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/sounds/answer-feedback-wrong.wav',
  )

  for (const [index, word] of fixture.wordSequence.entries()) {
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(word)
    await page.getByRole('button', { name: '还要学习' }).click()
    await expect(page.getByRole('alert')).toContainText('继续学习')
    if (index === 0) {
      const wrongSound = await wrongSoundResponse
      expect(wrongSound.ok()).toBe(true)
      expect(wrongSound.headers()['content-type']).toContain('audio')
    }
    await page.getByRole('button', { name: '继续' }).click()

    if (index === 6) {
      const nextWord = fixture.wordSequence[index + 1]

      if (!nextWord) throw new Error('Expected a task after the refresh checkpoint')
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(nextWord)
      await page.reload()
      await expect(page).toHaveURL(/\/app\/lesson\/session-cap$/u)
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(nextWord)
    }
  }

  await expect(page.getByText('本课任务已答完')).toBeVisible()
  await page.getByRole('button', { name: '完成本课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-cap\/report$/u)
  await expect(page.getByText('已完成 15 / 15 道任务。')).toBeVisible()
  await expect(page.getByText('核心任务正确率：0%')).toBeVisible()
  const practiceSection = page
    .getByRole('heading', { level: 2, name: '还要再练' })
    .locator('..')

  await expect(practiceSection.getByRole('listitem')).toHaveText(fixture.practiceWords)
  expectNoPageErrors()
})
