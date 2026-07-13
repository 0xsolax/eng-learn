import { defineConfig, type Project } from '@playwright/test'

const learnerProjects: Project[] = [
  { name: 'learner-320', use: { viewport: { width: 320, height: 568 } } },
  { name: 'learner-375', use: { viewport: { width: 375, height: 812 } } },
  { name: 'learner-768', use: { viewport: { width: 768, height: 1024 } } },
  { name: 'learner-1280', use: { viewport: { width: 1280, height: 800 } } },
].map((project) => ({ ...project, grep: /@learner/ }))

const adminProjects: Project[] = [
  { name: 'admin-375', use: { viewport: { width: 375, height: 812 } } },
  { name: 'admin-768', use: { viewport: { width: 768, height: 1024 } } },
  { name: 'admin-1024', use: { viewport: { width: 1024, height: 768 } } },
  { name: 'admin-1280', use: { viewport: { width: 1280, height: 800 } } },
  { name: 'admin-1440', use: { viewport: { width: 1440, height: 900 } } },
].map((project) => ({ ...project, grep: /@admin/ }))

const controlProjects: Project[] = [
  { name: 'controls-375', use: { viewport: { width: 375, height: 812 } } },
  { name: 'controls-1280', use: { viewport: { width: 1280, height: 800 } } },
].map((project) => ({ ...project, grep: /@controls/ }))

const rendererProjects: Project[] = [
  { name: 'renderers-375', use: { viewport: { width: 375, height: 812 } } },
  { name: 'renderers-1280', use: { viewport: { width: 1280, height: 800 } } },
].map((project) => ({ ...project, grep: /@renderers/ }))

export default defineConfig({
  testDir: './tests/e2e/ui',
  outputDir: './test-results/ui',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [...learnerProjects, ...adminProjects, ...controlProjects, ...rendererProjects],
  webServer: {
    command:
      'pnpm exec vite --config vite.ui.config.ts --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
