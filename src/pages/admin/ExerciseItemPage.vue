<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { matchedRouteKey, onBeforeRouteLeave } from 'vue-router'
import type {
  AdminExerciseItemDto,
  SourceVersionDetailDto,
} from '@shared/api/contentSchemas'
import type { ExerciseItemContent } from '@shared/api/taskSchemas'
import { createAdminApi } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { useAdminPageContext } from '@/features/admin-auth/adminPageContext'
import ExerciseItemEditor from '@/features/admin-content/ExerciseItemEditor.vue'

type ExerciseItemApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItem'
  | 'disableExerciseItem'
  | 'editExerciseItem'
  | 'getExerciseItem'
  | 'getSourceVersion'
>
type PageState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'saving' | 'approving' | 'disabling'

const props = defineProps<{
  api?: ExerciseItemApi
  versionId: string
  itemId: string
}>()

const api = props.api ?? createAdminApi()
const pageContext = useAdminPageContext()
const pageState = ref<PageState>('loading')
const actionState = ref<ActionState>('idle')
const version = ref<SourceVersionDetailDto | null>(null)
const item = ref<AdminExerciseItemDto | null>(null)
const actionError = ref('')
const actionSuccess = ref('')
const showDisableConfirmation = ref(false)
const isDirty = ref(false)
const isMobileReadonly = ref(false)
const pageRoot = ref<HTMLElement | null>(null)
let disableTrigger: HTMLElement | null = null

const readonly = computed(() => version.value?.status !== 'draft')

const loadPage = async (): Promise<void> => {
  pageState.value = 'loading'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await refreshResources()
    isDirty.value = false
    pageState.value = 'ready'
  } catch {
    version.value = null
    item.value = null
    pageContext.clearPageContext()
    pageState.value = 'error'
  }
}

const save = async (content: ExerciseItemContent): Promise<void> => {
  if (readonly.value || actionState.value !== 'idle') return
  actionState.value = 'saving'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    item.value = await api.editExerciseItem(props.itemId, { content })
    isDirty.value = false
    actionSuccess.value = '练习内容已保存，项目状态以服务端返回为准。'
  } catch (error) {
    await handleWriteError(error, '保存未完成，当前表单内容仍保留。')
  } finally {
    actionState.value = 'idle'
  }
}

const approve = async (): Promise<void> => {
  if (readonly.value || item.value?.status !== 'draft' || actionState.value !== 'idle') return
  actionState.value = 'approving'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    const result = await api.approveExerciseItem(props.itemId)
    item.value = { ...item.value, status: result.status }
    actionSuccess.value = '练习项目已批准；覆盖率需回到版本页重新读取。'
  } catch (error) {
    await recoverItemTransition({
      error,
      expectedStatus: 'approved',
      recoveredMessage: '批准响应未确认；已重新读取服务端状态，练习项目已批准。',
      fallback: '批准未完成；已重新读取，项目仍保持当前状态。',
    })
  } finally {
    actionState.value = 'idle'
  }
}

const disable = async (): Promise<void> => {
  if (readonly.value || item.value?.status === 'disabled' || actionState.value !== 'idle') return
  actionState.value = 'disabling'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    const result = await api.disableExerciseItem(props.itemId)
    if (item.value) item.value = { ...item.value, status: result.status }
    showDisableConfirmation.value = false
    actionSuccess.value = '练习项目已禁用；该状态会成为发布覆盖阻断。'
  } catch (error) {
    await recoverItemTransition({
      error,
      expectedStatus: 'disabled',
      recoveredMessage: '禁用响应未确认；已重新读取服务端状态，练习项目已禁用。',
      fallback: '禁用未完成；已重新读取，项目仍保持当前状态。',
    })
  } finally {
    actionState.value = 'idle'
  }
}

const handleWriteError = async (error: unknown, fallback: string): Promise<void> => {
  if (error instanceof ApiFailureError && error.code === 'source_version_immutable') {
    actionError.value = '服务端已将该版本设为只读，页面已重新读取权威状态。'

    try {
      await refreshResources()
      isDirty.value = false
    } catch {
      pageState.value = 'error'
    }
    return
  }

  if (error instanceof ApiFailureError && error.code === 'validation_error') {
    actionError.value = '服务端未接受这些字段，请检查当前题型要求后重试。'
    return
  }

  actionError.value = fallback
}

const recoverItemTransition = async (input: {
  error: unknown
  expectedStatus: 'approved' | 'disabled'
  recoveredMessage: string
  fallback: string
}): Promise<void> => {
  try {
    await refreshResources()
  } catch {
    version.value = null
    item.value = null
    showDisableConfirmation.value = false
    actionError.value = '操作结果无法确认且重新读取失败。'
    pageContext.clearPageContext()
    pageState.value = 'error'
    return
  }

  if (item.value?.status === input.expectedStatus) {
    showDisableConfirmation.value = false
    actionError.value = ''
    actionSuccess.value = input.recoveredMessage
    return
  }

  if (input.error instanceof ApiFailureError && input.error.code === 'source_version_immutable') {
    actionError.value = '服务端已将该版本设为只读，页面已重新读取权威状态。'
    return
  }

  if (input.error instanceof ApiFailureError && input.error.code === 'validation_error') {
    actionError.value = '服务端未接受这些字段，请检查当前题型要求后重试。'
    return
  }

  actionError.value = input.fallback
}

const refreshResources = async (): Promise<void> => {
  const [nextVersion, nextItem] = await Promise.all([
    api.getSourceVersion(props.versionId),
    api.getExerciseItem(props.itemId),
  ])

  if (
    nextVersion.versionId !== props.versionId ||
    nextItem.id !== props.itemId ||
    nextItem.sourceVersionId !== nextVersion.versionId
  ) {
    throw new Error('Exercise item route resources do not match')
  }

  version.value = nextVersion
  item.value = nextItem
  reportPageContext(nextVersion, nextItem)
}

const reportPageContext = (
  nextVersion: SourceVersionDetailDto,
  nextItem: AdminExerciseItemDto,
): void => {
  pageContext.setPageContext({
    breadcrumbs: [
      '词库工作台',
      nextVersion.sourceName,
      `v${String(nextVersion.versionNo)}`,
      nextItem.word,
      nextItem.stage,
    ],
    confirmLeave,
  })
}

const statusLabel = (status: AdminExerciseItemDto['status']): string =>
  ({ draft: '草稿', approved: '已批准', disabled: '已禁用' })[status]

const openDisableConfirmation = async (event: MouseEvent): Promise<void> => {
  disableTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  showDisableConfirmation.value = true
  await nextTick()
  pageRoot.value?.querySelector<HTMLElement>('[data-disable-confirmation]')?.focus()
}

const closeDisableConfirmation = async (): Promise<void> => {
  showDisableConfirmation.value = false
  await nextTick()
  disableTrigger?.focus()
}

const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
  event.preventDefault()
  Reflect.set(event, 'returnValue', '')
}

const confirmLeave = (): boolean => {
  if (!isDirty.value) return true
  const focusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const shouldLeave = window.confirm('当前练习有未保存修改，确定离开吗？')
  if (!shouldLeave) focusedElement?.focus()
  return shouldLeave
}

watch(
  isDirty,
  (dirty) => {
    if (dirty) {
      window.addEventListener('beforeunload', handleBeforeUnload)
    } else {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  },
  { flush: 'sync' },
)

const matchedRoute = inject(matchedRouteKey, null)
if (matchedRoute) {
  onBeforeRouteLeave(confirmLeave)
}

const syncViewport = (): void => {
  isMobileReadonly.value = window.innerWidth < 480
  if (isMobileReadonly.value) showDisableConfirmation.value = false
}

onMounted(() => {
  syncViewport()
  window.addEventListener('resize', syncViewport)
  void loadPage()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  pageContext.clearPageContext()
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
      title="正在读取练习项目"
    >
      同时确认版本是否仍可编辑。
    </ui-status-message>

    <div
      v-else-if="pageState === 'error'"
      class="error-actions"
    >
      <ui-status-message
        tone="error"
        title="无法读取练习项目"
      >
        编辑器不会显示部分资源，请重新读取版本与练习项目。
      </ui-status-message>
      <ui-button
        variant="secondary"
        @click="loadPage"
      >
        重新读取
      </ui-button>
    </div>

    <template v-else-if="version && item">
      <header class="page-heading">
        <div>
          <router-link
            :to="`/admin/source-versions/${encodeURIComponent(version.versionId)}`"
          >
            返回版本 v{{ version.versionNo }}
          </router-link>
          <p>{{ item.stage }} · {{ item.taskType }}</p>
          <h1><span lang="en">{{ item.word }}</span> 的练习项目</h1>
        </div>
        <span
          class="status-badge"
          :data-status="item.status"
        >{{ statusLabel(item.status) }}</span>
      </header>

      <ui-status-message
        v-if="readonly"
        tone="info"
        :title="version.status === 'published' ? '已发布版本只读' : '当前版本不可编辑'"
      >
        当前练习只能查看。需要调整时，请从版本页创建下一草稿版本。
      </ui-status-message>

      <ui-status-message
        v-if="isMobileReadonly"
        data-mobile-readonly
        tone="info"
        title="当前视口仅支持查看"
      >
        请使用至少 480px 宽的设备编辑、批准或禁用练习项目。
      </ui-status-message>

      <ui-status-message
        v-if="actionError"
        tone="error"
        title="练习操作未完成"
      >
        {{ actionError }}
      </ui-status-message>

      <ui-status-message
        v-if="actionSuccess"
        tone="success"
        title="练习项目已更新"
      >
        {{ actionSuccess }}
      </ui-status-message>

      <div
        data-exercise-workbench
        class="exercise-workbench"
      >
        <section
          class="editor-section"
          aria-labelledby="editor-title"
        >
          <header class="section-heading">
            <div>
              <h2 id="editor-title">
                结构化内容
              </h2>
              <p>表单字段由当前题型决定，不接受原始 JSON 编辑。</p>
            </div>
          </header>

          <exercise-item-editor
            :item="item"
            :readonly="readonly"
            :mobile-readonly="isMobileReadonly"
            :saving="actionState === 'saving'"
            @dirty-change="isDirty = $event"
            @save="save"
          />
        </section>

        <aside
          class="review-panel"
          aria-labelledby="review-title"
        >
          <div>
            <h2 id="review-title">
              审核状态
            </h2>
            <p>批准后计入覆盖；禁用后退出发布覆盖。</p>
          </div>
          <dl class="review-facts">
            <div>
              <dt>版本</dt>
              <dd>v{{ version.versionNo }}</dd>
            </div>
            <div>
              <dt>单词</dt>
              <dd lang="en">
                {{ item.word }}
              </dd>
            </div>
            <div>
              <dt>阶段</dt>
              <dd>{{ item.stage }}</dd>
            </div>
            <div>
              <dt>题型</dt>
              <dd>{{ item.taskType }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{{ statusLabel(item.status) }}</dd>
            </div>
          </dl>

          <div
            v-if="!readonly && !isMobileReadonly"
            class="review-actions__buttons"
          >
            <ui-button
              v-if="item.status === 'draft'"
              data-approve
              :loading="actionState === 'approving'"
              :disabled="actionState !== 'idle'"
              @click="approve"
            >
              批准项目
            </ui-button>
            <ui-button
              v-if="item.status !== 'disabled'"
              variant="secondary"
              :disabled="actionState !== 'idle'"
              @click="openDisableConfirmation"
            >
              禁用项目
            </ui-button>
          </div>

          <section
            v-if="showDisableConfirmation && !isMobileReadonly"
            data-disable-confirmation
            class="confirmation"
            role="region"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby="disable-title"
            tabindex="-1"
            @keydown.esc="closeDisableConfirmation"
          >
            <h2 id="disable-title">
              确认禁用练习项目
            </h2>
            <p>禁用后该项目不再计入发布覆盖，但不会修改已经生成的课时任务快照。</p>
            <div>
              <ui-button
                variant="secondary"
                @click="closeDisableConfirmation"
              >
                取消
              </ui-button>
              <ui-button
                :loading="actionState === 'disabling'"
                @click="disable"
              >
                确认禁用
              </ui-button>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-page,
.editor-section,
.exercise-workbench,
.review-panel,
.error-actions {
  display: grid;
  gap: var(--space-4);
}

.admin-page {
  gap: var(--space-6);
}

.page-heading,
.section-heading,
.review-actions__buttons,
.confirmation > div {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.page-heading p,
.page-heading h1,
.section-heading h2,
.section-heading p,
.review-panel h2,
.review-panel p,
.confirmation h2,
.confirmation p {
  margin: 0;
}

.page-heading a {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  color: var(--color-brand-strong);
  font-size: 13px;
  font-weight: 700;
}

.page-heading p {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
}

.page-heading h1 {
  font-size: 24px;
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

.status-badge[data-status='approved'] {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.status-badge[data-status='disabled'] {
  border-style: dashed;
  color: var(--color-muted);
  text-decoration: line-through;
}

.editor-section,
.review-panel {
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.section-heading h2,
.review-panel h2 {
  font-size: 18px;
}

.section-heading p,
.review-panel p {
  margin-top: 2px;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.55;
}

.review-actions__buttons {
  margin-top: var(--space-4);
  justify-content: flex-end;
}

.review-facts {
  display: grid;
  margin: var(--space-4) 0 0;
  border-top: 1px solid var(--color-line);
}

.review-facts > div {
  display: grid;
  grid-template-columns: minmax(72px, 0.4fr) minmax(0, 1fr);
  gap: var(--space-3);
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}

.review-facts dt,
.review-facts dd {
  margin: 0;
  font-size: 13px;
}

.review-facts dt {
  color: var(--color-muted);
  font-weight: 700;
}

.review-facts dd {
  overflow-wrap: anywhere;
  font-weight: 650;
}

.confirmation {
  display: grid;
  max-width: 760px;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-coral);
  border-radius: var(--radius-sm);
  background: var(--color-coral-soft);
}

.confirmation h2 {
  font-size: 20px;
}

.confirmation p {
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.6;
}

.confirmation > div {
  justify-content: flex-start;
}

.error-actions {
  justify-items: start;
}

@media (max-width: 767px) {
  .page-heading,
  .section-heading {
    display: grid;
  }

  .review-actions__buttons {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}

@media (min-width: 1280px) {
  .exercise-workbench {
    grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
    align-items: start;
    gap: var(--space-6);
  }

  .review-panel {
    position: sticky;
    top: var(--space-6);
  }
}
</style>
