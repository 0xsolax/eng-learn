<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  AdminExerciseItemDto,
  BuildCoverageDto,
  ExerciseReviewWindowDto,
  SourceVersionDetailDto,
} from '@shared/api/contentSchemas'
import { MAX_BATCH_APPROVAL_ITEMS } from '@shared/api/contentSchemas'
import { ArchiveX, Hammer, Send } from '@lucide/vue'
import { createAdminApi } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { useAdminPageContext } from '@/features/admin-auth/adminPageContext'

type VersionDetailApi = Pick<
  ReturnType<typeof createAdminApi>,
  | 'approveExerciseItems'
  | 'buildSourceVersion'
  | 'discardSourceVersion'
  | 'getCoverage'
  | 'getExerciseReviewWindow'
  | 'getSourceVersion'
  | 'listExerciseItems'
  | 'publishSourceVersion'
>
type PageState = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'building' | 'approving' | 'publishing' | 'discarding'
const MATRIX_STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const
type CoverageCell = BuildCoverageDto['cells'][number]
type MatrixStage = (typeof MATRIX_STAGES)[number]
type MatrixRow = {
  wordId: string
  word: string
  cellsByStage: Record<MatrixStage, CoverageCell[]>
}

const props = defineProps<{
  api?: VersionDetailApi
  versionId: string
}>()

const api = props.api ?? createAdminApi()
const pageContext = useAdminPageContext()
const pageState = ref<PageState>('loading')
const detail = ref<SourceVersionDetailDto | null>(null)
const coverage = ref<BuildCoverageDto | null>(null)
const exerciseItems = ref<AdminExerciseItemDto[]>([])
const reviewSummary = ref<ExerciseReviewWindowDto | null>(null)
const actionState = ref<ActionState>('idle')
const actionError = ref('')
const actionSuccess = ref('')
const showOnlyGaps = ref(false)
const confirmation = ref<'publish' | 'discard' | null>(null)
const confirmationRegion = ref<HTMLElement | null>(null)
const compactMediaQuery = window.matchMedia('(max-width: 479px)')
const isCompactReadOnly = ref(compactMediaQuery.matches)
let confirmationTrigger: HTMLElement | null = null

const isMutable = computed(() => detail.value?.status === 'draft')
const canMutate = computed(() => isMutable.value && !isCompactReadOnly.value)
const draftItems = computed(() => exerciseItems.value.filter((item) => item.status === 'draft'))
const canApproveAllDrafts = computed(
  () =>
    draftItems.value.length > 0 &&
    reviewSummary.value !== null &&
    reviewSummary.value.needsReworkCount === 0 &&
    reviewSummary.value.disabledCount === 0 &&
    !(coverage.value?.cells.some((cell) => cell.status === 'disabled') ?? false) &&
    !(coverage.value?.missingItems.some((item) => item.reason !== 'exercise_item_draft') ?? false),
)
const matrixRows = computed<MatrixRow[]>(() => {
  const rows = new Map<string, MatrixRow>()

  for (const cell of coverage.value?.cells ?? []) {
    const existing = rows.get(cell.wordId)
    const row = existing ?? {
      wordId: cell.wordId,
      word: cell.word,
      cellsByStage: createEmptyMatrixCells(),
    }
    row.cellsByStage[cell.stage].push(cell)
    rows.set(cell.wordId, row)
  }

  return [...rows.values()]
})
const visibleMatrixRows = computed(() =>
  showOnlyGaps.value
    ? matrixRows.value.filter((row) =>
        MATRIX_STAGES.some((stage) =>
          row.cellsByStage[stage].some((cell) => cell.status !== 'approved'),
        ),
      )
    : matrixRows.value,
)
const blockerRows = computed(() =>
  (detail.value?.missingItems ?? []).map((item) => {
    const matchingCell = coverage.value?.cells.find(
      (cell) =>
        cell.word === item.word &&
        cell.stage === item.stage &&
        cell.taskType === item.taskType,
    )

    return {
      ...item,
      itemId: matchingCell?.itemId ?? null,
    }
  }),
)

const createEmptyMatrixCells = (): Record<MatrixStage, CoverageCell[]> => ({
  S0: [],
  S1: [],
  S2: [],
  S3: [],
  S4: [],
  S5: [],
})

const openConfirmation = async (
  kind: 'publish' | 'discard',
  event: MouseEvent,
): Promise<void> => {
  if (
    !canMutate.value ||
    actionState.value !== 'idle' ||
    (kind === 'publish' && !detail.value?.readyToPublish)
  ) {
    return
  }

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
    const nextDetail = await api.getSourceVersion(props.versionId)
    const [nextCoverage, nextItems, nextReviewSummary] = await Promise.all([
      api.getCoverage(props.versionId),
      api.listExerciseItems(props.versionId),
      nextDetail.status === 'draft'
        ? api.getExerciseReviewWindow(props.versionId)
        : Promise.resolve(null),
    ])
    detail.value = nextDetail
    coverage.value = nextCoverage
    exerciseItems.value = nextItems
    reviewSummary.value = nextReviewSummary
    reportPageContext(nextDetail)
    pageState.value = 'ready'
  } catch {
    detail.value = null
    coverage.value = null
    exerciseItems.value = []
    reviewSummary.value = null
    pageContext.clearPageContext()
    pageState.value = 'error'
  }
}

const buildVersion = async (): Promise<void> => {
  if (!canMutate.value || actionState.value !== 'idle') return
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

const approveAllDrafts = async (): Promise<void> => {
  if (
    !canMutate.value ||
    !canApproveAllDrafts.value ||
    actionState.value !== 'idle'
  ) {
    return
  }

  actionState.value = 'approving'
  actionError.value = ''
  actionSuccess.value = ''
  let confirmedApprovedCount = 0
  const itemIdsToApprove = draftItems.value.map((item) => item.id)

  try {
    for (const itemIds of chunkIds(itemIdsToApprove, MAX_BATCH_APPROVAL_ITEMS)) {
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
  if (!detail.value?.readyToPublish || !canMutate.value || actionState.value !== 'idle') return
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
  if (!canMutate.value || actionState.value !== 'idle') return
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
  const nextDetail = await api.getSourceVersion(props.versionId)
  const [nextCoverage, nextItems, nextReviewSummary] = await Promise.all([
    api.getCoverage(props.versionId),
    api.listExerciseItems(props.versionId),
    nextDetail.status === 'draft'
      ? api.getExerciseReviewWindow(props.versionId)
      : Promise.resolve(null),
  ])
  detail.value = nextDetail
  coverage.value = nextCoverage
  exerciseItems.value = nextItems
  reviewSummary.value = nextReviewSummary
  reportPageContext(nextDetail)
}

const reportPageContext = (nextDetail: SourceVersionDetailDto): void => {
  pageContext.setPageContext({
    breadcrumbs: ['词库工作台', nextDetail.sourceName, `v${String(nextDetail.versionNo)}`],
  })
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
  reviewSummary.value = null
  confirmation.value = null
  actionError.value = message
  pageContext.clearPageContext()
  pageState.value = 'error'
}

const getActionError = (error: unknown, fallback: string): string => {
  if (error instanceof ApiFailureError && error.code === 'source_version_immutable') {
    return '服务端确认该版本已不可修改，请重新读取后创建下一版本。'
  }

  if (error instanceof ApiFailureError && error.code === 'coverage_incomplete') {
    return '服务端仍报告覆盖缺口，请按发布阻断项继续审批。'
  }

  if (error instanceof ApiFailureError && error.code === 'review_feedback_open') {
    return '存在待处理反馈，已停止全部通过；请进入审阅模式处理。'
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

const syncCompactReadOnly = (event: MediaQueryListEvent): void => {
  isCompactReadOnly.value = event.matches

  if (event.matches) {
    confirmation.value = null
  }
}

onMounted(() => {
  compactMediaQuery.addEventListener('change', syncCompactReadOnly)
  void loadWorkspace()
})

onBeforeUnmount(() => {
  compactMediaQuery.removeEventListener('change', syncCompactReadOnly)
  pageContext.clearPageContext()
})
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
          v-if="canMutate"
          data-command-bar
          class="command-bar"
          aria-label="版本操作"
        >
          <div class="command-copy">
            <strong>版本命令</strong>
            <span
              v-if="detail.readyToPublish"
              class="command-ready"
            >服务端已确认覆盖完备，可进入发布确认。</span>
            <span
              v-else
              data-publish-blocker
              class="publish-blocker-summary"
            >
              当前有 {{ detail.missingItems.length }} 项发布阻断，请先处理下方项目。
            </span>
          </div>
          <div class="command-actions">
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
              <archive-x
                :size="18"
                aria-hidden="true"
              />
              丢弃草稿
            </ui-button>
          </div>
        </section>

        <router-link
          v-if="detail.status === 'published' && !isCompactReadOnly"
          data-next-version
          class="primary-link"
          :to="{
            path: '/admin/source-versions',
            query: { mode: 'next_version', sourceId: detail.sourceId },
          }"
        >
          创建下一草稿版本
        </router-link>

        <ui-status-message
          v-if="isCompactReadOnly"
          data-compact-readonly
          tone="info"
          title="当前仅供查看"
        >
          请使用至少 480px 宽的设备执行构建、发布、丢弃、审批或创建下一草稿版本。
        </ui-status-message>

        <section
          data-pipeline
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

        <div class="coverage-layout">
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
            <div
              class="blocker-scroll"
              data-scroll-region="publish-blockers"
              tabindex="0"
              aria-label="发布阻断项列表"
            >
              <ul>
                <li
                  v-for="(item, index) in blockerRows"
                  :key="`${item.word}-${item.stage}-${item.taskType}-${String(index)}`"
                  data-blocker-item
                >
                  <div class="blocker-facts">
                    <strong lang="en">{{ item.word }} · {{ item.stage }}</strong>
                    <span>题型 {{ taskTypeLabel(item.taskType) }}</span>
                    <span>原因 {{ reasonLabel(item.reason) }}</span>
                  </div>
                  <router-link
                    v-if="item.itemId"
                    class="row-link"
                    :to="`/admin/source-versions/${encodeURIComponent(detail.versionId)}/exercises/${encodeURIComponent(item.itemId)}`"
                  >
                    打开练习
                  </router-link>
                  <span v-else>暂无可处理项目</span>
                </li>
              </ul>
            </div>
          </section>

          <section
            data-coverage-matrix
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
                  data-gap-filter
                  type="checkbox"
                >
                只看缺口
              </label>
            </header>

            <div
              class="table-scroll matrix-scroll"
              data-scroll-region="coverage-matrix"
              tabindex="0"
              aria-label="单词与 S0 至 S5 覆盖率矩阵"
            >
              <table data-coverage-table>
                <thead>
                  <tr>
                    <th scope="col">
                      单词
                    </th>
                    <th
                      v-for="stage in MATRIX_STAGES"
                      :key="stage"
                      data-matrix-stage
                      scope="col"
                    >
                      {{ stage }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in visibleMatrixRows"
                    :key="row.wordId"
                    data-matrix-row
                  >
                    <th
                      scope="row"
                      lang="en"
                    >
                      {{ row.word }}
                    </th>
                    <td
                      v-for="stage in MATRIX_STAGES"
                      :key="stage"
                      :data-stage="stage"
                    >
                      <div
                        v-if="row.cellsByStage[stage].length > 0"
                        class="matrix-cell"
                      >
                        <template
                          v-for="cell in row.cellsByStage[stage]"
                          :key="`${cell.taskType}-${cell.itemId ?? 'missing'}`"
                        >
                          <router-link
                            v-if="cell.itemId"
                            class="matrix-entry matrix-entry--link"
                            :data-status="cell.status"
                            :aria-label="`${row.word} ${stage} ${taskTypeLabel(cell.taskType)} ${itemStatusLabel(cell.status)}，打开练习`"
                            :to="`/admin/source-versions/${encodeURIComponent(detail.versionId)}/exercises/${encodeURIComponent(cell.itemId)}`"
                          >
                            <span
                              class="cell-status"
                              :data-status="cell.status"
                            >{{ itemStatusLabel(cell.status) }}</span>
                            <small>{{ taskTypeLabel(cell.taskType) }}</small>
                          </router-link>
                          <span
                            v-else
                            class="matrix-entry"
                            :data-status="cell.status"
                            :aria-label="`${row.word} ${stage} ${taskTypeLabel(cell.taskType)} ${itemStatusLabel(cell.status)}`"
                          >
                            <span
                              class="cell-status"
                              :data-status="cell.status"
                            >{{ itemStatusLabel(cell.status) }}</span>
                            <small>{{ taskTypeLabel(cell.taskType) }}</small>
                          </span>
                        </template>
                      </div>
                      <span
                        v-else
                        class="matrix-empty"
                      >无数据</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p
                v-if="showOnlyGaps && visibleMatrixRows.length === 0"
                data-gap-empty
                class="matrix-filter-empty"
                role="status"
              >
                当前条件下没有缺口。
              </p>
            </div>
          </section>
        </div>

        <section
          v-if="canMutate && exerciseItems.length > 0"
          :data-approval-list="draftItems.length > 0 ? '' : undefined"
          data-review-actions
          class="approval"
          aria-labelledby="approval-title"
        >
          <header class="section-heading">
            <div>
              <h2 id="approval-title">
                审阅与批准
              </h2>
              <p
                v-if="reviewSummary"
                data-review-summary
              >
                待审阅 {{ reviewSummary.pendingCount }} ·
                需重构 {{ reviewSummary.needsReworkCount }} ·
                已批准 {{ reviewSummary.approvedCount }} ·
                已禁用 {{ reviewSummary.disabledCount }}。
              </p>
            </div>
          </header>
          <div class="approval-actions">
            <router-link
              data-enter-review
              class="primary-link"
              :to="`/admin/source-versions/${encodeURIComponent(detail.versionId)}/review`"
            >
              进入审阅模式
            </router-link>
            <ui-button
              v-if="draftItems.length > 0"
              data-approve-all
              variant="secondary"
              :disabled="!canApproveAllDrafts || actionState !== 'idle'"
              :loading="actionState === 'approving'"
              loading-label="正在批准"
              @click="approveAllDrafts"
            >
              全部通过（{{ draftItems.length }} 项）
            </ui-button>
          </div>
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
  min-width: 0;
  gap: var(--space-6);
}

.coverage-layout {
  display: grid;
  min-width: 0;
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
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
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

.status-badge[data-status='draft'],
.cell-status[data-status='draft'] {
  border-color: color-mix(in srgb, var(--color-sun) 60%, var(--color-line));
  background: var(--color-sun-soft);
  color: #71550a;
}

.cell-status[data-status='missing'] {
  border-style: dashed;
  border-color: var(--color-coral);
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
}

.status-badge[data-status='archived'],
.cell-status[data-status='disabled'] {
  background: var(--color-canvas);
  color: var(--color-muted);
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
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.command-copy {
  display: grid;
  gap: 2px;
}

.command-copy strong {
  font-size: 13px;
}

.command-copy span {
  font-size: 12px;
  line-height: 1.45;
}

.command-ready {
  color: var(--color-brand-strong);
}

.publish-blocker-summary {
  color: var(--color-coral-strong);
  font-weight: 650;
}

.command-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
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

.blocker-scroll,
.matrix-scroll {
  max-height: clamp(280px, 52vh, 520px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.blocker-scroll {
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

.blockers ul {
  padding: 0;
  list-style: none;
}

.blockers li {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
  font-size: 13px;
}

.blocker-facts {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(110px, 0.7fr) minmax(120px, 0.9fr) minmax(160px, 1.4fr);
  align-items: center;
  gap: var(--space-3);
}

.blocker-facts > span {
  color: var(--color-muted);
}

.blockers li:last-child {
  border-bottom: 0;
}

.blockers li > span {
  color: var(--color-muted);
}

.gap-filter {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 650;
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

table {
  width: 100%;
  min-width: 900px;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  height: 44px;
  padding-block: var(--space-2);
  padding-inline: var(--space-3);
  border-bottom: 1px solid var(--color-line);
  text-align: left;
}

.blocker-scroll:focus-visible,
.matrix-scroll:focus-visible {
  outline: 3px solid var(--color-brand);
  outline-offset: 2px;
}

.matrix-scroll th:first-child,
.matrix-scroll td:first-child {
  position: sticky;
  z-index: 1;
  left: 0;
  min-width: 120px;
  background: var(--color-surface);
}

.matrix-scroll thead th {
  position: sticky;
  z-index: 2;
  top: 0;
}

.matrix-scroll thead th:first-child {
  z-index: 3;
  background: var(--color-canvas);
}

.matrix-cell {
  display: grid;
  gap: var(--space-1);
}

.matrix-entry {
  display: grid;
  justify-items: start;
  gap: 2px;
  min-width: 96px;
  color: var(--color-ink);
  text-decoration: none;
}

.matrix-entry--link:hover small {
  color: var(--color-brand-strong);
  text-decoration: underline;
}

.matrix-entry small,
.matrix-empty {
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.35;
}

.matrix-filter-empty {
  margin: 0;
  padding: var(--space-6);
  color: var(--color-muted);
  font-size: 13px;
  text-align: center;
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

@media (min-width: 1200px) {
  .command-bar {
    position: sticky;
    z-index: 4;
    top: calc(72px + var(--space-2));
  }
}

@media (min-width: 1280px) {
  .coverage-layout:has(.blockers) {
    grid-template-columns: 276px minmax(0, 1fr);
    align-items: start;
  }

  .coverage-layout > .coverage {
    grid-column: 2;
    grid-row: 1;
  }

  .coverage-layout > .blockers {
    grid-column: 1;
    grid-row: 1;
  }

  .coverage-layout > .blockers .section-heading,
  .coverage-layout > .blockers li,
  .coverage-layout > .blockers .blocker-facts {
    align-items: stretch;
    display: grid;
  }

  .coverage-layout > .blockers .blocker-facts {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
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
  .command-bar,
  .blockers li {
    align-items: stretch;
  }

  .version-header,
  .section-heading,
  .command-bar,
  .blockers li {
    display: grid;
  }

  .blocker-facts {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
}

@media (forced-colors: active) {
  .cell-status,
  .status-badge,
  .command-bar,
  .blocker-scroll,
  .table-scroll {
    border: 1px solid CanvasText;
  }
}
</style>
