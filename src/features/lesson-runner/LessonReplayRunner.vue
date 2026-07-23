<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ApiFailureError, ApiNetworkError, InvalidApiResponseError } from '@/api/errors'
import { isLearnerSessionAccessError } from '@/api/learnerSessionErrors'
import TaskRenderer from '@/components/task-renderers/TaskRenderer.vue'
import TaskShell from '@/components/task-renderers/TaskShell.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { playAnswerFeedbackSound } from '@/features/lesson-runner/answerFeedbackSound'
import type { LearnerApiPort } from '@/features/learner-course/learnerApiPort'
import type { LessonReplayDto } from '@shared/api/courseSchemas'
import type {
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
  TaskAnswerResult,
} from '@shared/api/taskSchemas'

type ReplayRunnerApi = Pick<
  LearnerApiPort,
  | 'completeLessonReplay'
  | 'getLessonReplay'
  | 'previewReplaySentenceOutput'
  | 'submitReplayAnswer'
>
type ShellFeedback = {
  tone: 'neutral' | 'info' | 'success' | 'error'
  title: string
  message: string
}
type RetryKind = 'complete' | 'continue' | 'preview' | 'submit' | 'sync'

const props = defineProps<{
  api: ReplayRunnerApi
  replaySessionId: string
}>()
const emit = defineEmits<{
  'access-required': []
  completed: []
  exit: []
}>()

const replay = ref<LessonReplayDto>()
const queuedReplay = ref<LessonReplayDto>()
const completedReplay = ref<LessonReplayDto>()
const loading = ref(true)
const loadError = ref<string>()
const busy = ref(false)
const feedback = ref<ShellFeedback>()
const retryKind = ref<RetryKind>()
const retryLabel = ref<string>()
const pendingSubmission = ref<SubmitTaskAnswerRequest>()
const pendingPreview = ref<SentenceOutputPreviewRequest>()
const pendingResult = ref<TaskAnswerResult>()
const referenceSentence = ref<string>()
const completionIssue = ref<string>()
const runnerRoot = ref<HTMLElement>()

const currentTask = computed(() =>
  replay.value?.tasks.find((task) => task.status === 'pending'),
)
const currentPosition = computed(() => {
  if (!replay.value || !currentTask.value) return 0
  return replay.value.tasks.findIndex((task) => task.id === currentTask.value?.id) + 1
})
const recoveryDraft = computed(() => {
  if (pendingPreview.value?.taskType === 'sentence_output') return pendingPreview.value.draft
  return pendingSubmission.value?.taskType === 'sentence_output'
    ? pendingSubmission.value.draft
    : undefined
})

const focusCurrentAction = async (): Promise<void> => {
  await nextTick()
  runnerRoot.value
    ?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    )
    ?.focus()
}

const requireNewAccess = (error: unknown): boolean => {
  if (!isLearnerSessionAccessError(error)) return false
  replay.value = undefined
  emit('access-required')
  return true
}

const failureCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined

const isUnknownResult = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  (error instanceof InvalidApiResponseError &&
    ((error.status >= 200 && error.status < 300) || error.status >= 500)) ||
  (error instanceof ApiFailureError && error.status >= 500)

const resetTaskInteraction = (): void => {
  feedback.value = undefined
  retryKind.value = undefined
  retryLabel.value = undefined
  queuedReplay.value = undefined
  pendingSubmission.value = undefined
  pendingPreview.value = undefined
  pendingResult.value = undefined
  referenceSentence.value = undefined
}

const applyAuthoritativeReplay = (authoritative: LessonReplayDto): void => {
  if (authoritative.session.status === 'completed') {
    completedReplay.value = authoritative
    replay.value = undefined
    return
  }
  completedReplay.value = undefined
  replay.value = authoritative
}

const loadReplay = async (): Promise<void> => {
  loading.value = true
  loadError.value = undefined
  completionIssue.value = undefined
  try {
    applyAuthoritativeReplay(await props.api.getLessonReplay(props.replaySessionId))
    resetTaskInteraction()
  } catch (error) {
    if (requireNewAccess(error)) return
    if (failureCode(error) === 'course_unavailable') {
      emit('exit')
      return
    }
    loadError.value = '暂时无法读取课时，请检查网络后重试'
  } finally {
    loading.value = false
    await focusCurrentAction()
  }
}

const feedbackMessage = (result: TaskAnswerResult): string => {
  switch (result.feedback.taskType) {
    case 'recognize_meaning':
      return result.correct ? '服务端已记录这次判断。' : '这次判断已记录，可以继续练习。'
    case 'recall_word':
    case 'multiple_choice':
    case 'fill_blank':
      return `参考答案：${result.feedback.correctAnswer}`
    case 'sentence_build':
      return `参考句：${result.feedback.referenceSentence}`
    case 'sentence_output':
      return `本次自评：${String(result.feedback.selfScore)} 分。`
  }
}

const refreshAfterAnswer = async (result: TaskAnswerResult): Promise<void> => {
  try {
    queuedReplay.value = await props.api.getLessonReplay(props.replaySessionId)
    pendingResult.value = result
    feedback.value = {
      tone: result.correct ? 'success' : 'error',
      title: result.correct ? '回答已记录' : '继续练习',
      message: feedbackMessage(result),
    }
    retryKind.value = 'continue'
    retryLabel.value = '继续'
  } catch (error) {
    if (requireNewAccess(error)) return
    if (!isUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '无法同步课时',
        message: '答案已返回，但下一题状态无法确认。请返回课程后重新进入。',
      }
      return
    }
    pendingResult.value = result
    feedback.value = {
      tone: 'error',
      title: '答案已记录，下一题尚未同步',
      message: '请安全地重新同步本课状态，不要再次提交答案。',
    }
    retryKind.value = 'sync'
    retryLabel.value = '重新同步'
  }
}

const submitAnswer = async (submission: SubmitTaskAnswerRequest): Promise<void> => {
  if (!currentTask.value || busy.value) return
  pendingSubmission.value = submission
  busy.value = true
  feedback.value = undefined
  retryLabel.value = undefined
  try {
    const result = await props.api.submitReplayAnswer(
      props.replaySessionId,
      currentTask.value.id,
      submission,
    )
    playAnswerFeedbackSound(result.correct)
    await refreshAfterAnswer(result)
  } catch (error) {
    if (requireNewAccess(error)) return
    if (!isUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '当前答案无法提交',
        message: '服务端已拒绝当前答案，请返回课程后重新进入。',
      }
      return
    }
    feedback.value = {
      tone: 'error',
      title: '答案结果尚未确认',
      message: '当前输入仍保留，请安全重试同一次提交。',
    }
    retryKind.value = 'submit'
    retryLabel.value = '重新提交'
  } finally {
    busy.value = false
  }
}

const previewSentenceOutput = async (
  preview: SentenceOutputPreviewRequest,
): Promise<void> => {
  if (!currentTask.value || busy.value) return
  pendingPreview.value = preview
  busy.value = true
  feedback.value = undefined
  retryLabel.value = undefined
  try {
    const result = await props.api.previewReplaySentenceOutput(
      props.replaySessionId,
      currentTask.value.id,
      preview,
    )
    referenceSentence.value = result.referenceSentence
    retryKind.value = undefined
    pendingPreview.value = undefined
  } catch (error) {
    if (requireNewAccess(error)) return
    if (!isUnknownResult(error)) {
      feedback.value = {
        tone: 'error',
        title: '参考句无法读取',
        message: '服务端已拒绝当前草稿，请返回课程后重新进入。',
      }
      return
    }
    feedback.value = {
      tone: 'error',
      title: '参考句结果尚未确认',
      message: '当前草稿仍保留，请安全重试同一次预览。',
    }
    retryKind.value = 'preview'
    retryLabel.value = '重新预览'
  } finally {
    busy.value = false
  }
}

const completeReplay = async (): Promise<void> => {
  if (!replay.value || currentTask.value || busy.value) return
  busy.value = true
  completionIssue.value = undefined
  try {
    applyAuthoritativeReplay(await props.api.completeLessonReplay(props.replaySessionId))
  } catch (error) {
    if (requireNewAccess(error)) return
    if (failureCode(error) === 'course_unavailable') {
      emit('exit')
      return
    }
    completionIssue.value = isUnknownResult(error)
      ? '完成结果尚未确认，请安全重试同一次完成操作。'
      : '服务端确认仍有任务未完成，请重新读取课时。'
    retryKind.value = isUnknownResult(error) ? 'complete' : undefined
  } finally {
    busy.value = false
  }
}

const handleRetry = async (): Promise<void> => {
  const action = retryKind.value
  retryLabel.value = undefined
  if (action === 'continue' && queuedReplay.value) {
    applyAuthoritativeReplay(queuedReplay.value)
    resetTaskInteraction()
    await focusCurrentAction()
    return
  }
  if (action === 'submit' && pendingSubmission.value) {
    await submitAnswer(pendingSubmission.value)
    return
  }
  if (action === 'preview' && pendingPreview.value) {
    await previewSentenceOutput(pendingPreview.value)
    return
  }
  if (action === 'sync' && pendingResult.value) {
    await refreshAfterAnswer(pendingResult.value)
    return
  }
  if (action === 'complete') await completeReplay()
}

onMounted(loadReplay)
</script>

<template>
  <div
    ref="runnerRoot"
    class="lesson-replay-runner"
  >
    <UiStatusMessage
      v-if="loading"
      tone="info"
      title="正在读取课时"
    >
      请稍候。
    </UiStatusMessage>
    <section
      v-else-if="loadError"
      class="lesson-replay-runner__state"
    >
      <UiStatusMessage
        tone="error"
        title="无法读取课时"
      >
        {{ loadError }}
      </UiStatusMessage>
      <div class="lesson-replay-runner__actions">
        <UiButton
          context="learner"
          variant="secondary"
          data-action="exit"
          @click="emit('exit')"
        >
          返回课程
        </UiButton>
        <UiButton
          context="learner"
          data-action="reload-replay"
          @click="loadReplay"
        >
          重新读取
        </UiButton>
      </div>
    </section>
    <section
      v-else-if="completedReplay"
      class="lesson-replay-runner__summary"
      aria-labelledby="replay-summary-title"
    >
      <p class="lesson-replay-runner__label">
        本课完成
      </p>
      <h1 id="replay-summary-title">
        第 {{ completedReplay.session.lessonNo }} 课
      </h1>
      <p>第 {{ completedReplay.session.learningRunNo }} 轮课时</p>
      <strong>
        本次答对 {{ completedReplay.session.correctCount }} / {{ completedReplay.session.taskCount }} 道
      </strong>
      <p>本次结果不会改变当前课程进度。</p>
      <UiButton
        context="learner"
        data-action="return-to-course"
        @click="emit('completed')"
      >
        返回课程
      </UiButton>
    </section>
    <template v-else-if="replay">
      <header class="lesson-replay-runner__heading">
        <p class="lesson-replay-runner__label">
          课程学习
        </p>
        <h1>第 {{ replay.session.lessonNo }} 课</h1>
        <p>第 {{ replay.session.learningRunNo }} 轮课时 · 本次结果不会改变当前课程进度</p>
      </header>
      <TaskShell
        v-if="currentTask"
        :lesson-no="replay.session.lessonNo"
        :position="currentPosition"
        :total="replay.session.taskCount"
        v-bind="{
          ...(feedback === undefined ? {} : { feedback }),
          ...(retryLabel === undefined ? {} : { retryLabel }),
        }"
        @exit="emit('exit')"
        @retry="handleRetry"
      >
        <TaskRenderer
          :key="currentTask.id"
          :task="currentTask"
          :disabled="busy || feedback !== undefined"
          v-bind="{
            ...(referenceSentence === undefined ? {} : { referenceSentence }),
            ...(recoveryDraft === undefined ? {} : { recoveryDraft }),
          }"
          @preview="previewSentenceOutput"
          @submit="submitAnswer"
        />
      </TaskShell>
      <TaskShell
        v-else
        :lesson-no="replay.session.lessonNo"
        :position="replay.session.completedTaskCount"
        :total="replay.session.taskCount"
        @exit="emit('exit')"
      >
        <div class="lesson-replay-runner__completion">
          <UiStatusMessage
            :tone="completionIssue ? 'error' : 'success'"
            :title="completionIssue ? '暂时不能完成本课' : '本课任务已答完'"
          >
            {{ completionIssue ?? '请让服务端确认本课结果。' }}
          </UiStatusMessage>
          <UiButton
            context="learner"
            data-action="complete-replay"
            :loading="busy"
            @click="completeReplay"
          >
            {{ retryKind === 'complete'
              ? '安全重试完成'
              : `完成第 ${replay.session.lessonNo} 课` }}
          </UiButton>
          <UiButton
            v-if="completionIssue && retryKind !== 'complete'"
            context="learner"
            variant="secondary"
            data-action="reload-replay"
            @click="loadReplay"
          >
            重新读取课时
          </UiButton>
        </div>
      </TaskShell>
    </template>
  </div>
</template>

<style scoped>
.lesson-replay-runner,
.lesson-replay-runner__state,
.lesson-replay-runner__summary,
.lesson-replay-runner__heading,
.lesson-replay-runner__completion {
  display: grid;
  gap: var(--space-4);
}

.lesson-replay-runner__label {
  margin: 0;
  color: var(--color-brand-strong);
  font-size: 14px;
  font-weight: 800;
}

.lesson-replay-runner__heading h1,
.lesson-replay-runner__summary h1,
.lesson-replay-runner__heading p,
.lesson-replay-runner__summary p {
  margin: 0;
}

.lesson-replay-runner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
</style>
