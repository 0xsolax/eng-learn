<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import type { CourseHomeDto } from '@shared/api/courseSchemas'
import type { LearnerApiPort } from './learnerApiPort'

type CourseApi = Pick<LearnerApiPort, 'getCourseHome' | 'startLesson'>

const props = defineProps<{ api: CourseApi }>()
const emit = defineEmits<{
  started: [sessionId: string]
  'access-required': []
}>()

const home = ref<CourseHomeDto>()
const loading = ref(true)
const loadError = ref<string>()
const loadErrorTitle = ref<string>()
const accessRequired = ref(false)
const starting = ref(false)
const startError = ref<string>()

const isAccessRequiredError = (error: unknown): boolean =>
  error instanceof ApiFailureError &&
  (error.code === 'learner_session_expired' ||
    error.code === 'learner_session_revoked' ||
    error.code === 'learner_session_required')

const isLegacyContentError = (error: unknown): boolean =>
  error instanceof ApiFailureError && error.code === 'legacy_content_incompatible'

const startLesson = async (): Promise<void> => {
  if (!home.value || starting.value) return

  starting.value = true
  startError.value = undefined
  try {
    const lesson = await props.api.startLesson(home.value.course.id)
    emit('started', lesson.session.id)
  } catch (error) {
    if (isAccessRequiredError(error)) {
      emit('access-required')
    } else if (isLegacyContentError(error)) {
      startError.value = '本课内容暂时无法使用，请联系课程管理员处理后再试'
    } else {
      startError.value = '暂时无法开始课时，请检查网络后重试'
    }
  } finally {
    starting.value = false
  }
}

const loadCourse = async (): Promise<void> => {
  loading.value = true
  loadError.value = undefined
  loadErrorTitle.value = undefined
  accessRequired.value = false
  try {
    home.value = await props.api.getCourseHome()
  } catch (error) {
    accessRequired.value = isAccessRequiredError(error)
    const legacyContentError = isLegacyContentError(error)
    loadErrorTitle.value = accessRequired.value
      ? '学习会话已失效'
      : legacyContentError
        ? '课程内容暂时不可用'
        : '无法读取课程'
    loadError.value = accessRequired.value
      ? '学习会话已失效，请重新输入学习码'
      : legacyContentError
        ? '本课内容暂时无法使用，请联系课程管理员处理后再试'
        : '暂时无法读取课程，请检查网络后重试'
  } finally {
    loading.value = false
  }
}

onMounted(loadCourse)
</script>

<template>
  <UiStatusMessage
    v-if="loading"
    tone="info"
    title="正在读取课程"
  >
    请稍候。
  </UiStatusMessage>
  <section
    v-else-if="loadError"
    class="course-home course-home--error"
  >
    <UiStatusMessage
      tone="error"
      :title="loadErrorTitle ?? '无法读取课程'"
    >
      {{ loadError }}
    </UiStatusMessage>
    <UiButton
      v-if="accessRequired"
      context="learner"
      data-action="return-to-code"
      @click="$emit('access-required')"
    >
      重新输入学习码
    </UiButton>
    <UiButton
      v-else
      context="learner"
      data-action="reload-course"
      @click="loadCourse"
    >
      重新读取课程
    </UiButton>
  </section>
  <section
    v-else-if="home"
    class="course-home"
  >
    <p class="course-home__eyebrow">
      当前课时
    </p>
    <h1>第 {{ home.course.currentLessonNo }} 课</h1>
    <p>按自己的节奏完成这一课。</p>
    <ul
      class="course-home__path"
      aria-label="课时路径"
    >
      <li
        v-for="node in home.lessonPath"
        :key="node.lessonNo"
        data-lesson-path
        :data-status="node.status"
      >
        <span>第 {{ node.lessonNo }} 课</span>
        <small>{{ node.status === 'completed'
          ? '已完成'
          : node.status === 'current'
            ? '当前'
            : '未开放' }}</small>
      </li>
    </ul>
    <p class="course-home__summary">
      {{ home.newWordCount }} 个新词 · {{ home.reviewWordCount }} 个复习词
    </p>
    <UiStatusMessage
      v-if="startError"
      tone="error"
      title="未能进入课时"
    >
      {{ startError }}
    </UiStatusMessage>
    <UiButton
      context="learner"
      data-action="start-lesson"
      :loading="starting"
      loading-label="正在进入"
      @click="startLesson"
    >
      {{ home.action === 'continue' ? '继续' : '开始' }}第 {{ home.course.currentLessonNo }} 课
    </UiButton>
  </section>
</template>

<style scoped>
.course-home {
  display: grid;
  gap: var(--space-4);
}

.course-home__eyebrow,
.course-home h1,
.course-home p {
  margin: 0;
}

.course-home__path {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  padding: 0;
  margin: var(--space-4) 0 0;
  list-style: none;
}

.course-home__path li {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  text-align: center;
}

.course-home__path li[data-status='current'] {
  border-color: var(--color-brand-strong);
  background: var(--color-brand-soft);
}

.course-home__path span {
  font-weight: 750;
}

.course-home__path small {
  color: var(--color-muted);
}

.course-home__summary {
  font-weight: 700;
}

.course-home__eyebrow {
  color: var(--color-brand-strong);
  font-size: 14px;
  font-weight: 750;
}

.course-home h1 {
  font-size: clamp(30px, 8vw, 46px);
}

.course-home p {
  color: var(--color-muted);
  line-height: 1.6;
}

.course-home :deep(.ui-button) {
  width: 100%;
  margin-top: var(--space-4);
}
</style>
