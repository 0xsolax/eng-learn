import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { installMockedLearnerApiRouteFixture } from './fixtures/learnerApiRouteFixture'

const expectNoSeriousViolations = async (page: Page): Promise<void> => {
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

test('@controls exposes no serious or critical automated accessibility violations', async ({
  page,
}) => {
  await page.goto('/tests/e2e/ui/fixtures/basic-controls.html')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await expectNoSeriousViolations(page)
})

test('@renderers exposes no serious or critical automated accessibility violations', async ({
  page,
}) => {
  await page.goto('/tests/e2e/ui/fixtures/task-renderers.html')
  await expect(page.locator('[data-renderer]')).toHaveCount(6)

  await expectNoSeriousViolations(page)
})

test('@learner production routes expose no serious or critical automated accessibility violations', async ({
  page,
}) => {
  await installMockedLearnerApiRouteFixture(page)
  await page.goto('/app')
  await expect(page.getByRole('heading', { level: 1, name: '进入你的课程' })).toBeVisible()
  await expectNoSeriousViolations(page)

  await page.getByLabel('学习账号').fill('xiaolin')
  await page.getByLabel('6 位 PIN').fill('123456')
  await page.getByRole('button', { name: '进入课程' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课' })).toBeVisible()
  await expectNoSeriousViolations(page)

  await page.getByRole('button', { name: '继续第 7 课' }).click()
  await expect(page.getByLabel('apple')).toBeVisible()
  await expectNoSeriousViolations(page)

  await page.getByLabel('apple').check()
  await page.getByRole('button', { name: '检查答案' }).click()
  await expect(page.getByRole('status')).toContainText('参考答案：apple')
  await expectNoSeriousViolations(page)

  await page.getByRole('button', { name: '继续' }).click()
  await expect(page.getByRole('button', { name: '完成本课' })).toBeVisible()
  await expectNoSeriousViolations(page)

  await page.getByRole('button', { name: '完成本课' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '第 7 课完成' })).toBeVisible()
  await expectNoSeriousViolations(page)
})
