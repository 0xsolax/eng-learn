<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SourceVersionSummaryDto } from '@shared/api/contentSchemas'
import type { AdminCourseListDto } from '@shared/api/courseSchemas'
import { generateAdminOperationToken } from '@shared/security/adminOperationToken'
import { createAdminApi } from '@/api/adminApi'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'

type AdminCoursesWorkspaceApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'createCourse'
  | 'listCourses'
  | 'listSourceVersions'
  | 'updateLearnerLogin'
> & Partial<Pick<ReturnType<typeof createAdminApi>, 'resetCourseProgress'>>
type CourseEntry = AdminCourseListDto['courses'][number]
type PageState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'creating' | 'updating' | 'resetting'
type CreateCommand = Parameters<AdminCoursesWorkspaceApi['createCourse']>[0]
type UpdateCommand = Parameters<AdminCoursesWorkspaceApi['updateLearnerLogin']>[1]
type ResetCommand = Parameters<NonNullable<AdminCoursesWorkspaceApi['resetCourseProgress']>>[1]
type PendingOperation =
  | { kind: 'create'; command: CreateCommand }
  | { kind: 'update'; learnerId: string; learnerName: string; command: UpdateCommand }
  | { kind: 'reset'; courseId: string; learnerName: string; command: ResetCommand }

const props = defineProps<{ api?: AdminCoursesWorkspaceApi }>()
const api = props.api ?? createAdminApi()
const pageState = ref<PageState>('loading')
const actionState = ref<ActionState>('idle')
const courses = ref<CourseEntry[]>([])
const versions = ref<SourceVersionSummaryDto[]>([])
const learnerName = ref('')
const loginAccount = ref('')
const loginPin = ref('')
const sourceVersionId = ref('')
const actionError = ref('')
const actionSuccess = ref<string>()
const pendingOperation = ref<PendingOperation | null>(null)
const resultUnknown = ref(false)
const showCreateForm = ref(false)
const editTarget = ref<CourseEntry | null>(null)
const editLoginAccount = ref('')
const editLoginPin = ref('')
const resetTarget = ref<CourseEntry | null>(null)
const isMobileReadonly = ref(false)
let resetTrigger: HTMLElement | null = null

const publishedVersions = computed(() =>
  versions.value.filter((version) => version.status === 'published'),
)

const canCreate = computed(
  () =>
    !isMobileReadonly.value &&
    actionState.value === 'idle' &&
    pendingOperation.value === null &&
    learnerName.value.trim().length > 0 &&
    loginAccount.value.trim().length >= 3 &&
    /^\d{6}$/u.test(loginPin.value) &&
    sourceVersionId.value.length > 0,
)

const canUpdateLogin = computed(() => {
  if (!editTarget.value || actionState.value !== 'idle' || pendingOperation.value) {
    return false
  }
  if (editLoginAccount.value.trim().length < 3) return false
  if (editLoginPin.value.length > 0 && !/^\d{6}$/u.test(editLoginPin.value)) return false
  return Boolean(editTarget.value.learner.loginAccount) || /^\d{6}$/u.test(editLoginPin.value)
})

const versionNames = computed(
  () =>
    new Map(
      versions.value.map((version) => [
        version.versionId,
        `${version.sourceName} · v${String(version.versionNo)}`,
      ]),
    ),
)

const loadWorkspace = async (): Promise<void> => {
  pageState.value = 'loading'
  actionError.value = ''
  try {
    const [courseList, sourceVersions] = await Promise.all([
      api.listCourses(),
      api.listSourceVersions(),
    ])
    courses.value = courseList.courses
    versions.value = sourceVersions
    sourceVersionId.value = publishedVersions.value[0]?.versionId ?? ''
    showCreateForm.value = !isMobileReadonly.value && courses.value.length === 0
    pageState.value = 'ready'
  } catch {
    courses.value = []
    versions.value = []
    pageState.value = 'error'
  }
}

const createCourse = async (): Promise<void> => {
  if (!canCreate.value) return
  const operation: PendingOperation = {
    kind: 'create',
    command: {
      operationToken: generateAdminOperationToken(),
      learnerName: learnerName.value,
      loginAccount: loginAccount.value,
      pin: loginPin.value,
      sourceVersionId: sourceVersionId.value,
    },
  }
  pendingOperation.value = operation
  loginPin.value = ''
  await executeCreate(operation)
}

const executeCreate = async (
  operation: Extract<PendingOperation, { kind: 'create' }>,
): Promise<void> => {
  actionState.value = 'creating'
  actionError.value = ''
  actionSuccess.value = undefined
  resultUnknown.value = false
  try {
    const created = await api.createCourse(operation.command)
    actionSuccess.value = `${created.learner.name} 的课程已创建，学习账号为 ${created.learner.loginAccount}。`
    learnerName.value = ''
    loginAccount.value = ''
    showCreateForm.value = false
    pendingOperation.value = null
    courses.value = (await api.listCourses()).courses
  } catch (error) {
    if (isUnknownResult(error)) {
      resultUnknown.value = true
      return
    }
    pendingOperation.value = null
    actionError.value =
      error instanceof ApiFailureError && error.code === 'login_account_unavailable'
        ? '学习账号已被占用，请更换后重试。'
        : error instanceof ApiFailureError && error.code === 'conflict'
          ? '课程创建冲突，请重新读取工作台确认。'
          : '课程创建未完成；请检查输入后重试。'
  } finally {
    actionState.value = 'idle'
  }
}

const openLoginEditor = async (entry: CourseEntry): Promise<void> => {
  if (isMobileReadonly.value || actionState.value !== 'idle' || pendingOperation.value) return
  resetTarget.value = null
  editTarget.value = entry
  editLoginAccount.value = entry.learner.loginAccount ?? ''
  editLoginPin.value = ''
  actionError.value = ''
  await nextTick()
  document.querySelector<HTMLInputElement>('input[name="edit-login-account"]')?.focus()
}

const closeLoginEditor = (): void => {
  editTarget.value = null
  editLoginPin.value = ''
}

const updateLogin = async (): Promise<void> => {
  if (!editTarget.value || !canUpdateLogin.value) return
  const target = editTarget.value
  const operation: PendingOperation = {
    kind: 'update',
    learnerId: target.learner.id,
    learnerName: target.learner.name,
    command: {
      operationToken: generateAdminOperationToken(),
      expectedCredentialVersion: target.credentialVersion,
      loginAccount: editLoginAccount.value,
      ...(editLoginPin.value ? { pin: editLoginPin.value } : {}),
    },
  }
  pendingOperation.value = operation
  editLoginPin.value = ''
  await executeLoginUpdate(operation)
}

const executeLoginUpdate = async (
  operation: Extract<PendingOperation, { kind: 'update' }>,
): Promise<void> => {
  actionState.value = 'updating'
  actionError.value = ''
  actionSuccess.value = undefined
  resultUnknown.value = false
  try {
    const updated = await api.updateLearnerLogin(operation.learnerId, operation.command)
    courses.value = courses.value.map((entry) =>
      entry.learner.id === operation.learnerId
        ? {
            ...entry,
            learner: { ...entry.learner, loginAccount: updated.loginAccount },
            credentialVersion: updated.credentialVersion,
          }
        : entry,
    )
    if (editTarget.value?.learner.id === operation.learnerId) {
      editTarget.value = courses.value.find(
        (entry) => entry.learner.id === operation.learnerId,
      ) ?? null
      editLoginAccount.value = updated.loginAccount
    }
    actionSuccess.value = `${operation.learnerName} 的登录信息已更新；${String(updated.revokedSessionCount)} 个旧会话已失效。`
    pendingOperation.value = null
  } catch (error) {
    if (isUnknownResult(error)) {
      resultUnknown.value = true
      return
    }
    pendingOperation.value = null
    actionError.value =
      error instanceof ApiFailureError && error.code === 'login_account_unavailable'
        ? '学习账号已被占用，请更换后重试。'
        : error instanceof ApiFailureError && error.code === 'credential_conflict'
          ? '登录信息版本已变化，请重新读取工作台后再修改。'
          : error instanceof ApiFailureError && error.code === 'idempotency_conflict'
            ? '本次操作令牌对应的参数不一致，请重新读取工作台后重试。'
          : error instanceof ApiFailureError && error.code === 'operation_superseded'
            ? '本次修改已被后续操作替代，请重新读取工作台。'
            : '登录信息修改未完成，请确认服务端状态后重试。'
  } finally {
    editLoginPin.value = ''
    actionState.value = 'idle'
  }
}

const openResetConfirmation = (entry: CourseEntry, event: MouseEvent): void => {
  if (!api.resetCourseProgress || isMobileReadonly.value || pendingOperation.value) return
  editTarget.value = null
  resetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  resetTarget.value = entry
}

const closeResetConfirmation = async (): Promise<void> => {
  resetTarget.value = null
  await nextTick()
  resetTrigger?.focus()
}

const resetProgress = async (): Promise<void> => {
  if (!resetTarget.value || !api.resetCourseProgress || pendingOperation.value) return
  const target = resetTarget.value
  const operation: PendingOperation = {
    kind: 'reset',
    courseId: target.course.id,
    learnerName: target.learner.name,
    command: {
      operationToken: generateAdminOperationToken(),
      expectedLearningRunNo: target.learningRunNo,
      expectedCurrentLessonNo: target.course.currentLessonNo,
    },
  }
  pendingOperation.value = operation
  resetTarget.value = null
  await executeReset(operation)
}

const executeReset = async (
  operation: Extract<PendingOperation, { kind: 'reset' }>,
): Promise<void> => {
  if (!api.resetCourseProgress) return
  actionState.value = 'resetting'
  actionError.value = ''
  actionSuccess.value = undefined
  resultUnknown.value = false
  try {
    const reset = await api.resetCourseProgress(operation.courseId, operation.command)
    courses.value = courses.value.map((entry) =>
      entry.course.id === operation.courseId
        ? { ...entry, course: reset.course, learningRunNo: reset.learningRunNo }
        : entry,
    )
    actionSuccess.value = `${operation.learnerName} 已从第 1 课重新开始；原学习记录和登录账号保持不变。`
    pendingOperation.value = null
  } catch (error) {
    if (isUnknownResult(error)) {
      resultUnknown.value = true
      return
    }
    pendingOperation.value = null
    actionError.value =
      error instanceof ApiFailureError && error.code === 'progress_conflict'
        ? '学习进度已变化，请重新读取工作台后再操作。'
        : '重新学习未完成，请重新读取工作台确认服务端状态。'
  } finally {
    actionState.value = 'idle'
  }
}

const retryUnknownOperation = async (): Promise<void> => {
  if (!resultUnknown.value || actionState.value !== 'idle' || !pendingOperation.value) return
  if (pendingOperation.value.kind === 'create') await executeCreate(pendingOperation.value)
  else if (pendingOperation.value.kind === 'update') {
    await executeLoginUpdate(pendingOperation.value)
  } else await executeReset(pendingOperation.value)
}

const unknownResultMessage = computed(() =>
  pendingOperation.value?.kind === 'update'
    ? '结果未知：登录信息可能已经变更。请安全重试同一次操作，不要生成新的操作令牌。'
    : pendingOperation.value?.kind === 'reset'
      ? '结果未知：学习轮次可能已经重置。请安全重试同一次操作。'
      : '结果未知：课程可能已经创建。请安全重试同一次操作。',
)

const isUnknownResult = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  error instanceof InvalidApiResponseError ||
  (error instanceof ApiFailureError &&
    (error.code === 'dependency_failure' || error.code === 'internal_error'))

const courseStatusLabel = (status: CourseEntry['course']['status']): string =>
  ({ active: '学习中', paused: '已暂停', completed: '已完成' })[status]

const toggleCreateForm = (): void => {
  if (!isMobileReadonly.value) showCreateForm.value = !showCreateForm.value
}

const syncViewport = (): void => {
  isMobileReadonly.value = window.innerWidth < 480
  if (isMobileReadonly.value) {
    showCreateForm.value = false
    editTarget.value = null
    resetTarget.value = null
  }
}

onMounted(() => {
  syncViewport()
  window.addEventListener('resize', syncViewport)
  void loadWorkspace()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport)
})
</script>

<template>
  <section class="admin-page page-enter">
    <UiStatusMessage
      v-if="pageState === 'loading'"
      tone="info"
      title="正在读取课程工作台"
    >
      同步课程列表和可绑定的已发布词库版本。
    </UiStatusMessage>

    <div
      v-else-if="pageState === 'error'"
      class="error-actions"
    >
      <UiStatusMessage
        tone="error"
        title="无法读取课程工作台"
      >
        不显示部分课程或版本数据，请完整重试。
      </UiStatusMessage>
      <UiButton
        variant="secondary"
        @click="loadWorkspace"
      >
        重新读取
      </UiButton>
    </div>

    <template v-else>
      <header class="page-heading">
        <div>
          <p>学习者与课程</p>
          <h1>课程工作台</h1>
          <span>创建课程时分配学习账号；修改登录信息不会改变学习历史。</span>
        </div>
        <UiButton
          v-if="!isMobileReadonly"
          data-toggle-create
          :variant="showCreateForm ? 'secondary' : 'primary'"
          :aria-expanded="String(showCreateForm)"
          aria-controls="create-course-region"
          @click="toggleCreateForm"
        >
          {{ showCreateForm ? '收起创建区' : '创建课程' }}
        </UiButton>
      </header>

      <UiStatusMessage
        v-if="isMobileReadonly"
        data-mobile-readonly
        tone="info"
        title="当前视口仅支持查看"
      >
        请使用至少 480px 宽的设备创建课程、修改登录信息或重新学习。
      </UiStatusMessage>

      <UiStatusMessage
        v-if="actionError"
        tone="error"
        title="课程操作未完成"
      >
        {{ actionError }}
      </UiStatusMessage>

      <UiStatusMessage
        v-if="actionSuccess"
        data-action-success
        tone="success"
        title="课程操作已完成"
      >
        {{ actionSuccess }}
      </UiStatusMessage>

      <UiStatusMessage
        v-if="resultUnknown && pendingOperation"
        data-unknown-result
        tone="error"
        title="课程操作结果未知"
      >
        <p>{{ unknownResultMessage }}</p>
        <UiButton
          v-if="!isMobileReadonly"
          data-retry-unknown
          variant="secondary"
          :loading="actionState !== 'idle'"
          @click="retryUnknownOperation"
        >
          安全重试同一次操作
        </UiButton>
      </UiStatusMessage>

      <section
        class="courses"
        aria-labelledby="courses-title"
      >
        <header class="section-heading">
          <div>
            <h2 id="courses-title">
              已有课程
            </h2>
            <p>学习账号可以修改；PIN 和学习码不会出现在列表中。</p>
          </div>
          <span>{{ courses.length }} 门课程</span>
        </header>

        <div
          v-if="courses.length === 0"
          class="empty-state"
        >
          <h3>还没有课程</h3>
          <p>使用创建表单建立第一门学习者课程。</p>
        </div>

        <div
          v-else
          data-scroll-region="courses"
          class="table-scroll"
          tabindex="0"
          aria-label="课程列表表格"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">
                  学习者
                </th>
                <th scope="col">
                  词库版本
                </th>
                <th
                  scope="col"
                  class="numeric"
                >
                  当前课时
                </th>
                <th scope="col">
                  状态
                </th>
                <th
                  v-if="!isMobileReadonly"
                  scope="col"
                >
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in courses"
                :key="entry.course.id"
              >
                <th scope="row">
                  <span class="learner-name">{{ entry.learner.name }}</span>
                  <span class="learner-account">
                    {{ entry.learner.loginAccount ?? '待设置' }}
                  </span>
                </th>
                <td>{{ versionNames.get(entry.course.sourceVersionId) ?? '版本信息不可用' }}</td>
                <td class="numeric">
                  第 {{ entry.course.currentLessonNo }} 课 · 第 {{ entry.learningRunNo }} 轮
                </td>
                <td>
                  <span
                    class="status-badge"
                    :data-status="entry.course.status"
                  >
                    {{ courseStatusLabel(entry.course.status) }}
                  </span>
                </td>
                <td v-if="!isMobileReadonly">
                  <div class="course-actions">
                    <UiButton
                      data-edit-login
                      variant="secondary"
                      :disabled="actionState !== 'idle' || pendingOperation !== null"
                      @click="openLoginEditor(entry)"
                    >
                      {{ entry.learner.loginAccount ? '修改登录' : '设置学习账号' }}
                    </UiButton>
                    <UiButton
                      v-if="api.resetCourseProgress"
                      data-reset-progress
                      variant="secondary"
                      :disabled="actionState !== 'idle' || pendingOperation !== null"
                      @click="openResetConfirmation(entry, $event)"
                    >
                      重新学习
                    </UiButton>
                  </div>

                  <Transition name="inline-reveal">
                    <form
                      v-if="editTarget?.learner.id === entry.learner.id"
                      data-login-form
                      class="inline-editor"
                      @submit.prevent="updateLogin"
                    >
                      <UiInput
                        v-model="editLoginAccount"
                        name="edit-login-account"
                        label="学习账号"
                        maxlength="32"
                        autocomplete="username"
                        :disabled="actionState === 'updating'"
                      />
                      <UiInput
                        v-model="editLoginPin"
                        name="edit-login-pin"
                        type="password"
                        label="新 PIN"
                        :hint="entry.learner.loginAccount ? '留空则保留当前 PIN' : '首次设置必须填写 6 位 PIN'"
                        maxlength="6"
                        inputmode="numeric"
                        autocomplete="new-password"
                        :disabled="actionState === 'updating'"
                      />
                      <div class="inline-editor__actions">
                        <UiButton
                          variant="secondary"
                          @click="closeLoginEditor"
                        >
                          取消
                        </UiButton>
                        <UiButton
                          data-submit-login
                          type="submit"
                          :disabled="!canUpdateLogin"
                          :loading="actionState === 'updating'"
                        >
                          保存登录信息
                        </UiButton>
                      </div>
                    </form>
                  </Transition>

                  <section
                    v-if="resetTarget?.course.id === entry.course.id"
                    data-reset-confirmation
                    class="inline-confirmation"
                    tabindex="-1"
                  >
                    <h2>确认让 {{ entry.learner.name }} 重新学习</h2>
                    <p>保留全部历史记录和登录信息；当前未完成课时会结束，并从第 1 课开始新一轮学习。</p>
                    <div>
                      <UiButton
                        variant="secondary"
                        @click="closeResetConfirmation"
                      >
                        取消
                      </UiButton>
                      <UiButton
                        data-confirm-reset
                        :loading="actionState === 'resetting'"
                        @click="resetProgress"
                      >
                        确认重新学习
                      </UiButton>
                    </div>
                  </section>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        v-if="showCreateForm && !isMobileReadonly"
        id="create-course-region"
        class="create-course"
        aria-labelledby="create-course-title"
      >
        <header class="section-heading">
          <div>
            <h2 id="create-course-title">
              创建学习者课程
            </h2>
            <p>账号由管理员分配；PIN 只用于本次创建请求，不会再次显示。</p>
          </div>
        </header>

        <UiStatusMessage
          v-if="publishedVersions.length === 0"
          data-no-published
          tone="info"
          title="暂无可绑定版本"
        >
          先发布一个词库版本，再创建课程。
          <a
            data-source-workbench-link
            href="/admin/source-versions"
          >前往词库工作台</a>
        </UiStatusMessage>

        <form
          data-course-form
          class="course-form"
          @submit.prevent="createCourse"
        >
          <UiInput
            v-model="learnerName"
            name="learner-name"
            maxlength="80"
            label="学习者姓名"
            hint="只填写学习所需的最小称呼。"
            :disabled="actionState === 'creating'"
          />
          <UiInput
            v-model="loginAccount"
            name="login-account"
            maxlength="32"
            label="学习账号"
            hint="3-32 位，可使用字母、数字、点、下划线和短横线。"
            autocomplete="username"
            :disabled="actionState === 'creating'"
          />
          <UiInput
            v-model="loginPin"
            name="login-pin"
            type="password"
            maxlength="6"
            label="6 位 PIN"
            hint="只输入 6 位数字；提交后不会再次显示。"
            inputmode="numeric"
            autocomplete="new-password"
            :disabled="actionState === 'creating'"
          />
          <label class="native-field">
            <span>已发布词库版本</span>
            <select
              v-model="sourceVersionId"
              name="source-version-id"
              :disabled="publishedVersions.length === 0 || actionState === 'creating'"
            >
              <option
                value=""
                disabled
              >选择一个已发布版本</option>
              <option
                v-for="version in publishedVersions"
                :key="version.versionId"
                :value="version.versionId"
              >
                {{ version.sourceName }} · v{{ version.versionNo }}
              </option>
            </select>
          </label>
          <UiButton
            type="submit"
            :disabled="!canCreate"
            :loading="actionState === 'creating'"
            loading-label="正在创建"
          >
            创建课程
          </UiButton>
        </form>
      </section>
    </template>
  </section>
</template>

<style scoped>
.admin-page,
.create-course,
.courses,
.course-form,
.error-actions,
.inline-editor {
  display: grid;
}

.admin-page { gap: var(--space-8); }

.page-heading,
.section-heading,
.inline-confirmation > div,
.inline-editor__actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.page-heading p,
.page-heading h1,
.page-heading span,
.section-heading h2,
.section-heading p,
.section-heading > span,
.empty-state h3,
.empty-state p,
.inline-confirmation h2,
.inline-confirmation p { margin: 0; }

.page-heading p {
  color: var(--color-brand-strong);
  font-size: 12px;
  font-weight: 700;
}

.page-heading h1 { margin-block: var(--space-1); font-size: 24px; }

.page-heading span,
.section-heading p,
.section-heading > span,
.empty-state p,
.inline-confirmation p,
.learner-account {
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.55;
}

.create-course,
.courses {
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.section-heading h2 { font-size: 18px; }
.course-form { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.course-form > :deep(.ui-button) { align-self: end; }

.native-field { display: grid; gap: var(--space-2); font-size: 13px; font-weight: 700; }
.native-field select {
  min-height: 40px;
  padding-inline: var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.table-scroll { overflow-x: auto; }
table { width: 100%; min-width: 820px; border-collapse: collapse; }
th, td { padding: var(--space-3); border-bottom: 1px solid var(--color-line); text-align: left; vertical-align: top; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.learner-name, .learner-account { display: block; }
.learner-account { margin-top: var(--space-1); font-weight: 500; }
.course-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }

.inline-editor,
.inline-confirmation {
  min-width: 300px;
  margin-top: var(--space-3);
  padding: var(--space-4);
  border-left: 3px solid var(--color-brand-strong);
  background: var(--color-canvas);
}

.inline-editor { gap: var(--space-3); }
.inline-confirmation > div { margin-top: var(--space-3); }

.status-badge { font-size: 13px; font-weight: 700; }
.status-badge[data-status='active'] { color: var(--color-brand-strong); }

.inline-reveal-enter-active,
.inline-reveal-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.inline-reveal-enter-from,
.inline-reveal-leave-to { opacity: 0; transform: translateY(-6px); }

@media (max-width: 760px) {
  .page-heading,
  .section-heading { align-items: stretch; flex-direction: column; }
  .course-form { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .inline-reveal-enter-active,
  .inline-reveal-leave-active { transition: none; }
}
</style>
