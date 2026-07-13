<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  AdminExerciseItemDto,
  SourceVersionDetailDto,
} from '@shared/api/contentSchemas'
import type { ExerciseItemContent } from '@shared/api/taskSchemas'
import { createAdminApi } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
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
const pageState = ref<PageState>('loading')
const actionState = ref<ActionState>('idle')
const version = ref<SourceVersionDetailDto | null>(null)
const item = ref<AdminExerciseItemDto | null>(null)
const actionError = ref('')
const actionSuccess = ref('')
const showDisableConfirmation = ref(false)

const readonly = computed(() => version.value?.status !== 'draft')

const loadPage = async (): Promise<void> => {
  pageState.value = 'loading'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await refreshResources()
    pageState.value = 'ready'
  } catch {
    version.value = null
    item.value = null
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
}

const statusLabel = (status: AdminExerciseItemDto['status']): string =>
  ({ draft: '草稿', approved: '已批准', disabled: '已禁用' })[status]

onMounted(loadPage)
</script>

<template>
  <section class="admin-page page-enter">
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
          :saving="actionState === 'saving'"
          @save="save"
        />
      </section>

      <section
        v-if="!readonly"
        class="review-actions"
        aria-labelledby="review-title"
      >
        <div>
          <h2 id="review-title">
            审核状态
          </h2>
          <p>批准后计入覆盖；禁用后退出发布覆盖。</p>
        </div>
        <div class="review-actions__buttons">
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
            @click="showDisableConfirmation = true"
          >
            禁用项目
          </ui-button>
        </div>
      </section>

      <section
        v-if="showDisableConfirmation"
        data-disable-confirmation
        class="confirmation"
        role="region"
        aria-labelledby="disable-title"
      >
        <h2 id="disable-title">
          确认禁用练习项目
        </h2>
        <p>禁用后该项目不再计入发布覆盖，但不会修改已经生成的课时任务快照。</p>
        <div>
          <ui-button
            variant="secondary"
            @click="showDisableConfirmation = false"
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
    </template>
  </section>
</template>

<style scoped>
.admin-page,
.editor-section,
.error-actions {
  display: grid;
  gap: var(--space-4);
}

.admin-page {
  gap: var(--space-6);
}

.page-heading,
.section-heading,
.review-actions,
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
.review-actions h2,
.review-actions p,
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
  font-size: 26px;
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
.review-actions {
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.section-heading h2,
.review-actions h2 {
  font-size: 18px;
}

.section-heading p,
.review-actions p {
  margin-top: 2px;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.55;
}

.review-actions__buttons {
  justify-content: flex-end;
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
  .section-heading,
  .review-actions {
    display: grid;
  }

  .review-actions__buttons {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
