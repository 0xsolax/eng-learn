<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { ApiFailureError, InvalidApiResponseError } from '@/api/errors'
import { isLearnerSessionAccessError } from '@/api/learnerSessionErrors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import type { LessonReportDto } from '@shared/api/courseSchemas'
import type { LearnerApiPort } from '@/features/learner-course/learnerApiPort'

type ReportApi = Pick<LearnerApiPort, 'getLessonReport'>

const props = defineProps<{
  api: ReportApi
  sessionId: string
}>()
const emit = defineEmits<{
  'access-required': []
  'return-course': []
  'return-lesson': []
}>()

const summary = ref<LessonReportDto>()
const loading = ref(false)
const errorActions = ref<HTMLElement>()
const reportHeading = ref<HTMLHeadingElement>()
const loadError = ref<{
  kind: 'transient' | 'return-lesson' | 'return-course'
  title: string
  message: string
}>()

const loadReport = async (isRetry = false): Promise<void> => {
  if (loading.value) return

  loading.value = true
  if (!isRetry) loadError.value = undefined
  let focusTarget: 'error-action' | 'report-heading' | undefined
  try {
    summary.value = await props.api.getLessonReport(props.sessionId)
    loadError.value = undefined
    if (isRetry) focusTarget = 'report-heading'
  } catch (error) {
    if (
      isLearnerSessionAccessError(error) ||
      (error instanceof ApiFailureError && error.status === 401)
    ) {
      emit('access-required')
      return
    }
    if (error instanceof ApiFailureError && error.apiError.code === 'report_unavailable') {
      loadError.value = {
        kind: 'return-lesson',
        title: '本课尚未完成',
        message: '服务端确认本课尚未完成，请返回本课继续完成必答任务。',
      }
    } else if (
      error instanceof ApiFailureError &&
      error.apiError.code === 'lesson_not_active'
    ) {
      loadError.value = {
        kind: 'return-course',
        title: '本课状态已变化',
        message: '服务端确认本课当前不可继续，请返回课程查看最新状态。',
      }
    } else if (
      (error instanceof ApiFailureError && error.status < 500) ||
      (error instanceof InvalidApiResponseError &&
        error.status >= 400 &&
        error.status < 500)
    ) {
      loadError.value = {
        kind: 'return-course',
        title: '课后结果无法打开',
        message: '服务端暂时无法提供这份课后结果，请返回课程查看最新状态。',
      }
    } else {
      loadError.value = {
        kind: 'transient',
        title: '课后结果暂不可用',
        message: '暂时无法读取课后结果，请重新读取，或返回课程。',
      }
    }
    focusTarget = 'error-action'
  } finally {
    loading.value = false
  }

  if (focusTarget) {
    await nextTick()
    if (focusTarget === 'report-heading') {
      reportHeading.value?.focus()
    } else {
      errorActions.value?.querySelector('button')?.focus()
    }
  }
}

const retryReport = (): void => {
  void loadReport(true)
}

onMounted(loadReport)
</script>

<template>
  <UiStatusMessage
    v-if="loading && !loadError"
    tone="info"
    title="正在读取课后结果"
  >
    请稍候。
  </UiStatusMessage>
  <section
    v-else-if="summary"
    class="lesson-report page-enter"
  >
    <p class="lesson-report__eyebrow">
      本课完成
    </p>
    <h1
      ref="reportHeading"
      tabindex="-1"
    >
      第 {{ summary.lessonNo }} 课完成
    </h1>
    <UiStatusMessage
      tone="success"
      title="做得好，今天这一课完成了"
    >
      已完成 {{ summary.completedTaskCount }} / {{ summary.totalTaskCount }} 道任务。
    </UiStatusMessage>
    <p class="lesson-report__rate">
      核心任务正确率：{{ Math.round(summary.correctRate * 100) }}%
    </p>
    <section aria-labelledby="needs-practice-title">
      <h2 id="needs-practice-title">
        还要再练
      </h2>
      <p v-if="summary.needsPracticeWords.length === 0">
        本课暂无需要再练的词。
      </p>
      <ul v-else>
        <li
          v-for="item in summary.needsPracticeWords"
          :key="item.id"
          lang="en"
        >
          {{ item.word }}
        </li>
      </ul>
    </section>
    <section aria-labelledby="progress-title">
      <h2 id="progress-title">
        更稳了
      </h2>
      <p v-if="summary.progressWords.length === 0">
        继续完成下一课，进步词会显示在这里。
      </p>
      <ul v-else>
        <li
          v-for="item in summary.progressWords"
          :key="item.id"
          lang="en"
        >
          {{ item.word }}
        </li>
      </ul>
    </section>
    <p class="lesson-report__next">
      下一步：第 {{ summary.nextLessonNo }} 课
    </p>
    <UiButton
      context="learner"
      data-action="return-course"
      @click="$emit('return-course')"
    >
      返回课程
    </UiButton>
  </section>
  <section
    v-else-if="loadError"
    ref="errorActions"
    class="lesson-report lesson-report--error"
    :aria-busy="loading ? 'true' : undefined"
  >
    <UiStatusMessage
      tone="error"
      :title="loadError.title"
    >
      {{ loadError.message }}
    </UiStatusMessage>
    <UiButton
      v-if="loadError.kind === 'transient'"
      context="learner"
      data-action="retry-report"
      :loading="loading"
      loading-label="正在重新读取"
      @click="retryReport"
    >
      重新读取课后结果
    </UiButton>
    <UiButton
      context="learner"
      :data-action="loadError.kind === 'return-lesson' ? 'return-lesson' : 'return-course'"
      :variant="loadError.kind === 'transient' ? 'secondary' : 'primary'"
      @click="loadError.kind === 'return-lesson'
        ? $emit('return-lesson')
        : $emit('return-course')"
    >
      {{ loadError.kind === 'return-lesson' ? '返回本课' : '返回课程' }}
    </UiButton>
  </section>
</template>

<style scoped>
.lesson-report {
  display: grid;
  gap: var(--space-4);
}

.lesson-report__eyebrow,
.lesson-report h1,
.lesson-report__next,
.lesson-report__rate,
.lesson-report section h2,
.lesson-report section p,
.lesson-report section ul {
  margin: 0;
}

.lesson-report__eyebrow {
  color: var(--color-brand-strong);
  font-size: 14px;
  font-weight: 750;
}

.lesson-report h1 {
  font-size: clamp(30px, 8vw, 46px);
}

.lesson-report__next {
  font-size: 20px;
  font-weight: 750;
}

.lesson-report__rate {
  font-size: 20px;
  font-weight: 750;
}

.lesson-report section {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.lesson-report section h2 {
  font-size: 18px;
}

.lesson-report section ul {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 0;
  list-style: none;
}

.lesson-report section li {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--color-brand-soft);
  font-weight: 700;
}

.lesson-report :deep(.ui-button) {
  width: 100%;
  margin-top: var(--space-4);
}
</style>
