import { defineConfig } from '@playwright/test'

const baseURL = process.env.STACK_BASE_URL
const outputDir = process.env.STACK_OUTPUT_DIR

if (!baseURL || !outputDir) {
  throw new Error('STACK_BASE_URL and STACK_OUTPUT_DIR are required')
}

export default defineConfig({
  testDir: './tests/e2e/stack',
  outputDir,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
