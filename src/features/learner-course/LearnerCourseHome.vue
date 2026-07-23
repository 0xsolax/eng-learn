<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiFailureError, ApiNetworkError } from '@/api/errors'
import { isLearnerSessionAccessError } from '@/api/learnerSessionErrors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import type {
  CompletedLessonPageDto,
  CourseHomeDto,
} from '@shared/api/courseSchemas'
import type { LearnerApiPort } from './learnerApiPort'

type CourseApi = Pick<LearnerApiPort, 'getCourseHome' | 'startLesson'> &
  Partial<Pick<LearnerApiPort, 'listCompletedLessons' | 'startLessonReplay'>>

const props = defineProps<{ api: CourseApi }>()
type CompletedLessonSummaryDto = CompletedLessonPageDto['lessons'][number]
type LessonChoice = {
  learningRunNo: number
  lessonNo: number
  status: 'completed' | 'current' | 'locked'
  sourceSessionId?: string
}
const emit = defineEmits<{
  started: [sessionId: string]
  'replay-started': [replaySessionId: string]
  'access-required': []
}>()

const home = ref<CourseHomeDto>()
const loading = ref(true)
const loadError = ref<string>()
const loadErrorTitle = ref<string>()
const accessRequired = ref(false)
const starting = ref(false)
const startError = ref<string>()
const completedLessons = ref<CompletedLessonSummaryDto[]>([])
const completedLessonsCurrentRunNo = ref<number>()
const completedLessonsLoading = ref(false)
const completedLessonsError = ref<string>()
const completedLessonsNextCursor = ref<string>()
const replayingSourceSessionId = ref<string>()
const replayError = ref<string>()

const lessonChoiceGroups = computed(() => {
  if (!home.value) return []

  const currentLearningRunNo = completedLessonsCurrentRunNo.value ?? 1
  const groups = new Map<number, Map<number, LessonChoice>>()
  for (const lesson of completedLessons.value) {
    const lessons = groups.get(lesson.learningRunNo) ?? new Map<number, LessonChoice>()
    lessons.set(lesson.lessonNo, {
      learningRunNo: lesson.learningRunNo,
      lessonNo: lesson.lessonNo,
      status: 'completed',
      sourceSessionId: lesson.sourceSessionId,
    })
    groups.set(lesson.learningRunNo, lessons)
  }

  const currentChoices =
    groups.get(currentLearningRunNo) ?? new Map<number, LessonChoice>()
  for (const node of home.value.lessonPath) {
    const existing = currentChoices.get(node.lessonNo)
    if (node.status !== 'completed' || !existing?.sourceSessionId) {
      currentChoices.set(node.lessonNo, {
        learningRunNo: currentLearningRunNo,
        lessonNo: node.lessonNo,
        status: node.status,
        ...(existing?.sourceSessionId
          ? { sourceSessionId: existing.sourceSessionId }
          : {}),
      })
    }
  }
  groups.set(currentLearningRunNo, currentChoices)

  return [...groups.entries()]
    .sort(([leftRunNo], [rightRunNo]) => {
      if (leftRunNo === currentLearningRunNo) return -1
      if (rightRunNo === currentLearningRunNo) return 1
      return rightRunNo - leftRunNo
    })
    .map(([learningRunNo, lessons]) => ({
      learningRunNo,
      lessons: [...lessons.values()].sort(
        (left, right) => left.lessonNo - right.lessonNo,
      ),
    }))
})

const isLegacyContentError = (error: unknown): boolean =>
  error instanceof ApiFailureError && error.code === 'legacy_content_incompatible'

const startLesson = async (): Promise<void> => {
  if (!home.value || starting.value || replayingSourceSessionId.value) return

  starting.value = true
  startError.value = undefined
  try {
    const lesson = await props.api.startLesson(home.value.course.id)
    emit('started', lesson.session.id)
  } catch (error) {
    if (isLearnerSessionAccessError(error)) {
      home.value = undefined
      emit('access-required')
    } else if (isLegacyContentError(error)) {
      startError.value = '本课内容暂时无法使用，请联系课程管理员处理后再试'
    } else if (
      error instanceof ApiFailureError &&
      error.code === 'course_unavailable'
    ) {
      startError.value = '当前课程暂时无法开始，请联系课程管理员检查课时配置后再试'
    } else if (error instanceof ApiNetworkError) {
      startError.value = '暂时无法开始课时，请检查网络后重试'
    } else {
      startError.value = '暂时无法开始课时，请稍后重试'
    }
  } finally {
    starting.value = false
  }
}

const loadCompletedLessons = async (append = false): Promise<void> => {
  if (!home.value || !props.api.listCompletedLessons || completedLessonsLoading.value) return

  completedLessonsLoading.value = true
  completedLessonsError.value = undefined
  try {
    const page: CompletedLessonPageDto = await props.api.listCompletedLessons(
      home.value.course.id,
      {
        limit: 20,
        ...(append && completedLessonsNextCursor.value
          ? { cursor: completedLessonsNextCursor.value }
          : {}),
      },
    )
    completedLessons.value = append
      ? [...completedLessons.value, ...page.lessons]
      : page.lessons
    completedLessonsCurrentRunNo.value = page.currentLearningRunNo
    completedLessonsNextCursor.value = page.nextCursor
  } catch (error) {
    if (isLearnerSessionAccessError(error)) {
      home.value = undefined
      emit('access-required')
      return
    }
    completedLessonsError.value = '已完成课时暂时无法读取，请稍后重试'
  } finally {
    completedLessonsLoading.value = false
  }
}

const startReplay = async (sourceSessionId: string): Promise<void> => {
  if (!props.api.startLessonReplay || replayingSourceSessionId.value || starting.value) return

  replayingSourceSessionId.value = sourceSessionId
  replayError.value = undefined
  try {
    const replay = await props.api.startLessonReplay(sourceSessionId)
    emit('replay-started', replay.session.id)
  } catch (error) {
    if (isLearnerSessionAccessError(error)) {
      home.value = undefined
      emit('access-required')
    } else if (error instanceof ApiNetworkError) {
      replayError.value = '暂时无法进入该课，请检查网络后重试'
    } else {
      replayError.value = '暂时无法进入该课，请稍后重试'
    }
  } finally {
    replayingSourceSessionId.value = undefined
  }
}

const lessonChoiceStatus = (choice: LessonChoice): string => {
  if (choice.status === 'completed') return '已完成'
  if (choice.status === 'locked') return '未开放'
  return home.value?.action === 'continue' ? '继续' : '当前'
}

const isLessonChoiceLoading = (choice: LessonChoice): boolean =>
  (choice.status === 'current' && starting.value) ||
  (choice.status === 'completed' &&
    choice.sourceSessionId !== undefined &&
    replayingSourceSessionId.value === choice.sourceSessionId)

const isLessonChoiceDisabled = (choice: LessonChoice): boolean =>
  choice.status === 'locked' ||
  starting.value ||
  replayingSourceSessionId.value !== undefined ||
  (choice.status === 'completed' && !choice.sourceSessionId)

const selectLesson = async (choice: LessonChoice): Promise<void> => {
  if (choice.status === 'current') {
    await startLesson()
  } else if (choice.status === 'completed' && choice.sourceSessionId) {
    await startReplay(choice.sourceSessionId)
  }
}

const loadCourse = async (): Promise<void> => {
  loading.value = true
  loadError.value = undefined
  loadErrorTitle.value = undefined
  accessRequired.value = false
  try {
    home.value = await props.api.getCourseHome()
    completedLessons.value = []
    completedLessonsCurrentRunNo.value = undefined
    completedLessonsNextCursor.value = undefined
    void loadCompletedLessons()
  } catch (error) {
    home.value = undefined
    accessRequired.value = isLearnerSessionAccessError(error)
    const legacyContentError = isLegacyContentError(error)
    loadErrorTitle.value = accessRequired.value
      ? '学习会话已失效'
      : legacyContentError
        ? '课程内容暂时不可用'
        : '无法读取课程'
    loadError.value = accessRequired.value
      ? '学习会话已失效，请重新登录'
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
      重新登录
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
      课程进度
    </p>
    <h1>选择课时</h1>
    <p>当前学习到第 {{ home.course.currentLessonNo }} 课。</p>
    <p class="course-home__summary">
      当前课：{{ home.newWordCount }} 个新词 · {{ home.reviewWordCount }} 个复习词
    </p>
    <UiStatusMessage
      v-if="startError"
      tone="error"
      title="未能进入课时"
    >
      {{ startError }}
    </UiStatusMessage>
    <UiStatusMessage
      v-if="replayError"
      tone="error"
      title="未能进入课时"
    >
      {{ replayError }}
    </UiStatusMessage>
    <section
      data-lesson-picker
      class="lesson-picker"
      aria-label="课时选择"
    >
      <UiStatusMessage
        v-if="completedLessonsError"
        tone="error"
        title="无法读取完整课时列表"
      >
        当前课仍可进入；其他课时暂时无法读取。
      </UiStatusMessage>
      <section
        v-for="group in lessonChoiceGroups"
        :key="group.learningRunNo"
        class="lesson-picker__group"
        :aria-label="group.learningRunNo === completedLessonsCurrentRunNo
          ? `当前学习，第 ${group.learningRunNo} 轮`
          : `第 ${group.learningRunNo} 轮`"
      >
        <h2
          v-if="lessonChoiceGroups.length > 1 || group.learningRunNo > 1"
        >
          {{ group.learningRunNo === completedLessonsCurrentRunNo ? '当前学习 · ' : '' }}第
          {{ group.learningRunNo }} 轮
        </h2>
        <div class="lesson-picker__choices">
          <button
            v-for="lesson in group.lessons"
            :key="`${lesson.learningRunNo}:${lesson.lessonNo}`"
            type="button"
            class="lesson-picker__choice"
            data-lesson-choice
            :data-learning-run-no="lesson.learningRunNo"
            :data-lesson-no="lesson.lessonNo"
            :data-status="lesson.status"
            :aria-label="`第 ${lesson.lessonNo} 课，${lessonChoiceStatus(lesson)}`"
            :aria-busy="isLessonChoiceLoading(lesson)"
            :disabled="isLessonChoiceDisabled(lesson)"
            @click="selectLesson(lesson)"
          >
            <span>第 {{ lesson.lessonNo }} 课</span>
            <small>
              {{ isLessonChoiceLoading(lesson) ? '正在进入' : lessonChoiceStatus(lesson) }}
            </small>
          </button>
        </div>
      </section>
      <UiButton
        v-if="completedLessonsError"
        context="learner"
        variant="secondary"
        data-action="reload-completed-lessons"
        @click="loadCompletedLessons()"
      >
        重新读取
      </UiButton>
      <UiButton
        v-else-if="completedLessonsNextCursor"
        context="learner"
        variant="secondary"
        data-action="load-more-completed-lessons"
        :loading="completedLessonsLoading"
        @click="loadCompletedLessons(true)"
      >
        显示更多课时
      </UiButton>
    </section>
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

.lesson-picker__choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  padding: 0;
  margin: 0;
  list-style: none;
}

.lesson-picker__choice {
  appearance: none;
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font: inherit;
  text-align: center;
  cursor: pointer;
}

.lesson-picker__choice[data-status='current'] {
  border-color: var(--color-brand-strong);
  background: var(--color-brand-soft);
}

.lesson-picker__choice:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--color-brand) 36%, transparent);
  outline-offset: 2px;
}

.lesson-picker__choice:disabled {
  cursor: not-allowed;
}

.lesson-picker__choice[data-status='locked'] {
  opacity: 0.58;
}

.lesson-picker__choice span {
  font-weight: 750;
}

.lesson-picker__choice small {
  color: var(--color-muted);
}

.course-home__summary {
  font-weight: 700;
}

.lesson-picker {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.lesson-picker h2,
.lesson-picker p {
  margin: 0;
}

.lesson-picker__group {
  display: grid;
  gap: var(--space-3);
}

.lesson-picker__group h2 {
  margin: 0;
  color: var(--color-muted);
  font-size: 14px;
}

.lesson-picker > :deep(.ui-button) {
  margin-top: 0;
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
