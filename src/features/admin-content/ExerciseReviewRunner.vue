<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ExerciseReviewApi } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import TaskRenderer from '@/components/task-renderers/TaskRenderer.vue'
import ExerciseItemEditor from '@/features/admin-content/ExerciseItemEditor.vue'
import {
  EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH,
  type AdminExerciseItemDto,
  type ExerciseReviewEvaluateResult,
  type ExerciseReviewWindowDto,
} from '@shared/api/contentSchemas'
import type {
  ExerciseItemContent,
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
} from '@shared/api/taskSchemas'
import { taskRenderSchema } from '@shared/api/taskSchemas'

type PageState = 'loading' | 'ready' | 'error'
type ActionState =
  | 'idle'
  | 'previewing'
  | 'evaluating'
  | 'approving'
  | 'requesting_rework'
  | 'loading_correction'
  | 'correcting'
  | 'reloading'

const props = defineProps<{
  api: ExerciseReviewApi
  versionId: string
  itemId?: string
}>()

const emit = defineEmits<{
  'item-change': [itemId?: string]
}>()

const pageState = ref<PageState>('loading')
const actionState = ref<ActionState>('idle')
const reviewWindow = ref<ExerciseReviewWindowDto | null>(null)
const evaluation = ref<ExerciseReviewEvaluateResult | null>(null)
const referenceSentence = ref<string>()
const actionError = ref('')
const actionSuccess = ref('')
const feedbackPanelOpen = ref(false)
const feedbackText = ref('')
const feedbackError = ref('')
const correctionItem = ref<AdminExerciseItemDto | null>(null)
const feedbackPanel = ref<HTMLElement | null>(null)
const writeLocked = ref(false)
const versionImmutable = ref(false)
const compactMediaQuery = window.matchMedia('(max-width: 479px)')
const isCompactReadOnly = ref(compactMediaQuery.matches)
let loadSequence = 0
let feedbackTrigger: HTMLElement | null = null

const currentTask = computed(() => {
  const current = reviewWindow.value?.current

  return current
    ? taskRenderSchema.parse({
        id: current.id,
        stage: current.stage,
        taskType: current.taskType,
        prompt: current.prompt,
      })
    : null
})

const canApprove = computed(() => {
  const current = reviewWindow.value?.current

  return Boolean(
    current &&
      current.status === 'draft' &&
      current.reviewState === 'pending_review' &&
      !current.feedback &&
      evaluation.value &&
      actionState.value === 'idle' &&
      !writeLocked.value &&
      !isCompactReadOnly.value,
  )
})

const normalizedFeedback = computed(() => feedbackText.value.trim())
const feedbackCount = computed(() => normalizedFeedback.value.length)

const resetFeedbackPanel = (): void => {
  feedbackPanelOpen.value = false
  feedbackText.value = ''
  feedbackError.value = ''
  correctionItem.value = null
}

const applyWindow = (
  nextWindow: ExerciseReviewWindowDto,
  options: { closeFeedback?: boolean } = {},
): void => {
  reviewWindow.value = nextWindow
  writeLocked.value = false
  versionImmutable.value = false
  evaluation.value = null
  referenceSentence.value = undefined
  if (options.closeFeedback !== false) resetFeedbackPanel()
  pageState.value = 'ready'
  emit('item-change', nextWindow.current?.id)
}

const enterImmutableState = (error: unknown): boolean => {
  if (!(error instanceof ApiFailureError) || error.code !== 'source_version_immutable') {
    return false
  }

  reviewWindow.value = null
  evaluation.value = null
  referenceSentence.value = undefined
  resetFeedbackPanel()
  writeLocked.value = true
  versionImmutable.value = true
  pageState.value = 'error'
  actionError.value = '版本已不再是可审阅草稿，请返回版本详情查看当前状态。'
  return true
}

const loadReview = async (itemId?: string): Promise<void> => {
  const sequence = ++loadSequence
  pageState.value = 'loading'
  versionImmutable.value = false
  actionError.value = ''
  actionSuccess.value = ''

  try {
    const nextWindow = await props.api.getExerciseReviewWindow(props.versionId, itemId)
    if (sequence !== loadSequence) return
    applyWindow(nextWindow)
  } catch (error) {
    if (sequence !== loadSequence) return
    if (enterImmutableState(error)) return
    reviewWindow.value = null
    evaluation.value = null
    referenceSentence.value = undefined
    pageState.value = 'error'
  }
}

const openItem = (itemId: string | undefined): void => {
  if (!itemId || actionState.value !== 'idle' || writeLocked.value) return
  void loadReview(itemId)
}

const openFeedbackPanel = async (event: MouseEvent): Promise<void> => {
  const current = reviewWindow.value?.current
  if (!current || actionState.value !== 'idle' || writeLocked.value) return

  feedbackTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  feedbackText.value = current.feedback?.text ?? ''
  feedbackError.value = ''
  correctionItem.value = null
  feedbackPanelOpen.value = true
  await nextTick()
  feedbackPanel.value?.focus()
}

const closeFeedbackPanel = async (): Promise<void> => {
  if (actionState.value !== 'idle' || writeLocked.value) return
  resetFeedbackPanel()
  await nextTick()
  feedbackTrigger?.focus()
}

const loadCorrection = async (): Promise<void> => {
  const current = reviewWindow.value?.current
  if (!current || actionState.value !== 'idle' || writeLocked.value) return

  actionState.value = 'loading_correction'
  actionError.value = ''

  try {
    const item = await props.api.getExerciseItem(current.id)
    if (
      item.id !== current.id ||
      item.sourceVersionId !== props.versionId ||
      item.stage !== current.stage ||
      item.taskType !== current.taskType
    ) {
      throw new Error('Correction item does not match the review item')
    }
    correctionItem.value = item
  } catch (error) {
    if (enterImmutableState(error)) return
    correctionItem.value = null
    actionError.value = '完整练习读取失败，未进入更正状态，可重试。'
  } finally {
    actionState.value = 'idle'
  }
}

const confirmsRework = (
  window: ExerciseReviewWindowDto,
  itemId: string,
  feedback: string,
  expectedContentRevision: number,
): boolean =>
  window.contentRevision === expectedContentRevision + 1 &&
  window.current?.id === itemId &&
  window.current.status === 'draft' &&
  window.current.reviewState === 'needs_rework' &&
  window.current.feedback?.text === feedback

const recoverRework = async (
  itemId: string,
  feedback: string,
  expectedContentRevision: number,
): Promise<boolean> => {
  const confirmed = await props.api.getExerciseReviewWindow(props.versionId, itemId)

  if (!confirmsRework(confirmed, itemId, feedback, expectedContentRevision)) {
    const revisionChanged = confirmed.contentRevision !== expectedContentRevision
    applyWindow(confirmed, { closeFeedback: revisionChanged })
    actionError.value = revisionChanged
      ? '打回未完成；内容可能已变化，请基于最新内容重新决定。'
      : '打回未完成；反馈输入已保留，可原地重试。'
    return false
  }

  applyWindow(await props.api.getExerciseReviewWindow(props.versionId))
  actionSuccess.value = '当前练习已打回重构，反馈已由服务端确认。'
  return true
}

const requestRework = async (): Promise<void> => {
  const current = reviewWindow.value?.current
  const expectedContentRevision = reviewWindow.value?.contentRevision
  const feedback = normalizedFeedback.value
  if (
    !current ||
    expectedContentRevision === undefined ||
    actionState.value !== 'idle' ||
    writeLocked.value
  ) return

  feedbackError.value = ''
  if (feedback.length < 1) {
    feedbackError.value = '请填写需要重构的问题。'
    return
  }
  if (feedback.length > EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH) {
    feedbackError.value = `反馈不能超过 ${String(EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH)} 个字符。`
    return
  }

  actionState.value = 'requesting_rework'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await props.api.decideExerciseReview(current.id, {
      action: 'request_rework',
      expectedContentRevision,
      feedback,
    })
    await recoverRework(current.id, feedback, expectedContentRevision)
  } catch (error) {
    if (enterImmutableState(error)) return
    try {
      await recoverRework(current.id, feedback, expectedContentRevision)
    } catch (recoveryError) {
      if (enterImmutableState(recoveryError)) return
      writeLocked.value = true
      actionError.value = '打回结果和服务端状态均无法确认；输入仍保留，请重新读取后再决定。'
    }
  } finally {
    actionState.value = 'idle'
  }
}

const itemMatchesContent = (
  item: AdminExerciseItemDto,
  content: ExerciseItemContent,
): boolean =>
  item.stage === content.stage &&
  item.taskType === content.taskType &&
  JSON.stringify(item.prompt) === JSON.stringify(content.prompt) &&
  JSON.stringify(item.answer) === JSON.stringify(content.answer)

const recoverCorrection = async (
  itemId: string,
  content: ExerciseItemContent,
  expectedContentRevision: number,
): Promise<boolean> => {
  const item = await props.api.getExerciseItem(itemId)
  const confirmed = await props.api.getExerciseReviewWindow(props.versionId, itemId)
  const current = confirmed.current

  if (
    confirmed.contentRevision !== expectedContentRevision + 1 ||
    current?.id !== itemId ||
    current.status !== 'draft' ||
    current.reviewState !== 'pending_review' ||
    current.feedback ||
    !itemMatchesContent(item, content)
  ) {
    const revisionChanged = confirmed.contentRevision !== expectedContentRevision
    applyWindow(confirmed, { closeFeedback: revisionChanged })
    actionError.value = revisionChanged
      ? '更正未完成或内容已变化，请基于最新内容重新决定。'
      : '更正未完成，当前表单内容已保留，可原地重试。'
    return false
  }

  applyWindow(confirmed)
  actionSuccess.value = '练习内容已更正；请重新体验并判题后再通过。'
  return true
}

const correctExercise = async (content: ExerciseItemContent): Promise<void> => {
  const current = reviewWindow.value?.current
  const expectedContentRevision = reviewWindow.value?.contentRevision
  if (
    !current ||
    expectedContentRevision === undefined ||
    actionState.value !== 'idle' ||
    writeLocked.value
  ) return
  if (correctionItem.value && itemMatchesContent(correctionItem.value, content)) {
    actionError.value = '请先实际修改提示或答案，再保存更正。'
    return
  }

  actionState.value = 'correcting'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await props.api.decideExerciseReview(current.id, {
      action: 'correct',
      expectedContentRevision,
      content,
    })
    await recoverCorrection(current.id, content, expectedContentRevision)
  } catch (error) {
    if (enterImmutableState(error)) return
    try {
      await recoverCorrection(current.id, content, expectedContentRevision)
    } catch (recoveryError) {
      if (enterImmutableState(recoveryError)) return
      writeLocked.value = true
      actionError.value = '更正结果和服务端状态均无法确认；表单仍保留，请重新读取后再决定。'
    }
  } finally {
    actionState.value = 'idle'
  }
}

const preview = async (request: SentenceOutputPreviewRequest): Promise<void> => {
  const current = reviewWindow.value?.current
  if (!current || actionState.value !== 'idle' || writeLocked.value) return

  actionState.value = 'previewing'
  actionError.value = ''

  try {
    const result = await props.api.previewExerciseReview(current.id, {
      expectedContentRevision: reviewWindow.value?.contentRevision ?? 0,
      ...request,
    })
    referenceSentence.value = result.referenceSentence
  } catch (error) {
    if (enterImmutableState(error)) return
    actionError.value = '参考句读取失败，当前草稿已保留，可重试。'
  } finally {
    actionState.value = 'idle'
  }
}

const evaluate = async (submission: SubmitTaskAnswerRequest): Promise<void> => {
  const current = reviewWindow.value?.current
  if (!current || actionState.value !== 'idle' || writeLocked.value) return

  actionState.value = 'evaluating'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    evaluation.value = await props.api.evaluateExerciseReview(current.id, {
      expectedContentRevision: reviewWindow.value?.contentRevision ?? 0,
      submission,
    })
  } catch (error) {
    if (enterImmutableState(error)) return
    actionError.value = '模拟判题失败，当前答案已保留，可重试。'
  } finally {
    actionState.value = 'idle'
  }
}

const approve = async (): Promise<void> => {
  const current = reviewWindow.value?.current
  const expectedContentRevision = reviewWindow.value?.contentRevision
  if (!current || expectedContentRevision === undefined || !canApprove.value) return

  actionState.value = 'approving'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    await props.api.decideExerciseReview(current.id, {
      action: 'approve',
      expectedContentRevision,
    })
    const nextWindow = await props.api.getExerciseReviewWindow(props.versionId)
    applyWindow(nextWindow)
    actionSuccess.value = '当前练习已通过，已重新读取服务端审阅进度。'
  } catch (error) {
    if (enterImmutableState(error)) return
    try {
      const latest = await props.api.getExerciseReviewWindow(props.versionId, current.id)
      if (
        latest.contentRevision === expectedContentRevision + 1 &&
        latest.current?.status === 'approved'
      ) {
        applyWindow(await props.api.getExerciseReviewWindow(props.versionId))
        actionSuccess.value = '批准响应未确认；权威重读显示当前练习已经通过。'
      } else {
        applyWindow(latest)
        actionError.value = '批准未完成；内容可能已变化，请重新体验后决定。'
      }
    } catch (recoveryError) {
      if (enterImmutableState(recoveryError)) return
      reviewWindow.value = null
      pageState.value = 'error'
      actionError.value = '批准结果和服务端状态均无法确认，请完整重试。'
    }
  } finally {
    actionState.value = 'idle'
  }
}

const reloadAuthoritative = async (): Promise<void> => {
  const currentId = reviewWindow.value?.current?.id
  if (!writeLocked.value || actionState.value !== 'idle') return

  actionState.value = 'reloading'
  actionError.value = ''
  actionSuccess.value = ''

  try {
    const nextWindow = await props.api.getExerciseReviewWindow(props.versionId, currentId)
    applyWindow(nextWindow)
    actionSuccess.value = '已重新读取服务端状态；请基于当前内容重新体验并决定。'
  } catch (error) {
    if (enterImmutableState(error)) return
    actionError.value = '服务端状态仍无法读取；已继续锁定写操作并保留当前输入。'
  } finally {
    actionState.value = 'idle'
  }
}

const syncCompactReadOnly = (event: MediaQueryListEvent): void => {
  isCompactReadOnly.value = event.matches
  evaluation.value = null
  referenceSentence.value = undefined
  if (event.matches) resetFeedbackPanel()
}

watch(
  () => [props.versionId, props.itemId] as const,
  ([versionId, itemId]) => {
    if (
      reviewWindow.value?.sourceVersionId === versionId &&
      reviewWindow.value.current?.id === itemId
    ) {
      return
    }
    void loadReview(itemId)
  },
  { immediate: true },
)

compactMediaQuery.addEventListener('change', syncCompactReadOnly)

onBeforeUnmount(() => {
  compactMediaQuery.removeEventListener('change', syncCompactReadOnly)
})
</script>

<template>
  <section
    data-review-runner
    class="review-runner"
  >
    <ui-status-message
      v-if="pageState === 'loading'"
      tone="info"
      title="正在读取审阅项目"
    >
      只读取当前题目的展示内容和服务端审阅进度。
    </ui-status-message>

    <div
      v-else-if="pageState === 'error'"
      :data-review-immutable="versionImmutable ? '' : undefined"
      class="review-error"
    >
      <ui-status-message
        tone="error"
        title="无法读取审阅状态"
      >
        {{ actionError || '页面不会继续显示可能过期的练习内容。' }}
      </ui-status-message>
      <ui-button
        v-if="!versionImmutable"
        variant="secondary"
        @click="loadReview(itemId)"
      >
        重新读取
      </ui-button>
      <router-link
        data-review-back-after-error
        class="review-primary-link"
        :to="`/admin/source-versions/${encodeURIComponent(versionId)}`"
      >
        返回版本详情
      </router-link>
    </div>

    <template v-else-if="reviewWindow">
      <header class="review-header">
        <div>
          <router-link
            class="review-back"
            :to="`/admin/source-versions/${encodeURIComponent(versionId)}`"
          >
            返回版本详情
          </router-link>
          <p>{{ reviewWindow.sourceName }} · v{{ reviewWindow.versionNo }}</p>
          <h1>练习审阅</h1>
        </div>
        <strong
          v-if="reviewWindow.current"
          data-review-progress
        >
          {{ reviewWindow.current.position }} / {{ reviewWindow.totalCount }}
        </strong>
      </header>

      <div
        class="review-counts"
        aria-label="审阅状态汇总"
      >
        <span>待审阅 {{ reviewWindow.pendingCount }}</span>
        <span>需重构 {{ reviewWindow.needsReworkCount }}</span>
        <span>已批准 {{ reviewWindow.approvedCount }}</span>
        <span>已禁用 {{ reviewWindow.disabledCount }}</span>
      </div>

      <ui-status-message
        v-if="isCompactReadOnly"
        data-review-readonly
        tone="info"
        title="当前仅供查看"
      >
        请使用至少 480px 宽的设备进行模拟作答、反馈或批准。
      </ui-status-message>

      <section
        v-else-if="reviewWindow.allApproved && !reviewWindow.current"
        data-review-complete
        class="review-complete"
      >
        <h2>全部审阅通过</h2>
        <p>当前版本的练习均已批准，可以返回版本详情继续发布。</p>
        <div class="review-actions">
          <ui-button
            v-if="reviewWindow.firstItemId"
            variant="secondary"
            @click="openItem(reviewWindow.firstItemId)"
          >
            从头复查
          </ui-button>
          <router-link
            class="review-primary-link"
            :to="`/admin/source-versions/${encodeURIComponent(versionId)}`"
          >
            返回版本详情
          </router-link>
        </div>
      </section>

      <template v-else-if="reviewWindow.current && currentTask">
        <nav
          class="review-navigation"
          aria-label="练习审阅导航"
        >
          <ui-button
            data-review-previous
            variant="secondary"
            :disabled="!reviewWindow.previousItemId || actionState !== 'idle' || writeLocked"
            @click="openItem(reviewWindow.previousItemId)"
          >
            上一题
          </ui-button>
          <ui-button
            data-review-next
            variant="secondary"
            :disabled="!reviewWindow.nextItemId || actionState !== 'idle' || writeLocked"
            @click="openItem(reviewWindow.nextItemId)"
          >
            下一题
          </ui-button>
        </nav>

        <article class="review-card">
          <header class="review-item-header">
            <div>
              <span>{{ reviewWindow.current.stage }} · {{ reviewWindow.current.taskType }}</span>
              <h2 lang="en">
                {{ reviewWindow.current.word }}
              </h2>
            </div>
            <strong>{{ reviewWindow.current.reviewState }}</strong>
          </header>

          <ui-status-message
            v-if="reviewWindow.current.feedback"
            data-review-open-feedback
            tone="info"
            title="当前仍有待处理反馈"
          >
            <p>{{ reviewWindow.current.feedback.text }}</p>
            <time :datetime="reviewWindow.current.feedback.requestedAt">
              {{ reviewWindow.current.feedback.requestedAt }}
            </time>
          </ui-status-message>

          <task-renderer
            :key="`${reviewWindow.current.id}:${String(reviewWindow.contentRevision)}`"
            :task="currentTask"
            :disabled="actionState !== 'idle' || writeLocked"
            v-bind="referenceSentence === undefined ? {} : { referenceSentence }"
            @preview="preview"
            @submit="evaluate"
          />

          <section
            v-if="feedbackPanelOpen"
            ref="feedbackPanel"
            data-feedback-panel
            class="feedback-panel"
            role="dialog"
            aria-label="练习反馈与更正"
            tabindex="-1"
            @keydown.esc.stop.prevent="closeFeedbackPanel"
          >
            <header class="feedback-panel__header">
              <div>
                <h3>反馈与更正</h3>
                <p>选择打回重构，或读取完整答案后直接更正。</p>
              </div>
              <ui-button
                variant="secondary"
                :disabled="actionState !== 'idle' || writeLocked"
                @click="closeFeedbackPanel"
              >
                关闭
              </ui-button>
            </header>

            <label class="feedback-field">
              <span>重构反馈</span>
              <textarea
                v-model="feedbackText"
                data-review-feedback-text
                rows="5"
                :maxlength="EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH + 1"
                :aria-invalid="feedbackError ? 'true' : undefined"
                :aria-describedby="feedbackError ? 'review-feedback-error' : 'review-feedback-count'"
                :disabled="actionState !== 'idle' || writeLocked"
              />
              <small
                id="review-feedback-count"
                data-review-feedback-count
              >
                {{ feedbackCount }} / {{ EXERCISE_REVIEW_FEEDBACK_MAX_LENGTH }}
              </small>
              <small
                v-if="feedbackError"
                id="review-feedback-error"
                role="alert"
                class="feedback-error"
              >
                {{ feedbackError }}
              </small>
            </label>

            <div class="review-actions">
              <ui-button
                data-review-request-rework
                :loading="actionState === 'requesting_rework'"
                loading-label="正在打回"
                :disabled="actionState !== 'idle' || writeLocked"
                @click="requestRework"
              >
                打回重构
              </ui-button>
              <ui-button
                data-review-direct-correction
                variant="secondary"
                :loading="actionState === 'loading_correction'"
                loading-label="正在读取"
                :disabled="actionState !== 'idle' || writeLocked"
                @click="loadCorrection"
              >
                直接更正
              </ui-button>
            </div>

            <div
              v-if="correctionItem"
              data-review-correction
              class="review-correction"
            >
              <h4>结构化更正</h4>
              <exercise-item-editor
                :item="correctionItem"
                :readonly="writeLocked"
                :saving="actionState === 'correcting'"
                @save="correctExercise"
              />
            </div>
          </section>

          <ui-status-message
            v-if="evaluation"
            data-review-evaluation
            :tone="evaluation.correct ? 'success' : 'info'"
            :title="evaluation.correct ? '判定通过' : '判定未通过'"
          >
            模拟结果只用于本次审阅，不会写入学生课程、课时或答题记录。
          </ui-status-message>

          <ui-status-message
            v-if="actionError"
            :data-review-recovery-lock="writeLocked ? '' : undefined"
            tone="error"
            title="操作未完成"
          >
            {{ actionError }}
          </ui-status-message>

          <ui-button
            v-if="writeLocked"
            data-review-reload-authoritative
            variant="secondary"
            :loading="actionState === 'reloading'"
            loading-label="正在重新读取"
            @click="reloadAuthoritative"
          >
            重新读取服务端状态
          </ui-button>

          <ui-status-message
            v-if="actionSuccess"
            tone="success"
            title="服务端状态已更新"
          >
            {{ actionSuccess }}
          </ui-status-message>

          <div class="review-actions">
            <ui-button
              data-review-feedback
              variant="secondary"
              :disabled="actionState !== 'idle' || writeLocked"
              @click="openFeedbackPanel"
            >
              反馈
            </ui-button>
            <ui-button
              v-if="!reviewWindow.current.feedback"
              data-review-approve
              :disabled="!canApprove"
              :loading="actionState === 'approving'"
              loading-label="正在通过"
              @click="approve"
            >
              通过并下一题
            </ui-button>
          </div>
        </article>
      </template>

      <ui-status-message
        v-else
        tone="info"
        title="尚无可审阅练习"
      >
        请先返回版本详情构建练习。
      </ui-status-message>
    </template>
  </section>
</template>

<style scoped>
.review-runner,
.review-card,
.review-complete,
.review-error,
.feedback-panel,
.review-correction {
  display: grid;
  gap: var(--space-5);
}

.review-header,
.review-item-header,
.review-navigation,
.review-actions,
.review-counts,
.feedback-panel__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.review-header,
.review-item-header,
.feedback-panel__header {
  justify-content: space-between;
}

.review-header p,
.review-header h1,
.review-item-header h2,
.review-complete h2,
.review-complete p {
  margin: 0;
}

.review-header p,
.review-item-header span {
  margin-top: var(--space-2);
  color: var(--color-muted);
  font-size: 13px;
}

.review-header h1 {
  font-size: 26px;
}

.feedback-panel {
  padding: var(--space-5);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-background);
  outline: none;
}

.feedback-panel:focus-visible {
  box-shadow: 0 0 0 3px var(--color-brand-soft);
}

.feedback-panel__header {
  align-items: flex-start;
}

.feedback-panel__header h3,
.feedback-panel__header p,
.review-correction h4 {
  margin: 0;
}

.feedback-panel__header p {
  margin-top: var(--space-2);
  color: var(--color-muted);
  font-size: 13px;
}

.feedback-field {
  display: grid;
  gap: var(--space-2);
  font-weight: 700;
}

.feedback-field textarea {
  min-height: 120px;
  padding: var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  resize: vertical;
  font: inherit;
}

.feedback-field small {
  color: var(--color-muted);
  font-weight: 400;
}

.feedback-field .feedback-error {
  color: var(--color-danger);
}

.review-back,
.review-primary-link {
  color: var(--color-brand-strong);
  font-size: 13px;
  font-weight: 700;
}

.review-counts {
  flex-wrap: wrap;
}

.review-counts span,
.review-header > strong,
.review-item-header > strong {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  font-size: 12px;
}

.review-navigation {
  justify-content: space-between;
}

.review-card,
.review-complete {
  padding: var(--space-5);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.review-actions {
  flex-wrap: wrap;
}

.review-primary-link {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  padding-inline: var(--space-4);
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  text-decoration: none;
}

@media (max-width: 767px) {
  .review-header,
  .review-item-header {
    align-items: stretch;
    display: grid;
  }
}
</style>
