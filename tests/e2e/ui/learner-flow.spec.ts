import { expect, test } from '@playwright/test'
import { installMockedLearnerApiRouteFixture } from './fixtures/learnerApiRouteFixture'

test('@learner [mocked route fixture] closes code → course → lesson → report', async ({ page }) => {
  await installMockedLearnerApiRouteFixture(page)
  await page.goto('/app')

  await page.getByLabel('10 位学习码').fill('ABCDEFGH23')
  await page.getByRole('button', { name: '进入课程' }).click()
  await expect(page).toHaveURL(/\/app\/course$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课' })).toBeVisible()
  await expect(page.getByText('1 个新词 · 0 个复习词')).toBeVisible()

  await page.getByRole('button', { name: '继续第 7 课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-7$/u)
  await page.getByLabel('写出英文单词').fill('apple')
  await page.getByRole('button', { name: '检查答案' }).click()
  await expect(page.getByRole('status')).toContainText('参考答案：apple')

  const continueAction = page.getByRole('button', { name: '继续' })
  await expect(continueAction).toBeFocused()

  await continueAction.click()
  const completeAction = page.getByRole('button', { name: '完成本课' })
  await expect(completeAction).toBeFocused()
  await completeAction.click()
  await expect(page).toHaveURL(/\/app\/lesson\/session-7\/report$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课完成' })).toBeVisible()
  await expect(page.getByText('本课正确率：100%')).toBeVisible()
  await expect(page.getByText('apple')).toBeVisible()

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
