import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test'
import { z } from 'zod'
import {
  adminExerciseItemListSchema,
  batchApprovalResultSchema,
  buildCoverageSchema,
  importedSourceVersionSchema,
  publishedSourceVersionSchema,
} from '../../../shared/api/contentSchemas'
import {
  completedLessonSchema,
  createdCourseSchema,
  adminCourseListSchema,
  establishedLearnerSessionSchema,
  lessonReportSchema,
  rotatedAccessCodeSchema,
  restoredLearnerSessionSchema,
  startedLessonSchema,
} from '../../../shared/api/courseSchemas'
import { apiErrorSchema } from '../../../shared/api/schemas'
import { taskAnswerResultSchema } from '../../../shared/api/taskSchemas'
import { generateAdminOperationToken } from '../../../shared/security/adminOperationToken'
import { ADMIN_SESSION_COOKIE_NAME } from '../../../server/security/adminHttpSecurity'

const expectedSentinel = process.env.STACK_DB_SENTINEL
const adminUsername = process.env.STACK_ADMIN_USERNAME
const adminPassword = process.env.STACK_ADMIN_PASSWORD

if (!expectedSentinel || !adminUsername || !adminPassword) {
  throw new Error('STACK_DB_SENTINEL and administrator credentials are required')
}

test('uses only the isolated Worker and D1 identity', async ({ request }) => {
  const response = await request.get('/api/e2e/identity')
  const body: unknown = await response.json()

  expect(response.status()).toBe(200)
  expect(body).toEqual({
    ok: true,
    data: {
      workerName: 'eng-learn-e2e-local',
      environment: 'local-e2e',
      dbSentinel: expectedSentinel,
    },
  })
})

test('establishes and revokes a real D1 administrator session without Access injection', async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected stack base URL')
  await authenticateAdminRequest(request, baseURL)
  const state = await request.storageState()
  const sessionCookie = state.cookies.find(
    (cookie) => cookie.name === ADMIN_SESSION_COOKIE_NAME,
  )
  if (!sessionCookie) throw new Error('Expected an administrator session cookie')

  const active = await request.get('/api/admin/session')
  expect(active.status()).toBe(200)
  const logout = await request.post('/api/admin/auth/logout', {
    headers: { origin: new URL(baseURL).origin },
  })
  expect(logout.status()).toBe(200)
  const replay = await request.get('/api/admin/session', {
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie.value}`,
    },
  })
  expect(replay.status()).toBe(401)
  expect(await failureCode(replay)).toBe('admin_session_revoked')
})

test('enforces response-loss replay, token boundaries, and one-winner rotation in D1', async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected stack base URL')
  await authenticateAdminRequest(request, baseURL)
  const originHeaders = { origin: new URL(baseURL).origin }
  const sourceName = `Lost response ${generateAdminOperationToken().slice(0, 8)}`
  const importCommand = {
    mode: 'new_source' as const,
    operationToken: generateAdminOperationToken(),
    sourceName,
    words: Array.from({ length: 5 }, (_, index) => ({
      word: `lost-word-${String(index + 1)}`,
      meaning: `lost-meaning-${String(index + 1)}`,
      exampleSentence: `I use lost-word-${String(index + 1)} here.`,
    })),
  }

  await request.post('/api/admin/source-versions/import', {
    headers: originHeaders,
    data: importCommand,
  })
  const imported = await success(
    await request.post('/api/admin/source-versions/import', {
      headers: originHeaders,
      data: importCommand,
    }),
    importedSourceVersionSchema,
  )
  const versions = await success(
    await request.get('/api/admin/source-versions'),
    z.array(
      z.looseObject({
        sourceId: z.string(),
        sourceName: z.string(),
        versionId: z.string(),
      }),
    ),
  )
  expect(versions.filter((version) => version.sourceName === sourceName)).toHaveLength(1)

  const payloadConflict = await request.post('/api/admin/source-versions/import', {
    headers: originHeaders,
    data: { ...importCommand, sourceName: `${sourceName} changed` },
  })
  expect(payloadConflict.status()).toBe(409)
  expect(await failureCode(payloadConflict)).toBe('idempotency_conflict')

  await success(
    await request.post(`/api/admin/source-versions/${imported.versionId}/build`, {
      headers: originHeaders,
    }),
    buildCoverageSchema,
  )
  const items = await success(
    await request.get(`/api/admin/source-versions/${imported.versionId}/exercises`),
    adminExerciseItemListSchema,
  )
  await success(
    await request.post('/api/admin/exercise-items/batch-approve', {
      headers: originHeaders,
      data: { itemIds: items.map((item) => item.id) },
    }),
    batchApprovalResultSchema,
  )
  await success(
    await request.post(`/api/admin/source-versions/${imported.versionId}/publish`, {
      headers: originHeaders,
    }),
    publishedSourceVersionSchema,
  )

  const crossKindConflict = await request.post('/api/admin/courses', {
    headers: originHeaders,
    data: {
      operationToken: importCommand.operationToken,
      learnerName: 'Cross-kind learner',
      sourceVersionId: imported.versionId,
    },
  })
  expect(crossKindConflict.status()).toBe(409)
  expect(await failureCode(crossKindConflict)).toBe('idempotency_conflict')

  const courseCommand = {
    operationToken: generateAdminOperationToken(),
    learnerName: `Lost learner ${sourceName.slice(-8)}`,
    sourceVersionId: imported.versionId,
  }
  await request.post('/api/admin/courses', {
    headers: originHeaders,
    data: courseCommand,
  })
  const created = await success(
    await request.post('/api/admin/courses', {
      headers: originHeaders,
      data: courseCommand,
    }),
    createdCourseSchema,
  )
  await success(
    await request.post('/api/app/session/by-code', {
      headers: originHeaders,
      data: { accessCode: created.learner.accessCode },
    }),
    establishedLearnerSessionSchema,
  )

  const rotateCommand = {
    operationToken: generateAdminOperationToken(),
    expectedCredentialVersion: 1,
  }
  const rotatePath = `/api/admin/learners/${created.learner.id}/access-code/rotate`
  await request.post(rotatePath, { headers: originHeaders, data: rotateCommand })
  const rotated = await success(
    await request.post(rotatePath, { headers: originHeaders, data: rotateCommand }),
    rotatedAccessCodeSchema,
  )
  expect(rotated).toMatchObject({ credentialVersion: 2, revokedSessionCount: 1 })

  const concurrentRotations = await Promise.all(
    [generateAdminOperationToken(), generateAdminOperationToken()].map(
      (operationToken) =>
        request.post(rotatePath, {
          headers: originHeaders,
          data: { operationToken, expectedCredentialVersion: 2 },
        }),
    ),
  )
  const winningRotations = concurrentRotations.filter(
    (response) => response.status() === 200,
  )
  const losingRotations = concurrentRotations.filter(
    (response) => response.status() === 409,
  )
  expect(winningRotations).toHaveLength(1)
  expect(losingRotations).toHaveLength(1)
  const winningRotation = winningRotations[0]
  const losingRotation = losingRotations[0]

  if (!winningRotation || !losingRotation) {
    throw new Error('Expected exactly one credential rotation winner and loser')
  }

  const concurrentWinner = await success(winningRotation, rotatedAccessCodeSchema)
  expect(concurrentWinner.credentialVersion).toBe(3)
  expect(await failureCode(losingRotation)).toBe('credential_conflict')

  const courses = await success(
    await request.get('/api/admin/courses'),
    adminCourseListSchema,
  )
  expect(
    courses.courses.filter((entry) => entry.learner.id === created.learner.id),
  ).toEqual([
    expect.objectContaining({
      credentialVersion: 3,
      course: expect.objectContaining({ id: created.course.id }),
    }),
  ])
  const revokedSession = await request.get('/api/app/session')
  expect(revokedSession.status()).toBe(401)
  expect(await failureCode(revokedSession)).toBe('learner_session_revoked')
})

test('production Vue browser closes admin lifecycle and a capped all-wrong learner S0', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected stack base URL')
  await authenticateAdminPage(page)
  const sourceName = 'Browser stack source'
  const csv = [
    'word,meaning,exampleSentence,partOfSpeech',
    ...Array.from(
      { length: 5 },
      (_, index) =>
        `browser-word-${String(index + 1)},browser-meaning-${String(index + 1)},I use browser-word-${String(index + 1)} here.,noun`,
    ),
  ].join('\n')

  await page.goto('/admin/source-versions')
  await expect(page.getByRole('heading', { level: 1, name: '词库版本' })).toBeVisible()
  await page.getByRole('button', { name: '导入词表' }).click()
  await expect(page.locator('form[data-import-form]')).toBeVisible()
  await page.getByLabel('词库名称').fill(sourceName)
  await page.locator('input[name="source-file"]').setInputFiles({
    name: 'browser-stack.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  })
  await expect(page.locator('[data-csv-preview]')).toContainText('预览通过 · 5 个词')
  await page.getByRole('button', { name: '创建草稿版本' }).click()
  await expect(page.getByText('词表导入完成', { exact: true })).toBeVisible()

  const sourceRow = page.getByRole('row').filter({ hasText: sourceName })
  await expect(sourceRow).toContainText('草稿')
  await sourceRow.getByRole('link', { name: '查看详情' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '版本 v1' })).toBeVisible()
  await expect(page.locator('[data-publish]')).toBeDisabled()

  await page.locator('[data-build]').click()
  await expect(
    page.getByText('构建完成，已重新读取服务端覆盖率。', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-select-all]')).toBeVisible()
  await page.locator('[data-select-all]').check()
  await page.locator('[data-approve-selected]').click()
  await expect(
    page.getByText('已批准 30 个练习项目，并重新读取覆盖率。', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-publish]')).toBeEnabled()

  await page.locator('[data-publish]').click()
  await expect(page.locator('[data-inline-confirmation]')).toContainText('确认发布 v1')
  await page.locator('[data-confirm-publish]').click()
  await expect(page.locator('[data-status="published"]')).toContainText('已发布')
  await expect(
    page.getByText('该版本不可原地修改。需要调整内容时创建同一词库的下一草稿版本。', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.locator('[data-build]')).toHaveCount(0)

  await page.goto('/admin/courses')
  await page.getByRole('button', { name: '创建课程' }).click()
  await expect(page.locator('form[data-course-form]')).toBeVisible()
  await page.getByLabel('学习者姓名').fill('Browser learner')
  await expect(page.locator('select[name="source-version-id"]')).toHaveValue(/.+/u)
  await page.getByRole('button', { name: '创建课程并生成学习码' }).click()
  const firstCode = page.locator('[data-one-time-code] code')
  await expect(firstCode).toHaveText(/^[A-Z2-9]{10}$/u)
  const accessCode = (await firstCode.textContent())?.trim()
  if (!accessCode) throw new Error('Browser-created learning code is required')
  await page.getByRole('button', { name: '我已安全记录' }).click()
  await expect(page.locator('[data-one-time-code]')).toHaveCount(0)
  await page.getByRole('button', { name: '创建课程' }).click()
  await expect(page.locator('form[data-course-form]')).toBeVisible()

  const createCommands: unknown[] = []
  let createAttempt = 0
  await page.route('**/api/admin/courses', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }

    createAttempt += 1
    createCommands.push(route.request().postDataJSON())

    if (createAttempt === 1) {
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      await route.abort('failed')
      return
    }

    await route.continue()
  })
  const existingCourse = page.getByRole('row').filter({ hasText: 'Browser learner' })
  await existingCourse.getByRole('button', { name: '轮换学习码' }).click()
  await expect(page.locator('[data-rotate-confirmation]')).toBeVisible()
  await page.getByLabel('学习者姓名').fill('Lost browser learner')
  await page.getByRole('button', { name: '创建课程并生成学习码' }).click()
  await expect(page.locator('[data-unknown-result]')).toContainText('课程可能已经创建')
  await expect(page.locator('[data-rotate-confirmation]')).toHaveCount(0)
  await page.getByRole('button', { name: '安全重试同一次操作' }).click()
  await expect(page.locator('[data-one-time-code]')).toContainText('Lost browser learner')
  expect(createCommands).toHaveLength(2)
  expect(createCommands[1]).toEqual(createCommands[0])
  await page.unroute('**/api/admin/courses')

  await page.goto('/app')
  const accessCodeInput = page.getByLabel('10 位学习码')
  await expect(accessCodeInput).toBeVisible()
  await accessCodeInput.fill(accessCode)
  await page.getByRole('button', { name: '进入课程' }).click()
  await expect(page).toHaveURL(/\/app\/course$/u)
  await expect(page.getByRole('heading', { level: 1, name: '第 1 课' })).toBeVisible()

  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto('/app')
  await expect(page).toHaveURL(/\/app\/course$/u)
  await expect(page.getByLabel('10 位学习码')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: '第 1 课' })).toBeVisible()

  await page.getByRole('button', { name: '开始第 1 课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/[^/]+$/u)
  const answeredWords: string[] = []

  for (let answerIndex = 0; answerIndex < 15; answerIndex += 1) {
    const currentHeading = page.locator('#recognize-word')
    const currentWord = (await currentHeading.textContent())?.trim()

    if (!currentWord) throw new Error(`Expected browser task ${String(answerIndex + 1)}`)
    answeredWords.push(currentWord)
    await page.getByRole('button', { name: '还要学习' }).click()
    await expect(page.getByRole('alert')).toContainText('继续学习')
    await page.getByRole('button', { name: '继续' }).click()

    if (answerIndex === 6) {
      const nextWord = (await page.locator('#recognize-word').textContent())?.trim()

      if (!nextWord) throw new Error('Expected a current task before browser refresh')
      await page.reload()
      await expect(page.locator('#recognize-word')).toHaveText(nextWord)
    }
  }

  const distinctWords = Array.from(new Set(answeredWords))
  expect(distinctWords).toHaveLength(5)
  for (const word of distinctWords) {
    const positions = answeredWords
      .map((candidate, index) => (candidate === word ? index : -1))
      .filter((index) => index >= 0)

    expect(positions).toHaveLength(3)
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1]
      const current = positions[index]

      if (previous === undefined || current === undefined) {
        throw new Error('Expected adjacent browser word positions')
      }
      expect(current - previous - 1).toBeGreaterThanOrEqual(3)
      expect(current - previous - 1).toBeLessThanOrEqual(6)
    }
  }

  await expect(page.getByText('本课任务已答完')).toBeVisible()
  await page.getByRole('button', { name: '完成本课' }).click()
  await expect(page).toHaveURL(/\/app\/lesson\/[^/]+\/report$/u)
  await expect(page.getByText('已完成 15 / 15 道任务。')).toBeVisible()
  await expect(page.getByText('本课正确率：0%')).toBeVisible()
  const practiceWords = await page
    .getByRole('heading', { level: 2, name: '还要再练' })
    .locator('..')
    .getByRole('listitem')
    .allTextContents()
  expect(practiceWords.sort()).toEqual(distinctWords.sort())
})

test('runs admin lifecycle, learner isolation, capped v2 reflux, recovery, and completion', async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected stack base URL')
  await authenticateAdminRequest(request, baseURL)
  const originHeaders = { origin: new URL(baseURL).origin }
  const imported = await success(
    await request.post('/api/admin/source-versions/import', {
      headers: originHeaders,
      data: {
        mode: 'new_source',
        operationToken: generateAdminOperationToken(),
        sourceName: 'Stack E2E source',
        words: Array.from({ length: 5 }, (_, index) => ({
          word: `word-${String(index + 1)}`,
          meaning: `meaning-${String(index + 1)}`,
          exampleSentence: `I use word-${String(index + 1)} here.`,
        })),
      },
    }),
    importedSourceVersionSchema,
  )
  const built = await success(
    await request.post(`/api/admin/source-versions/${imported.versionId}/build`, {
      headers: originHeaders,
    }),
    buildCoverageSchema,
  )
  expect(built.readyToPublish).toBe(false)

  const items = await success(
    await request.get(`/api/admin/source-versions/${imported.versionId}/exercises`),
    adminExerciseItemListSchema,
  )
  expect(items).toHaveLength(30)
  await success(
    await request.post('/api/admin/exercise-items/batch-approve', {
      headers: originHeaders,
      data: { itemIds: items.map((item) => item.id) },
    }),
    batchApprovalResultSchema,
  )
  const coverage = await success(
    await request.get(`/api/admin/source-versions/${imported.versionId}/coverage`),
    buildCoverageSchema,
  )
  expect(coverage.readyToPublish).toBe(true)
  await success(
    await request.post(`/api/admin/source-versions/${imported.versionId}/publish`, {
      headers: originHeaders,
    }),
    publishedSourceVersionSchema,
  )

  const firstCourse = await success(
    await request.post('/api/admin/courses', {
      headers: originHeaders,
      data: {
        operationToken: generateAdminOperationToken(),
        learnerName: 'Alice',
        sourceVersionId: imported.versionId,
      },
    }),
    createdCourseSchema,
  )
  const secondCourse = await success(
    await request.post('/api/admin/courses', {
      headers: originHeaders,
      data: {
        operationToken: generateAdminOperationToken(),
        learnerName: 'Bob',
        sourceVersionId: imported.versionId,
      },
    }),
    createdCourseSchema,
  )
  const established = await success(
    await request.post('/api/app/session/by-code', {
      headers: originHeaders,
      data: { accessCode: firstCourse.learner.accessCode },
    }),
    establishedLearnerSessionSchema,
  )
  expect(established.course.id).toBe(firstCourse.course.id)
  const restored = await success(
    await request.get('/api/app/session'),
    restoredLearnerSessionSchema,
  )
  expect(restored.course.id).toBe(firstCourse.course.id)

  const crossCourse = await request.post(
    `/api/app/courses/${secondCourse.course.id}/lessons/start`,
    { headers: originHeaders },
  )
  expect(crossCourse.status()).toBe(403)
  expect(await failureCode(crossCourse)).toBe('forbidden_resource')

  const lesson = await success(
    await request.post(`/api/app/courses/${firstCourse.course.id}/lessons/start`, {
      headers: originHeaders,
    }),
    startedLessonSchema,
  )
  expect(lesson.tasks).toHaveLength(5)
  let recovered = lesson
  const answeredWordIds: string[] = []

  for (let answerIndex = 0; answerIndex < 15; answerIndex += 1) {
    const current = recovered.tasks.find((task) => task.status === 'pending')

    if (!current) throw new Error(`Expected pending task ${String(answerIndex + 1)}`)
    answeredWordIds.push(current.wordId)
    const wrong = await success(
      await request.post(
        `/api/app/lessons/${lesson.session.id}/tasks/${current.id}/answer`,
        {
          headers: originHeaders,
          data: { taskType: 'recognize_meaning', response: 'learning' },
        },
      ),
      taskAnswerResultSchema,
    )
    expect(wrong).toMatchObject({ taskId: current.id, correct: false })

    const next = await success(
      await request.get(`/api/app/lessons/${lesson.session.id}`),
      startedLessonSchema,
    )

    if (answerIndex === 0) {
      const blocked = await request.post(`/api/app/lessons/${lesson.session.id}/complete`, {
        headers: originHeaders,
      })
      expect(blocked.status()).toBe(409)
      expect(await failureCode(blocked)).toBe('lesson_incomplete')
    }

    if (answerIndex === 6) {
      const refreshed = await success(
        await request.get(`/api/app/lessons/${lesson.session.id}`),
        startedLessonSchema,
      )
      expect(refreshed).toEqual(next)
    }

    recovered = next
  }

  expect(recovered.tasks).toHaveLength(15)
  expect(recovered.tasks.every((task) => task.status === 'completed')).toBe(true)
  expect(recovered.session.completedTaskCount).toBe(15)
  expect(answeredWordIds).toEqual(recovered.tasks.map((task) => task.wordId))

  const wordIds = Array.from(new Set(answeredWordIds))
  expect(wordIds).toHaveLength(5)
  for (const wordId of wordIds) {
    const positions = recovered.tasks
      .map((task, index) => (task.wordId === wordId ? index : -1))
      .filter((index) => index >= 0)

    expect(positions).toHaveLength(3)
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1]
      const current = positions[index]

      if (previous === undefined || current === undefined) {
        throw new Error('Expected adjacent same-word positions')
      }
      expect(current - previous - 1).toBeGreaterThanOrEqual(3)
      expect(current - previous - 1).toBeLessThanOrEqual(6)
    }
  }

  const completed = await success(
    await request.post(`/api/app/lessons/${lesson.session.id}/complete`, {
      headers: originHeaders,
    }),
    completedLessonSchema,
  )
  const completionRetry = await success(
    await request.post(`/api/app/lessons/${lesson.session.id}/complete`, {
      headers: originHeaders,
    }),
    completedLessonSchema,
  )
  expect(completed.course.currentLessonNo).toBe(2)
  expect(completionRetry).toEqual(completed)

  const report = await success(
    await request.get(`/api/app/lessons/${lesson.session.id}/report`, {
      headers: originHeaders,
    }),
    lessonReportSchema,
  )
  expect(report).toMatchObject({
    lessonNo: 1,
    completedTaskCount: 15,
    totalTaskCount: 15,
    nextLessonNo: 2,
    courseStatus: 'active',
  })
  expect(report.needsPracticeWords.map((word) => word.id).sort()).toEqual(wordIds.sort())
})

const success = async <TSchema extends z.ZodType>(
  response: APIResponse,
  schema: TSchema,
): Promise<z.output<TSchema>> => {
  expect(response.status()).toBe(200)
  const envelope = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .strict()
    .parse(await response.json())
  const data: z.output<TSchema> = schema.parse(envelope.data)

  return data
}

const failureCode = async (response: APIResponse): Promise<string> => {
  const envelope = z
    .object({ ok: z.literal(false), error: apiErrorSchema })
    .strict()
    .parse(await response.json())

  return envelope.error.code
}

const authenticateAdminRequest = async (
  request: APIRequestContext,
  baseURL: string,
): Promise<void> => {
  const response = await request.post('/api/admin/auth/login', {
    headers: { origin: new URL(baseURL).origin },
    data: { username: adminUsername, password: adminPassword },
  })
  expect(response.status()).toBe(200)
}

const authenticateAdminPage = async (page: Page): Promise<void> => {
  await page.goto('/admin/login')
  await expect(page.getByRole('heading', { level: 1, name: '管理员登录' })).toBeVisible()
  await page.getByLabel('账号').fill(adminUsername)
  await page.getByLabel('密码').fill(adminPassword)
  await page.getByRole('button', { name: '登录管理台' }).click()
  await expect(page).toHaveURL(/\/admin\/source-versions$/u)
}
