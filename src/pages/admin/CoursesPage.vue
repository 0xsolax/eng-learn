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

type CoursesApi = Pick<
  ReturnType<typeof createAdminApi>,
  'createCourse' | 'listCourses' | 'listSourceVersions' | 'rotateAccessCode'
>
type CourseEntry = AdminCourseListDto['courses'][number]
type PageState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'creating' | 'rotating'
type CopyState = 'idle' | 'success' | 'error'
type OneTimeCode = {
  accessCode: string
  learnerName: string
  revokedSessionCount?: number
}
type CreateCourseCommand = Parameters<CoursesApi['createCourse']>[0]
type RotateCodeCommand = Parameters<CoursesApi['rotateAccessCode']>[1]
type PendingOperation =
  | { kind: 'create'; command: CreateCourseCommand }
  | {
      kind: 'rotate'
      learnerId: string
      learnerName: string
      command: RotateCodeCommand
    }

const props = defineProps<{
  api?: CoursesApi
}>()

const api = props.api ?? createAdminApi()
const pageState = ref<PageState>('loading')
const actionState = ref<ActionState>('idle')
const courses = ref<CourseEntry[]>([])
const versions = ref<SourceVersionSummaryDto[]>([])
const learnerName = ref('')
const sourceVersionId = ref('')
const actionError = ref('')
const oneTimeCode = ref<OneTimeCode | null>(null)
const rotateTarget = ref<CourseEntry | null>(null)
const pendingOperation = ref<PendingOperation | null>(null)
const resultUnknown = ref(false)
const showCreateForm = ref(false)
const isMobileReadonly = ref(false)
const pageRoot = ref<HTMLElement | null>(null)
const oneTimeCodeDialog = ref<HTMLElement | null>(null)
const copyState = ref<CopyState>('idle')
let rotateTrigger: HTMLElement | null = null

const publishedVersions = computed(() =>
  versions.value.filter((version) => version.status === 'published'),
)

const canCreate = computed(
  () =>
    !isMobileReadonly.value &&
    actionState.value === 'idle' &&
    pendingOperation.value === null &&
    learnerName.value.trim().length > 0 &&
    sourceVersionId.value.length > 0,
)

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
  rotateTarget.value = null
  const operation: PendingOperation = {
    kind: 'create',
    command: {
      operationToken: generateAdminOperationToken(),
      learnerName: learnerName.value,
      sourceVersionId: sourceVersionId.value,
    },
  }
  pendingOperation.value = operation

  await executeCreateCourse(operation)
}

const executeCreateCourse = async (
  operation: Extract<PendingOperation, { kind: 'create' }>,
): Promise<void> => {
  actionState.value = 'creating'
  actionError.value = ''
  oneTimeCode.value = null
  resultUnknown.value = false

  try {
    const created = await api.createCourse(operation.command)
    oneTimeCode.value = {
      accessCode: created.learner.accessCode,
      learnerName: created.learner.name,
    }
    copyState.value = 'idle'
    showCreateForm.value = false
    learnerName.value = ''
    pendingOperation.value = null
    await focusOneTimeCodeDialog()

    try {
      courses.value = (await api.listCourses()).courses
    } catch {
      actionError.value = '课程已创建，但列表刷新失败。请先记录学习码，再重新读取工作台。'
    }
  } catch (error) {
    if (isUnknownResult(error)) {
      resultUnknown.value = true
      return
    }

    pendingOperation.value = null
    actionError.value =
      error instanceof ApiFailureError && error.code === 'conflict'
        ? '课程创建冲突：该学习者与版本可能已经存在课程，请重新读取后确认。'
        : error instanceof ApiFailureError && error.code === 'source_version_immutable'
          ? '课程只能绑定已发布版本，请重新选择服务端可用版本。'
          : '课程创建未完成，已输入的学习者名称和版本仍保留。'
  } finally {
    actionState.value = 'idle'
  }
}

const rotateCode = async (): Promise<void> => {
  if (
    !rotateTarget.value ||
    actionState.value !== 'idle' ||
    pendingOperation.value !== null
  ) {
    return
  }
  const target = rotateTarget.value
  const operation: PendingOperation = {
    kind: 'rotate',
    learnerId: target.learner.id,
    learnerName: target.learner.name,
    command: {
      operationToken: generateAdminOperationToken(),
      expectedCredentialVersion: target.credentialVersion,
    },
  }
  pendingOperation.value = operation
  rotateTarget.value = null

  await executeRotateCode(operation)
}

const executeRotateCode = async (
  operation: Extract<PendingOperation, { kind: 'rotate' }>,
): Promise<void> => {
  actionState.value = 'rotating'
  actionError.value = ''
  oneTimeCode.value = null
  resultUnknown.value = false

  try {
    const rotated = await api.rotateAccessCode(operation.learnerId, operation.command)
    oneTimeCode.value = {
      accessCode: rotated.accessCode,
      learnerName: operation.learnerName,
      revokedSessionCount: rotated.revokedSessionCount,
    }
    copyState.value = 'idle'
    courses.value = courses.value.map((entry) =>
      entry.learner.id === operation.learnerId
        ? { ...entry, credentialVersion: rotated.credentialVersion }
        : entry,
    )
    pendingOperation.value = null
    await focusOneTimeCodeDialog()
  } catch (error) {
    if (isUnknownResult(error)) {
      resultUnknown.value = true
      return
    }

    pendingOperation.value = null
    actionError.value =
      error instanceof ApiFailureError && error.code === 'credential_conflict'
        ? '学习码版本已变化，请重新读取工作台后再操作。'
        : error instanceof ApiFailureError && error.code === 'operation_superseded'
          ? '本次轮换结果已被后续操作替代，请重新读取工作台。'
          : '学习码轮换未完成，请重新读取工作台确认服务端状态。'
    await nextTick()
    rotateTrigger?.focus()
  } finally {
    actionState.value = 'idle'
  }
}

const retryUnknownOperation = async (): Promise<void> => {
  if (!resultUnknown.value || actionState.value !== 'idle' || !pendingOperation.value) {
    return
  }

  if (pendingOperation.value.kind === 'create') {
    await executeCreateCourse(pendingOperation.value)
  } else {
    await executeRotateCode(pendingOperation.value)
  }
}

const unknownResultMessage = computed(() =>
  pendingOperation.value?.kind === 'rotate'
    ? '结果未知：学习码和会话可能已经变更。请安全重试同一次轮换，不要根据当前页面判断旧码仍有效。'
    : '结果未知：课程可能已经创建。请安全重试同一次创建，不要重新提交一个新操作。',
)

const isUnknownResult = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  error instanceof InvalidApiResponseError ||
  (error instanceof ApiFailureError &&
    (error.code === 'dependency_failure' || error.code === 'internal_error'))

const courseStatusLabel = (status: CourseEntry['course']['status']): string =>
  ({ active: '学习中', paused: '已暂停', completed: '已完成' })[status]

const toggleCreateForm = (): void => {
  if (isMobileReadonly.value) return
  showCreateForm.value = !showCreateForm.value
}

const openRotateConfirmation = async (
  entry: CourseEntry,
  event: MouseEvent,
): Promise<void> => {
  if (isMobileReadonly.value || actionState.value !== 'idle' || pendingOperation.value) return
  rotateTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  rotateTarget.value = entry
  await nextTick()
  pageRoot.value?.querySelector<HTMLElement>('[data-rotate-confirmation]')?.focus()
}

const closeRotateConfirmation = async (): Promise<void> => {
  rotateTarget.value = null
  await nextTick()
  rotateTrigger?.focus()
}

const focusOneTimeCodeDialog = async (): Promise<void> => {
  await nextTick()
  oneTimeCodeDialog.value?.focus()
}

const dismissOneTimeCode = async (): Promise<void> => {
  const returnToRotate = oneTimeCode.value?.revokedSessionCount !== undefined
  oneTimeCode.value = null
  copyState.value = 'idle'
  await nextTick()
  if (returnToRotate) {
    rotateTrigger?.focus()
  } else {
    pageRoot.value?.querySelector<HTMLElement>('[data-toggle-create]')?.focus()
  }
}

const copyOneTimeCode = async (): Promise<void> => {
  if (!oneTimeCode.value || isMobileReadonly.value) return
  copyState.value = 'idle'

  try {
    await navigator.clipboard.writeText(oneTimeCode.value.accessCode)
    copyState.value = 'success'
  } catch {
    copyState.value = 'error'
  }
}

const handleDialogKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Tab' || !oneTimeCodeDialog.value) return
  const focusable = Array.from(
    oneTimeCodeDialog.value.querySelectorAll<HTMLElement>('button:not(:disabled)'),
  )
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return

  if (document.activeElement === oneTimeCodeDialog.value) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const syncViewport = (): void => {
  isMobileReadonly.value = window.innerWidth < 480
  if (isMobileReadonly.value) {
    showCreateForm.value = false
    rotateTarget.value = null
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
  <section
    ref="pageRoot"
    class="admin-page page-enter"
  >
    <ui-status-message
      v-if="pageState === 'loading'"
      tone="info"
      title="正在读取课程工作台"
    >
      同步课程列表和可绑定的已发布词库版本。
    </ui-status-message>

    <div
      v-else-if="pageState === 'error'"
      class="error-actions"
    >
      <ui-status-message
        tone="error"
        title="无法读取课程工作台"
      >
        不显示部分课程或版本数据，请完整重试。
      </ui-status-message>
      <ui-button
        variant="secondary"
        @click="loadWorkspace"
      >
        重新读取
      </ui-button>
    </div>

    <template v-else>
      <header class="page-heading">
        <div>
          <p>学习者与课程</p>
          <h1>课程工作台</h1>
          <span>为学习者绑定已发布词库版本；学习码只在创建或轮换后本次显示。</span>
        </div>
        <ui-button
          v-if="!isMobileReadonly"
          data-toggle-create
          :variant="showCreateForm ? 'secondary' : 'primary'"
          :aria-expanded="String(showCreateForm)"
          aria-controls="create-course-region"
          @click="toggleCreateForm"
        >
          {{ showCreateForm ? '收起创建区' : '创建课程' }}
        </ui-button>
      </header>

      <ui-status-message
        v-if="isMobileReadonly"
        data-mobile-readonly
        tone="info"
        title="当前视口仅支持查看"
      >
        请使用至少 480px 宽的设备创建课程或轮换学习码。
      </ui-status-message>

      <ui-status-message
        v-if="actionError"
        tone="error"
        title="课程操作未完成"
      >
        {{ actionError }}
      </ui-status-message>

      <ui-status-message
        v-if="resultUnknown && pendingOperation"
        data-unknown-result
        tone="error"
        title="课程操作结果未知"
      >
        <p>{{ unknownResultMessage }}</p>
        <ui-button
          v-if="!isMobileReadonly"
          data-retry-unknown
          variant="secondary"
          :loading="actionState !== 'idle'"
          @click="retryUnknownOperation"
        >
          安全重试同一次操作
        </ui-button>
      </ui-status-message>

      <div
        v-if="oneTimeCode"
        data-one-time-code-backdrop
        class="one-time-dialog-backdrop"
        aria-hidden="true"
      />

      <section
        v-if="oneTimeCode"
        ref="oneTimeCodeDialog"
        data-one-time-code
        class="one-time-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="one-time-code-title"
        aria-describedby="one-time-code-description"
        tabindex="-1"
        @keydown="handleDialogKeydown"
      >
        <p class="dialog-eyebrow">
          仅本次显示
        </p>
        <h2 id="one-time-code-title">
          {{ oneTimeCode.learnerName }} 的新学习码
        </h2>
        <p id="one-time-code-description">
          请立即安全记录；关闭后页面和课程列表不会恢复明文码。
        </p>
        <code>{{ oneTimeCode.accessCode }}</code>
        <p v-if="oneTimeCode.revokedSessionCount !== undefined">
          {{ oneTimeCode.revokedSessionCount }} 个旧会话已失效。
        </p>
        <p
          v-if="copyState !== 'idle'"
          data-copy-feedback
          class="copy-feedback"
          :class="`copy-feedback--${copyState}`"
          :role="copyState === 'error' ? 'alert' : 'status'"
          :aria-live="copyState === 'error' ? 'assertive' : 'polite'"
        >
          {{ copyState === 'success' ? '复制成功，请保存到安全位置。' : '复制失败，请手动记录学习码。' }}
        </p>
        <div class="dialog-actions">
          <ui-button
            v-if="!isMobileReadonly"
            data-copy-code
            variant="secondary"
            @click="copyOneTimeCode"
          >
            复制学习码
          </ui-button>
          <ui-button
            data-dismiss-code
            @click="dismissOneTimeCode"
          >
            我已安全记录
          </ui-button>
        </div>
      </section>

      <section
        class="courses"
        aria-labelledby="courses-title"
      >
        <header class="section-heading">
          <div>
            <h2 id="courses-title">
              已有课程
            </h2>
            <p>列表不返回也不恢复学习码，只展示最小课程状态。</p>
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
                  {{ entry.learner.name }}
                </th>
                <td>{{ versionNames.get(entry.course.sourceVersionId) ?? '版本信息不可用' }}</td>
                <td class="numeric">
                  第 {{ entry.course.currentLessonNo }} 课
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
                  <ui-button
                    data-rotate-code
                    variant="secondary"
                    :aria-expanded="String(rotateTarget?.learner.id === entry.learner.id)"
                    :disabled="actionState !== 'idle' || pendingOperation !== null"
                    @click="openRotateConfirmation(entry, $event)"
                  >
                    轮换学习码
                  </ui-button>
                  <section
                    v-if="rotateTarget?.learner.id === entry.learner.id"
                    data-rotate-confirmation
                    class="inline-confirmation"
                    role="region"
                    aria-live="polite"
                    aria-atomic="true"
                    aria-labelledby="rotate-code-title"
                    tabindex="-1"
                    @keydown.esc="closeRotateConfirmation"
                  >
                    <h2 id="rotate-code-title">
                      确认轮换 {{ rotateTarget.learner.name }} 的学习码
                    </h2>
                    <p>现有学习会话会全部失效，需要使用新学习码重新进入课程。</p>
                    <div>
                      <ui-button
                        variant="secondary"
                        @click="closeRotateConfirmation"
                      >
                        取消
                      </ui-button>
                      <ui-button
                        data-confirm-rotate
                        :disabled="actionState !== 'idle' || pendingOperation !== null"
                        :loading="actionState === 'rotating'"
                        @click="rotateCode"
                      >
                        确认轮换
                      </ui-button>
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
            <p>课程状态和学习码均由服务端创建。</p>
          </div>
        </header>

        <ui-status-message
          v-if="publishedVersions.length === 0"
          data-no-published
          tone="info"
          title="暂无可绑定版本"
        >
          先发布一个词库版本，再创建课程。
          <a
            data-source-workbench-link
            href="/admin/source-versions"
          >
            前往词库工作台
          </a>
        </ui-status-message>

        <form
          data-course-form
          class="course-form"
          @submit.prevent="createCourse"
        >
          <ui-input
            v-model="learnerName"
            name="learner-name"
            maxlength="80"
            label="学习者姓名"
            hint="只填写学习所需的最小称呼。"
            :disabled="actionState === 'creating' || pendingOperation?.kind === 'create'"
          />
          <label class="native-field">
            <span>已发布词库版本</span>
            <select
              v-model="sourceVersionId"
              name="source-version-id"
              :disabled="publishedVersions.length === 0 || actionState === 'creating' || pendingOperation?.kind === 'create'"
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
          <ui-button
            type="submit"
            :disabled="!canCreate"
            :loading="actionState === 'creating'"
            loading-label="正在创建"
          >
            创建课程并生成学习码
          </ui-button>
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
.error-actions {
  display: grid;
}

.admin-page {
  gap: var(--space-8);
}

.page-heading,
.section-heading,
.inline-confirmation > div {
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
.inline-confirmation p {
  margin: 0;
}

.page-heading p {
  color: var(--color-brand-strong);
  font-size: 12px;
  font-weight: 700;
}

.page-heading h1 {
  margin-block: var(--space-1);
  font-size: 24px;
}

.page-heading span,
.section-heading p,
.section-heading > span,
.empty-state p,
.inline-confirmation p {
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

.section-heading h2 {
  font-size: 18px;
}

.course-form {
  max-width: 760px;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 1fr);
  align-items: end;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

.course-form > .ui-button {
  grid-column: 1 / -1;
  justify-self: start;
}

.native-field {
  display: grid;
  gap: var(--space-2);
}

.native-field > span {
  font-size: 13px;
  font-weight: 700;
}

.native-field select {
  min-height: 40px;
  padding-inline: var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: 14px;
}

[data-one-time-code] code {
  display: inline-block;
  margin-block: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.12em;
  user-select: all;
}

.one-time-dialog {
  position: fixed;
  z-index: 30;
  inset: 50% auto auto 50%;
  display: grid;
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  gap: var(--space-3);
  padding: var(--space-6);
  overflow-y: auto;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-high);
  transform: translate(-50%, -50%);
}

.one-time-dialog-backdrop {
  position: fixed;
  z-index: 29;
  inset: 0;
  background: rgb(35 52 58 / 40%);
}

.one-time-dialog:focus-visible {
  outline: 3px solid var(--color-focus);
  outline-offset: 3px;
}

.one-time-dialog h2,
.one-time-dialog p {
  margin: 0;
}

.one-time-dialog h2 {
  font-size: 20px;
}

.one-time-dialog > p:not(.dialog-eyebrow, .copy-feedback) {
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.6;
}

.dialog-eyebrow {
  color: var(--color-brand-strong);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.copy-feedback {
  padding: var(--space-3);
  border-left: 3px solid var(--color-brand);
  background: var(--color-brand-soft);
  font-size: 13px;
  font-weight: 650;
}

.copy-feedback--error {
  border-color: var(--color-coral-strong);
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
}

.empty-state {
  padding: var(--space-8);
  border: 1px dashed var(--color-line-strong);
  background: var(--color-surface);
  text-align: center;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

.table-scroll:focus-visible {
  border-color: var(--color-brand-strong);
  outline: 3px solid var(--color-focus-ring);
  outline-offset: 2px;
}

table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  height: 44px;
  padding-inline: var(--space-3);
  border-bottom: 1px solid var(--color-line);
  text-align: left;
}

thead th {
  height: 44px;
  background: var(--color-canvas);
  color: var(--color-muted);
  font-size: 12px;
}

tbody tr:last-child > * {
  border-bottom: 0;
}

.numeric {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.status-badge {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  padding-inline: var(--space-2);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 700;
}

.status-badge[data-status='active'] {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.inline-confirmation {
  display: grid;
  min-width: 320px;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-coral);
  border-radius: var(--radius-sm);
  background: var(--color-coral-soft);
}

.inline-confirmation h2 {
  font-size: 17px;
}

.inline-confirmation > div {
  justify-content: flex-start;
}

[data-source-workbench-link] {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  margin-left: var(--space-3);
  color: var(--color-brand-strong);
  font-weight: 700;
}

.error-actions {
  justify-items: start;
  gap: var(--space-3);
}

@media (max-width: 767px) {
  .course-form {
    grid-template-columns: 1fr;
    padding: var(--space-4);
  }

  .page-heading,
  .section-heading {
    display: grid;
  }

  .one-time-dialog {
    padding: var(--space-4);
  }
}
</style>
