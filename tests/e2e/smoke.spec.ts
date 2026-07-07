import { expect, test } from '@playwright/test'

test('admin and learner entry points render', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: '管理员工作台' })).toBeVisible()

  await page.goto('/app')
  await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible()
})

