<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type {
  AdminExerciseItemDto,
  BuildCoverageDto,
  SourceVersionDetailDto,
} from '@shared/api/contentSchemas'
import { MAX_BATCH_APPROVAL_ITEMS } from '@shared/api/contentSchemas'
import { Hammer, Send } from '@lucide/vue'
import { createAdminApi } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'

type VersionDetailApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItems'
  | 'buildSourceVersion'
  | 'discardSourceVersion'
  | 'getCoverage'
  | 'getSourceVersion'
  | 'listExerciseItems'
  | 'publishSourceVersion'
>
type PageState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'building' | 'approving' | 'publishing' | 'discarding'

const props = defineProps<{
  api?: VersionDetailApi
  versionId: string
}>()

const api = props.api ?? createAdminApi()
const pageState = ref<PageState>('loading')
const detail = ref<SourceVersionDetailDto | null>(null)
const coverage = ref<BuildCoverageDto | null>(null)
const exerciseItems = ref<AdminExerciseItemDto[]>([])
const actionState = ref<ActionState>('idle')
const actionError = ref('')
const actionSuccess = ref('')
const selectedItemIds = ref<string[]>([])
const showOnlyGaps = ref(false)
const confirmation = ref<'publish' | 'discard' | null>(null)
const confirmationRegion = ref<HTMLElement | null>(null)
let confirmationTrigger: HTMLElement | null = null

const isMutable = computed(() => detail.value?.status === 'draft')
const draftItems = computed(() => exerciseItems.value.filter((item) => item.status === 'draft'))
const allDraftsSelected = computed({
  get: () =>
    draftItems.value.length > 0 &&
    draftItems.value.every((item) => selectedItemIds.value.includes(item.id)),
  set: (selected: boolean) => {
    selectedItemIds.value = selected ? draftItems.value.map((item) => item.id) : []
  },
})
const visibleCells = computed(() => {
  const cells = coverage.value?.cells ?? []
  return showOnlyGaps.value ? cells.filter((cell) => cell.status !== 'approved') : cells
})

const openConfirmation = async (
  kind: 'publish' | 'discard',
  event: MouseEvent,
): Promise<void> => {
  confirmationTrigger =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  confirmation.value = kind
  await nextTick()
  confirmationRegion.value?.focus()
}

const closeConfirmation = async (): Promise<void> => {
  confirmation.value = null
  await nextTick()
  confirmationTrigger?.focus()
}

const loadWorkspace = async (): Promise<void> => {
  pageState.value = 'loading'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    const [nextDetail, nextCoverage, nextItems] = await Promise.all([
      api.getSourceVersion(props.versionId),
      api.getCoverage(props.versionId),
      api.listExerciseItems(props.versionId),
    ])
    detail.value = nextDetail
    coverage.value = nextCoverage
    exerciseItems.value = nextItems
    selectedItemIds.value = []
    pageState.value = 'ready'
  } catch {
    detail.value = null
    coverage.value = null
    exerciseItems.value = []
    pageState.value = 'error'
  }
}

const buildVersion = async (): Promise<void> => {
  if (!isMutable.value || actionState.value !== 'idle') return
  actionState.value = 'building'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await api.buildSourceVersion(props.versionId)
    try {
      await refreshWorkspace()
      actionSuccess.value = '构建完成，已重新读取服务端覆盖率。'
    } catch {
      invalidateWorkspace('服务端已接受构建，但重新读取覆盖率失败。请完整刷新后再继续操作。')
    }
  } catch {
    actionError.value = '构建未完成。已有草稿和统计仍保留，请检查冲突后重新构建。'
  } finally {
    actionState.value = 'idle'
  }
}

const approveSelected = async (): Promise<void> => {
  if (
    !isMutable.value ||
    selectedItemIds.value.length === 0 ||
    actionState.value !== 'idle'
  ) {
    return
  }

  actionState.value = 'approving'
  actionError.value = ''
  actionSuccess.value = ''
  let confirmedApprovedCount = 0

  try {
    for (const itemIds of chunkIds(selectedItemIds.value, MAX_BATCH_APPROVAL_ITEMS)) {
      const result = await api.approveExerciseItems({ itemIds })
      confirmedApprovedCount += result.approvedCount
    }

    try {
      await refreshWorkspace()
      actionSuccess.value = `已批准 ${String(confirmedApprovedCount)} 个练习项目，并重新读取覆盖率。`
    } catch {
      invalidateWorkspace(`服务端已确认批准 ${String(confirmedApprovedCount)} 个练习项目，但重新读取覆盖率失败。请完整刷新。`)
    }
  } catch (error) {
    try {
      await refreshWorkspace()
      actionError.value =
        confirmedApprovedCount > 0
          ? `已确认批准 ${String(confirmedApprovedCount)} 个练习项目，后续批次未完成；已重新读取服务端状态。`
          : getActionError(error, '审批结果无法确认，已重新读取服务端状态。')
    } catch {
      invalidateWorkspace(
        confirmedApprovedCount > 0
          ? `已确认批准 ${String(confirmedApprovedCount)} 个练习项目，但后续批次和重新读取均失败。请完整刷新。`
          : '审批结果无法确认且重新读取失败。为避免显示过期状态，请完整刷新。',
      )
    }
  } finally {
    actionState.value = 'idle'
  }
}

const chunkIds = (itemIds: string[], chunkSize: number): string[][] => {
  const chunks: string[][] = []

  for (let index = 0; index < itemIds.length; index += chunkSize) {
    chunks.push(itemIds.slice(index, index + chunkSize))
  }

  return chunks
}

const publishVersion = async (): Promise<void> => {
  if (!detail.value?.readyToPublish || !isMutable.value || actionState.value !== 'idle') return
  actionState.value = 'publishing'
  actionError.value = ''

  try {
    await api.publishSourceVersion(props.versionId)
    confirmation.value = null
    try {
      await refreshWorkspace()
      actionSuccess.value = '版本已发布，只读。后续修改请创建下一草稿版本。'
    } catch {
      invalidateWorkspace('服务端已接受发布，但重新读取版本状态失败。请完整刷新后再继续操作。')
    }
  } catch (error) {
    await recoverVersionTransition({
      error,
      expectedStatus: 'published',
      recoveredMessage: '发布响应未确认；已重新读取服务端状态，版本已发布并转为只读。',
      fallback: '发布未完成；已重新读取，版本仍保持当前服务端状态。',
    })
  } finally {
    actionState.value = 'idle'
  }
}

const discardVersion = async (): Promise<void> => {
  if (!isMutable.value || actionState.value !== 'idle') return
  actionState.value = 'discarding'
  actionError.value = ''

  try {
    await api.discardSourceVersion(props.versionId)
    confirmation.value = null
    try {
      await refreshWorkspace()
      actionSuccess.value = '草稿版本已丢弃。'
    } catch {
      invalidateWorkspace('服务端已接受丢弃，但重新读取版本状态失败。请完整刷新后再继续操作。')
    }
  } catch (error) {
    await recoverVersionTransition({
      error,
      expectedStatus: 'archived',
      recoveredMessage: '丢弃响应未确认；已重新读取服务端状态，草稿已丢弃。',
      fallback: '丢弃未完成；已重新读取，草稿仍保留。',
    })
  } finally {
    actionState.value = 'idle'
  }
}

const refreshWorkspace = async (): Promise<void> => {
  const [nextDetail, nextCoverage, nextItems] = await Promise.all([
    api.getSourceVersion(props.versionId),
    api.getCoverage(props.versionId),
    api.listExerciseItems(props.versionId),
  ])
  detail.value = nextDetail
  coverage.value = nextCoverage
  exerciseItems.value = nextItems
  selectedItemIds.value = []
}

const recoverVersionTransition = async (input: {
  error: unknown
  expectedStatus: 'published' | 'archived'
  recoveredMessage: string
  fallback: string
}): Promise<void> => {
  confirmation.value = null

  try {
    await refreshWorkspace()
  } catch {
    invalidateWorkspace('操作结果无法确认且重新读取失败。为避免继续操作过期状态，请完整刷新。')
    return
  }

  if (detail.value?.status === input.expectedStatus) {
    actionError.value = ''
    actionSuccess.value = input.recoveredMessage
    return
  }

  actionError.value = getActionError(input.error, input.fallback)
}

const invalidateWorkspace = (message: string): void => {
  detail.value = null
  coverage.value = null
  exerciseItems.value = []
  selectedItemIds.value = []
  confirmation.value = null
  actionError.value = message
  pageState.value = 'error'
}

const getActionError = (error: unknown, fallback: string): string => {
  if (error instanceof ApiFailureError && error.code === 'source_version_immutable') {
    return '服务端确认该版本已不可修改，请重新读取后创建下一版本。'
  }

  if (error instanceof ApiFailureError && error.code === 'coverage_incomplete') {
    return '服务端仍报告覆盖缺口，请按发布阻断项继续审批。'
  }

  return fallback
}

const statusLabel = (status: SourceVersionDetailDto['status']): string =>
  ({ draft: '草稿', published: '已发布', archived: '已丢弃' })[status]

const itemStatusLabel = (status: string): string =>
  ({ draft: '待审批', approved: '已批准', disabled: '已禁用', missing: '缺失' })[status] ??
  status

const taskTypeLabel = (taskType: string): string =>
  ({
    recognize_meaning: '认识词义',
    recall_word: '回忆单词',
    multiple_choice: '选择单词',
    fill_blank: '句子填空',
    sentence_build: '句子拼装',
    sentence_output: '主动输出',
  })[taskType] ?? taskType

const reasonLabel = (reason: string): string =>
  ({
    exercise_item_disabled: '练习已禁用',
    exercise_item_draft: '练习待审批',
    exercise_item_required: '缺少练习项目',
    exercise_item_invalid: '练习内容不合法',
    example_sentence_required: '缺少例句',
    distractors_required: '缺少干扰选项',
    sentence_pieces_required: '缺少句子词块',
  })[reason] ?? '内容未满足覆盖要求'

onMounted(loadWorkspace)
</script>

<template>
  <section class="admin-page page-enter">
    <ui-status-message
      v-if="pageState === 'loading'"
      tone="info"
      title="正在读取版本详情"
    >
      正在同步构建、审批和覆盖状态。
    </ui-status-message>

    <div
      v-else-if="pageState === 'error'"
      class="error-actions"
    >
      <ui-status-message
        tone="error"
        title="无法读取版本详情"
      >
        {{ actionError || '工作台不会显示部分或缓存的业务状态，请完整重试。' }}
      </ui-status-message>
      <ui-button
        variant="secondary"
        @click="loadWorkspace"
      >
        重新读取
      </ui-button>
    </div>

    <template v-else-if="detail && coverage">
      <div
        data-version-workspace
        class="version-workspace"
      >
        <header class="version-header">
          <div>
            <router-link
              to="/admin/source-versions"
              class="back-link"
            >
              返回词库版本
            </router-link>
            <p>{{ detail.sourceName }}</p>
            <h1>版本 v{{ detail.versionNo }}</h1>
          </div>
          <span
            class="status-badge"
            :data-status="detail.status"
          >
            {{ statusLabel(detail.status) }}
          </span>
        </header>

        <ui-status-message
          v-if="detail.status === 'published'"
          tone="success"
          title="已发布，只读"
        >
          该版本不可原地修改。需要调整内容时创建同一词库的下一草稿版本。
        </ui-status-message>

        <ui-status-message
          v-else-if="detail.status === 'archived'"
          title="草稿已丢弃"
        >
          当前版本不再提供构建、审批或发布操作。
        </ui-status-message>

        <ui-status-message
          v-if="actionError"
          tone="error"
          title="操作未完成"
        >
          {{ actionError }}
        </ui-status-message>

        <ui-status-message
          v-if="actionSuccess"
          tone="success"
          title="服务端状态已更新"
        >
          {{ actionSuccess }}
        </ui-status-message>

        <section
          aria-labelledby="pipeline-title"
          class="pipeline"
        >
          <header class="section-heading">
            <div>
              <h2 id="pipeline-title">
                内容流水线
              </h2>
              <p>操作权限和发布资格以服务端返回状态为准。</p>
            </div>
          </header>
          <ol>
            <li><span>01</span><strong>导入</strong><em>{{ detail.wordCount }} 个词</em></li>
            <li><span>02</span><strong>构建</strong><em>{{ detail.exerciseItemCount }} 个练习</em></li>
            <li><span>03</span><strong>审阅</strong><em>{{ detail.approvedItemCount }} 个已批准</em></li>
            <li>
              <span>04</span><strong>发布</strong>
              <em>{{ detail.readyToPublish ? '服务端确认可发布' : '存在发布阻断' }}</em>
            </li>
          </ol>
        </section>

        <section
          v-if="detail.status === 'draft'"
          class="command-bar"
          aria-label="版本操作"
        >
          <ui-button
            data-build
            variant="secondary"
            :loading="actionState === 'building'"
            :disabled="actionState !== 'idle'"
            @click="buildVersion"
          >
            <hammer
              :size="18"
              aria-hidden="true"
            />
            {{ actionError.includes('构建未完成') ? '重新构建' : '构建练习' }}
          </ui-button>
          <ui-button
            data-publish
            :disabled="!detail.readyToPublish || actionState !== 'idle'"
            @click="openConfirmation('publish', $event)"
          >
            <send
              :size="18"
              aria-hidden="true"
            />
            发布版本
          </ui-button>
          <ui-button
            data-discard
            variant="secondary"
            :disabled="actionState !== 'idle'"
            @click="openConfirmation('discard', $event)"
          >
            丢弃草稿
          </ui-button>
        </section>

        <router-link
          v-else-if="detail.status === 'published'"
          data-next-version
          class="primary-link"
          :to="{
            path: '/admin/source-versions',
            query: { mode: 'next_version', sourceId: detail.sourceId },
          }"
        >
          创建下一草稿版本
        </router-link>

        <section
          v-if="confirmation"
          ref="confirmationRegion"
          data-inline-confirmation
          class="confirmation"
          role="region"
          aria-live="polite"
          aria-atomic="true"
          tabindex="-1"
          :aria-labelledby="confirmation === 'publish' ? 'publish-title' : 'discard-title'"
          @keydown.esc.stop.prevent="closeConfirmation"
        >
          <template v-if="confirmation === 'publish'">
            <h2 id="publish-title">
              确认发布 v{{ detail.versionNo }}
            </h2>
            <p>共 {{ detail.wordCount }} 个词、{{ detail.groupCount }} 个分组。发布后不可原地修改。</p>
            <div class="confirmation__actions">
              <ui-button
                variant="secondary"
                @click="closeConfirmation"
              >
                取消
              </ui-button>
              <ui-button
                data-confirm-publish
                :loading="actionState === 'publishing'"
                @click="publishVersion"
              >
                确认发布
              </ui-button>
            </div>
          </template>
          <template v-else>
            <h2 id="discard-title">
              确认丢弃草稿
            </h2>
            <p>该操作只处理当前草稿版本，不修改已发布版本或已有课程。</p>
            <div class="confirmation__actions">
              <ui-button
                variant="secondary"
                @click="closeConfirmation"
              >
                取消
              </ui-button>
              <ui-button
                data-confirm-discard
                :loading="actionState === 'discarding'"
                @click="discardVersion"
              >
                确认丢弃
              </ui-button>
            </div>
          </template>
        </section>

        <section
          v-if="!detail.readyToPublish && detail.status === 'draft'"
          data-blockers
          class="blockers"
          aria-labelledby="blockers-title"
        >
          <header class="section-heading">
            <div>
              <h2 id="blockers-title">
                发布阻断项
              </h2>
              <p>以下项目来自服务端覆盖检查，补齐或批准后重新读取。</p>
            </div>
            <span>{{ detail.missingItems.length }} 项</span>
          </header>
          <ul>
            <li
              v-for="(item, index) in detail.missingItems"
              :key="`${item.word}-${item.stage}-${item.taskType}-${String(index)}`"
            >
              <strong>{{ item.word }} · {{ item.stage }}</strong>
              <span>{{ taskTypeLabel(item.taskType) }} · {{ reasonLabel(item.reason) }}</span>
            </li>
          </ul>
        </section>

        <section
          class="coverage"
          aria-labelledby="coverage-title"
        >
          <header class="section-heading">
            <div>
              <h2 id="coverage-title">
                覆盖率矩阵
              </h2>
              <p>每个状态同时使用文字和边界表达；不由前端推断发布资格。</p>
            </div>
            <label class="gap-filter">
              <input
                v-model="showOnlyGaps"
                type="checkbox"
              >
              只看缺口
            </label>
          </header>

          <div class="table-scroll">
            <table data-coverage-table>
              <thead>
                <tr>
                  <th scope="col">
                    单词
                  </th>
                  <th scope="col">
                    阶段
                  </th>
                  <th scope="col">
                    题型
                  </th>
                  <th scope="col">
                    状态
                  </th>
                  <th scope="col">
                    练习详情
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(cell, index) in visibleCells"
                  :key="`${cell.wordId}-${cell.stage}-${cell.taskType}-${String(index)}`"
                >
                  <th
                    scope="row"
                    lang="en"
                  >
                    {{ cell.word }}
                  </th>
                  <td>{{ cell.stage }}</td>
                  <td>{{ taskTypeLabel(cell.taskType) }}</td>
                  <td>
                    <span
                      class="cell-status"
                      :data-status="cell.status"
                    >{{ itemStatusLabel(cell.status) }}</span>
                  </td>
                  <td>
                    <router-link
                      v-if="cell.itemId"
                      class="row-link"
                      :to="`/admin/source-versions/${encodeURIComponent(detail.versionId)}/exercises/${encodeURIComponent(cell.itemId)}`"
                    >
                      查看项目
                    </router-link>
                    <span v-else>尚无项目</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          v-if="isMutable && draftItems.length > 0"
          class="approval"
          aria-labelledby="approval-title"
        >
          <header class="section-heading">
            <div>
              <h2 id="approval-title">
                待审批练习
              </h2>
              <p>只对明确勾选的真实草稿执行批准；超过单次上限时自动分批。</p>
            </div>
            <label class="approval-select-all">
              <input
                v-model="allDraftsSelected"
                data-select-all
                type="checkbox"
              >
              全选待审批
            </label>
          </header>
          <ul>
            <li
              v-for="item in draftItems"
              :key="item.id"
            >
              <label>
                <input
                  v-model="selectedItemIds"
                  type="checkbox"
                  :value="item.id"
                >
                <span><strong lang="en">{{ item.word }}</strong> · {{ item.stage }} · {{ taskTypeLabel(item.taskType) }}</span>
              </label>
              <router-link
                class="approval-link"
                :to="`/admin/source-versions/${encodeURIComponent(detail.versionId)}/exercises/${encodeURIComponent(item.id)}`"
              >
                先查看
              </router-link>
            </li>
          </ul>
          <ui-button
            data-approve-selected
            :disabled="selectedItemIds.length === 0 || actionState !== 'idle'"
            :loading="actionState === 'approving'"
            loading-label="正在批准"
            @click="approveSelected"
          >
            批准所选项目
          </ui-button>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-page,
.version-workspace,
.pipeline,
.coverage,
.approval,
.blockers,
.error-actions {
  display: grid;
}

.version-workspace {
  gap: var(--space-6);
}

.version-header,
.section-heading,
.command-bar,
.confirmation__actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.version-header p,
.version-header h1,
.section-heading h2,
.section-heading p,
.blockers ul,
.approval ul,
.pipeline ol,
.confirmation h2,
.confirmation p {
  margin: 0;
}

.back-link,
.row-link,
.primary-link {
  color: var(--color-brand-strong);
  font-size: 13px;
  font-weight: 700;
}

.back-link,
.row-link {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
}

.version-header p {
  margin-top: var(--space-2);
  color: var(--color-muted);
  font-size: 13px;
}

.version-header h1 {
  font-size: 28px;
}

.status-badge,
.cell-status {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  padding-inline: var(--space-2);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-style: normal;
  font-weight: 700;
}

.status-badge[data-status='published'],
.cell-status[data-status='approved'] {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.cell-status[data-status='draft'],
.cell-status[data-status='missing'] {
  border-style: dashed;
  border-color: var(--color-coral);
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
}

.pipeline,
.coverage,
.approval,
.blockers {
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.section-heading h2 {
  font-size: 18px;
}

.section-heading p,
.section-heading > span {
  margin-top: 2px;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.55;
}

.pipeline ol {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 0;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  list-style: none;
}

.pipeline li {
  display: grid;
  gap: 2px;
  min-height: 84px;
  align-content: center;
  padding: var(--space-3);
  border-right: 1px solid var(--color-line);
}

.pipeline li:last-child {
  border-right: 0;
}

.pipeline span,
.pipeline em {
  color: var(--color-muted);
  font-size: 12px;
  font-style: normal;
}

.command-bar {
  justify-content: flex-start;
  flex-wrap: wrap;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

.primary-link {
  justify-self: start;
  min-height: 40px;
  padding: 10px var(--space-4);
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  text-decoration: none;
}

.blockers ul,
.approval ul {
  padding: 0;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  list-style: none;
}

.blockers li,
.approval li {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
  font-size: 13px;
}

.blockers li:last-child,
.approval li:last-child {
  border-bottom: 0;
}

.blockers li > span {
  color: var(--color-muted);
}

.approval label,
.gap-filter {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 650;
}

.approval-link {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
}

.approval > .ui-button {
  justify-self: start;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

table {
  width: 100%;
  min-width: 680px;
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
  background: var(--color-canvas);
  color: var(--color-muted);
  font-size: 12px;
}

tbody tr:last-child > * {
  border-bottom: 0;
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

.confirmation__actions {
  justify-content: flex-start;
}

.error-actions {
  justify-items: start;
  gap: var(--space-3);
}

@media (max-width: 767px) {
  .pipeline ol {
    grid-template-columns: 1fr 1fr;
  }

  .pipeline li:nth-child(2) {
    border-right: 0;
  }

  .pipeline li:nth-child(-n + 2) {
    border-bottom: 1px solid var(--color-line);
  }

  .version-header,
  .section-heading,
  .blockers li,
  .approval li {
    align-items: stretch;
  }

  .version-header,
  .section-heading,
  .blockers li,
  .approval li {
    display: grid;
  }
}
</style>
