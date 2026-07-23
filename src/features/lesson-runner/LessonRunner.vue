<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ApiFailureError, ApiNetworkError, InvalidApiResponseError } from '@/api/errors'
import { isLearnerSessionAccessError } from '@/api/learnerSessionErrors'
import TaskRenderer from '@/components/task-renderers/TaskRenderer.vue'
import TaskShell from '@/components/task-renderers/TaskShell.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { playAnswerFeedbackSound } from '@/features/lesson-runner/answerFeedbackSound'
import type {
  CompletedLessonDto,
  LessonReplayDto,
  StartedLessonDto,
} from '@shared/api/courseSchemas'
import type {
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
  TaskAnswerResult,
} from '@shared/api/taskSchemas'
import type { LearnerApiPort } from '@/features/learner-course/learnerApiPort'

type RunnerApi = Pick<
  LearnerApiPort,
  'getLesson' | 'previewSentenceOutput' | 'submitAnswer'
> & {
  completeLesson(sessionId: string): Promise<CompletedLessonDto | LessonReplayDto>
}
type ShellFeedback = {
  tone: 'neutral' | 'info' | 'success' | 'error'
  title: string
  message: string
}
type RetryKind = 'continue' | 'preview' | 'reload' | 'submit' | 'sync'

const props = defineProps<{
  api: RunnerApi
  sessionId: string
  mode?: 'lesson' | 'replay'
}>()
const emit = defineEmits<{
  'access-required': []
  completed: [lesson?: CompletedLessonDto | LessonReplayDto]
  exit: []
}>()

const requireNewAccess = (error: unknown): boolean => {
  if (!isLearnerSessionAccessError(error)) return false
  lesson.value = undefined
  queuedLesson.value = undefined
  feedback.value = undefined
  retryKind.value = undefined
  retryLabel.value = undefined
  pendingSubmission.value = undefined
  pendingResult.value = undefined
  pendingPreview.value = undefined
  referenceSentence.value = undefined
  recoveryDraft.value = undefined
  emit('access-required')
  return true
}

const isLegacyContentError = (error: unknown): boolean =>
  error instanceof ApiFailureError && error.code === 'legacy_content_incompatible'

const failureCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

const isTaskAuthorityDrift = (error: unknown): boolean =>
  ['task_not_current', 'lesson_not_active', 'conflict', 's5_preview_required'].includes(
    failureCode(error) ?? '',
  )

const shouldReturnToCourse = (error: unknown): boolean =>
  failureCode(error) === 'course_unavailable'

const isNonRetryableTaskFailure = (error: unknown): boolean =>
  ['validation_error', 'task_type_mismatch'].includes(failureCode(error) ?? '')

const isRetryableUnknownResult = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  (error instanceof InvalidApiResponseError &&
    ((error.status >= 200 && error.status < 300) || error.status >= 500)) ||
  (error instanceof ApiFailureError && error.status >= 500)

const lesson = ref<StartedLessonDto>()
const loading = ref(true)
const loadError = ref<string>()
const loadErrorRetryable = ref(true)
const busy = ref(false)
const feedback = ref<ShellFeedback>()
const retryKind = ref<RetryKind>()
const retryLabel = ref<string>()
const queuedLesson = ref<StartedLessonDto>()
const pendingSubmission = ref<{
  taskId: string
  submission: SubmitTaskAnswerRequest
}>()
const pendingResult = ref<TaskAnswerResult>()
const pendingPreview = ref<{
  taskId: string
  request: SentenceOutputPreviewRequest
}>()
const referenceSentence = ref<string>()
const recoveryDraft = ref<string>()
const taskRecoveryGeneration = ref(0)
const completionBusy = ref(false)
const completionIssue = ref<{
  kind: 'incomplete' | 'terminal' | 'unknown'
  message: string
}>()
const runnerRoot = ref<HTMLElement>()
const taskRegion = ref<HTMLElement>()
const currentTask = computed(() => lesson.value?.tasks.find((task) => task.status === 'pending'))
const taskRendererKey = computed(
  () => `${currentTask.value?.id ?? 'none'}:${String(taskRecoveryGeneration.value)}`,
)
const currentPosition = computed(() => {
  if (!lesson.value || !currentTask.value) return 0
  return lesson.value.tasks.findIndex((task) => task.id === currentTask.value?.id) + 1
})
const visibleReferenceSentence = computed(() => {
  if (referenceSentence.value) return referenceSentence.value
  return currentTask.value?.taskType === 'sentence_output'
    ? currentTask.value.preview?.referenceSentence
    : undefined
})

const focusCurrentAction = async (): Promise<void> => {
  await nextTick()
  const taskControl = taskRegion.value?.querySelector<HTMLElement>(
    'input:not([disabled]), textarea:not([disabled]), button:not([disabled])',
  )
  if (taskControl) {
    taskControl.focus()
    return
  }

  const primaryAction = runnerRoot.value?.querySelector<HTMLElement>(
    '[data-action="reload-lesson"], [data-action="complete-lesson"]',
  )
  if (primaryAction) {
    primaryAction.focus()
    return
  }

  runnerRoot.value?.querySelector<HTMLElement>('[data-action="exit"]')?.focus()
}

const focusRetryAction = async (): Promise<void> => {
  await nextTick()
  runnerRoot.value?.querySelector<HTMLElement>('[data-action="retry"]')?.focus()
}

const routeClosedAuthority = (authoritativeLesson: StartedLessonDto): boolean => {
  if (authoritativeLesson.session.status === 'completed') {
    lesson.value = undefined
    emit('completed')
    return true
  }

  if (authoritativeLesson.session.status === 'abandoned') {
    lesson.value = undefined
    emit('exit')
    return true
  }

  return false
}

const loadLesson = async (): Promise<void> => {
  loading.value = true
  loadError.value = undefined
  loadErrorRetryable.value = true
  completionIssue.value = undefined
  try {
    const authoritativeLesson = await props.api.getLesson(props.sessionId)

    if (!routeClosedAuthority(authoritativeLesson)) {
      lesson.value = authoritativeLesson
    }
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (isLegacyContentError(error)) {
      loadError.value = '本课内容暂时无法使用，请返回课程并联系课程管理员处理'
      loadErrorRetryable.value = false
    } else {
      loadError.value = '暂时无法读取本课，请检查网络后重试'
    }
  } finally {
    loading.value = false
    await focusCurrentAction()
  }
}

const completeLesson = async (): Promise<void> => {
  if (!lesson.value || currentTask.value || completionBusy.value) return

  completionBusy.value = true
  completionIssue.value = undefined
  try {
    const completed = await props.api.completeLesson(props.sessionId)
    emit('completed', completed)
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (failureCode(error) === 'lesson_not_active') {
      await syncLesson()
      return
    }
    if (isLegacyContentError(error)) {
      completionIssue.value = {
        kind: 'terminal',
        message: '本课内容暂时无法使用，请返回课程并联系课程管理员处理。',
      }
      return
    }
    if (
      error instanceof ApiFailureError &&
      error.apiError.code === 'lesson_incomplete'
    ) {
      const details = error.apiError.details
      completionIssue.value = {
        kind: 'incomplete',
        message: `服务端确认仍有 ${String(details.pendingRequiredTaskIds.length)} 道必答任务未完成（主任务 ${String(details.completedPrimary)} / ${String(details.totalPrimary)}）。请重新读取本课。`,
      }
    } else if (isRetryableUnknownResult(error)) {
      completionIssue.value = {
        kind: 'unknown',
        message: '完成请求尚未确认，本页不会前进。请检查网络后重新确认。',
      }
    } else {
      completionIssue.value = {
        kind: 'terminal',
        message: '服务端已返回确定性错误，页面不会循环重试完成请求。请返回课程后重新进入。',
      }
    }
  } finally {
    completionBusy.value = false
    if (completionIssue.value) await focusCurrentAction()
  }
}

const handleCompletionAction = async (): Promise<void> => {
  if (completionIssue.value?.kind === 'terminal') return

  if (completionIssue.value?.kind === 'incomplete') {
    await loadLesson()
    return
  }
  await completeLesson()
}

const showAnswerFeedback = async (result: TaskAnswerResult): Promise<void> => {
  feedback.value = {
    tone: result.correct ? 'success' : 'error',
    title: result.correct ? '答对了' : '再看一眼',
    message: feedbackMessage(result),
  }
  retryKind.value = 'continue'
  retryLabel.value = '继续'
  await focusRetryAction()
}

const reloadAfterAnswer = async (result: TaskAnswerResult): Promise<void> => {
  try {
    const authoritativeLesson = await props.api.getLesson(props.sessionId)

    if (routeClosedAuthority(authoritativeLesson)) return

    queuedLesson.value = authoritativeLesson
    await showAnswerFeedback(result)
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (isLegacyContentError(error)) {
      feedback.value = {
        tone: 'error',
        title: '本课内容暂时无法使用',
        message: '请返回课程并联系课程管理员处理。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    if (!isRetryableUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '无法同步服务端状态',
        message: '服务端已返回确定性错误，页面不会循环重试。请返回课程后重新进入。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    feedback.value = {
      tone: 'error',
      title: '答案已保存，但同步失败',
      message: '当前答案仍保留在页面上，请重新同步本课后再继续。',
    }
    retryKind.value = 'reload'
    retryLabel.value = '重新同步'
    await focusRetryAction()
  }
}

const requireLessonSync = async (): Promise<void> => {
  feedback.value = {
    tone: 'error',
    title: '题目状态已更新',
    message: '当前输入仍保留在页面上，请重新同步本课后继续。',
  }
  retryKind.value = 'sync'
  retryLabel.value = '重新同步本课'
  await focusRetryAction()
}

const syncLesson = async (): Promise<void> => {
  busy.value = true
  feedback.value = undefined
  try {
    const previousTask = currentTask.value
    const authoritativeLesson = await props.api.getLesson(props.sessionId)
    const authoritativeTask = authoritativeLesson.tasks.find((task) => task.status === 'pending')

    if (
      previousTask?.taskType === 'sentence_output' &&
      authoritativeTask?.taskType === 'sentence_output' &&
      authoritativeTask.id === previousTask.id
    ) {
      recoveryDraft.value = authoritativeTask.preview?.draft ?? pendingSentenceDraft(previousTask.id)
      taskRecoveryGeneration.value += 1
    } else {
      recoveryDraft.value = undefined
    }

    retryKind.value = undefined
    retryLabel.value = undefined
    pendingSubmission.value = undefined
    pendingPreview.value = undefined
    referenceSentence.value = undefined

    if (routeClosedAuthority(authoritativeLesson)) return

    lesson.value = authoritativeLesson
    await focusCurrentAction()
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (isLegacyContentError(error)) {
      feedback.value = {
        tone: 'error',
        title: '本课内容暂时无法使用',
        message: '请返回课程并联系课程管理员处理。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    if (!isRetryableUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '无法同步服务端状态',
        message: '服务端已返回确定性错误，页面不会循环重试。请返回课程后重新进入。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    feedback.value = {
      tone: 'error',
      title: '暂时无法同步本课',
      message: '当前输入仍保留，请检查网络后重新同步。',
    }
    retryKind.value = 'sync'
    retryLabel.value = '重新同步本课'
    await focusRetryAction()
  } finally {
    busy.value = false
  }
}

const pendingSentenceDraft = (taskId: string): string | undefined => {
  if (pendingPreview.value?.taskId === taskId) {
    return pendingPreview.value.request.draft
  }

  const pending = pendingSubmission.value

  return pending?.taskId === taskId && pending.submission.taskType === 'sentence_output'
    ? pending.submission.draft
    : undefined
}

const submitAnswer = async (submission: SubmitTaskAnswerRequest): Promise<void> => {
  if (!currentTask.value || busy.value) return

  pendingSubmission.value = { taskId: currentTask.value.id, submission }
  pendingResult.value = undefined
  busy.value = true
  feedback.value = undefined
  retryLabel.value = undefined
  try {
    const result = await props.api.submitAnswer(
      props.sessionId,
      currentTask.value.id,
      submission,
    )
    pendingResult.value = result
    playAnswerFeedbackSound(result.correct)
    await reloadAfterAnswer(result)
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (isTaskAuthorityDrift(error)) {
      await requireLessonSync()
      return
    }
    if (isNonRetryableTaskFailure(error)) {
      feedback.value = {
        tone: 'error',
        title: '当前答案无法提交',
        message: '服务端已明确拒绝当前题目或答案格式，请返回课程后重新进入。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    if (!isRetryableUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '当前请求无法安全重试',
        message: '服务端已返回确定性错误，页面不会重复提交当前答案。请返回课程后重新进入。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    feedback.value = {
      tone: 'error',
      title: '答案尚未提交',
      message: '答案和当前题目都已保留，请检查网络后重新提交。',
    }
    retryKind.value = 'submit'
    retryLabel.value = '重新提交'
    await focusRetryAction()
  } finally {
    busy.value = false
  }
}

const previewSentenceOutput = async (
  request: SentenceOutputPreviewRequest,
): Promise<void> => {
  if (!currentTask.value || busy.value) return

  pendingPreview.value = { taskId: currentTask.value.id, request }
  busy.value = true
  feedback.value = undefined
  retryLabel.value = undefined
  try {
    const preview = await props.api.previewSentenceOutput(
      props.sessionId,
      currentTask.value.id,
      request,
    )
    referenceSentence.value = preview.referenceSentence
    retryKind.value = undefined
  } catch (error) {
    if (requireNewAccess(error)) return
    if (shouldReturnToCourse(error)) {
      emit('exit')
      return
    }
    if (isTaskAuthorityDrift(error)) {
      await requireLessonSync()
      return
    }
    if (!isRetryableUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '当前参考句无法读取',
        message: '服务端已返回确定性错误，页面不会重复请求参考句。请返回课程后重新进入。',
      }
      retryKind.value = undefined
      retryLabel.value = undefined
      return
    }
    feedback.value = {
      tone: 'error',
      title: '参考句尚未读取',
      message: '你写的句子仍保留在页面上，请检查网络后重新预览。',
    }
    retryKind.value = 'preview'
    retryLabel.value = '重新预览'
    await focusRetryAction()
  } finally {
    busy.value = false
  }
}

const handleShellAction = async (): Promise<void> => {
  const action = retryKind.value
  retryLabel.value = undefined

  if (action === 'continue' && queuedLesson.value) {
    lesson.value = queuedLesson.value
    queuedLesson.value = undefined
    feedback.value = undefined
    retryKind.value = undefined
    pendingSubmission.value = undefined
    pendingResult.value = undefined
    pendingPreview.value = undefined
    referenceSentence.value = undefined
    recoveryDraft.value = undefined
    await focusCurrentAction()
    return
  }

  if (action === 'reload' && pendingResult.value) {
    busy.value = true
    feedback.value = undefined
    try {
      await reloadAfterAnswer(pendingResult.value)
    } finally {
      busy.value = false
    }
    return
  }

  if (action === 'sync') {
    await syncLesson()
    return
  }

  if (action === 'submit' && pendingSubmission.value) {
    await submitAnswer(pendingSubmission.value.submission)
    return
  }

  if (action === 'preview' && pendingPreview.value) {
    await previewSentenceOutput(pendingPreview.value.request)
  }
}

const feedbackMessage = (result: TaskAnswerResult): string => {
  switch (result.feedback.taskType) {
    case 'recognize_meaning':
      return result.correct ? '服务端已记录这次判断。' : '服务端已把这个词安排为继续学习。'
    case 'recall_word':
    case 'multiple_choice':
    case 'fill_blank':
      return `参考答案：${result.feedback.correctAnswer}`
    case 'sentence_build':
    case 'sentence_output':
      return `参考句：${result.feedback.referenceSentence}`
  }
}

watch(() => props.sessionId, loadLesson, { immediate: true })
</script>

<template>
  <div
    ref="runnerRoot"
    class="lesson-runner"
  >
    <UiStatusMessage
      v-if="loading"
      tone="info"
      title="正在恢复本课"
    >
      正在读取服务端保存的任务位置。
    </UiStatusMessage>
    <section
      v-else-if="loadError"
      class="runner-load-error"
    >
      <UiStatusMessage
        tone="error"
        title="无法读取本课"
      >
        {{ loadError }}
      </UiStatusMessage>
      <div class="runner-load-error__actions">
        <UiButton
          v-if="loadErrorRetryable"
          context="learner"
          data-action="reload-lesson"
          @click="loadLesson"
        >
          重新读取本课
        </UiButton>
        <UiButton
          context="learner"
          variant="secondary"
          @click="emit('exit')"
        >
          返回课程
        </UiButton>
      </div>
    </section>
    <TaskShell
      v-else-if="lesson && currentTask"
      :lesson-no="lesson.session.lessonNo"
      :position="currentPosition"
      :total="lesson.session.taskCount"
      v-bind="{
        ...(feedback === undefined ? {} : { feedback }),
        ...(retryLabel === undefined ? {} : { retryLabel }),
      }"
      @exit="emit('exit')"
      @retry="handleShellAction"
    >
      <div ref="taskRegion">
        <TaskRenderer
          :key="taskRendererKey"
          :task="currentTask"
          :disabled="busy || feedback !== undefined"
          v-bind="{
            ...(visibleReferenceSentence === undefined
              ? {}
              : { referenceSentence: visibleReferenceSentence }),
            ...(recoveryDraft === undefined ? {} : { recoveryDraft }),
          }"
          @preview="previewSentenceOutput"
          @submit="submitAnswer"
        />
      </div>
    </TaskShell>
    <TaskShell
      v-else-if="lesson"
      :lesson-no="lesson.session.lessonNo"
      :position="lesson.session.completedTaskCount"
      :total="lesson.session.taskCount"
      @exit="emit('exit')"
    >
      <div class="completion-panel">
        <UiStatusMessage
          :tone="completionIssue ? 'error' : 'success'"
          :title="completionIssue ? '暂时不能完成本课' : '本课任务已答完'"
        >
          {{ completionIssue?.message ?? '请让服务端确认本课是否满足完成条件。' }}
        </UiStatusMessage>
        <UiButton
          v-if="completionIssue?.kind !== 'terminal'"
          context="learner"
          data-action="complete-lesson"
          :loading="completionBusy"
          loading-label="正在确认"
          @click="handleCompletionAction"
        >
          {{ completionIssue?.kind === 'incomplete'
            ? '重新读取本课'
            : completionIssue
              ? '重新确认完成'
              : '完成本课' }}
        </UiButton>
      </div>
    </TaskShell>
  </div>
</template>

<style scoped>
.completion-panel {
  display: grid;
  gap: var(--space-4);
}

.runner-load-error {
  display: grid;
  gap: var(--space-4);
}

.runner-load-error__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.completion-panel :deep(.ui-button),
.runner-load-error__actions :deep(.ui-button) {
  width: 100%;
}

@media (max-width: 479px) {
  .runner-load-error__actions {
    grid-template-columns: 1fr;
  }
}
</style>
