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

const completedLessonGroups = computed(() => {
  const groups = new Map<number, CompletedLessonSummaryDto[]>()
  for (const lesson of completedLessons.value) {
    const lessons = groups.get(lesson.learningRunNo) ?? []
    lessons.push(lesson)
    groups.set(lesson.learningRunNo, lessons)
  }
  return [...groups.entries()].map(([learningRunNo, lessons]) => ({
    learningRunNo,
    lessons,
  }))
})

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

const startReplay = async (lesson: CompletedLessonSummaryDto): Promise<void> => {
  if (!props.api.startLessonReplay || replayingSourceSessionId.value) return

  replayingSourceSessionId.value = lesson.sourceSessionId
  replayError.value = undefined
  try {
    const replay = await props.api.startLessonReplay(lesson.sourceSessionId)
    emit('replay-started', replay.session.id)
  } catch (error) {
    if (isLearnerSessionAccessError(error)) {
      home.value = undefined
      emit('access-required')
    } else if (error instanceof ApiNetworkError) {
      replayError.value = '暂时无法开始重复练习，请检查网络后重试'
    } else {
      replayError.value = '暂时无法开始重复练习，请稍后重试'
    }
  } finally {
    replayingSourceSessionId.value = undefined
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
    <section
      v-if="props.api.listCompletedLessons && props.api.startLessonReplay"
      data-completed-lessons
      class="completed-lessons"
      aria-labelledby="completed-lessons-title"
    >
      <header>
        <div>
          <h2 id="completed-lessons-title">
            选择已完成课时重新练习
          </h2>
          <p>重复练习不会改变当前课程进度。</p>
        </div>
      </header>
      <UiStatusMessage
        v-if="replayError"
        tone="error"
        title="未能开始重复练习"
      >
        {{ replayError }}
      </UiStatusMessage>
      <UiStatusMessage
        v-if="completedLessonsError"
        tone="error"
        title="无法读取已完成课时"
      >
        {{ completedLessonsError }}
      </UiStatusMessage>
      <div
        v-if="completedLessons.length > 0"
        class="completed-lessons__groups"
      >
        <section
          v-for="group in completedLessonGroups"
          :key="group.learningRunNo"
          class="completed-lessons__group"
          :aria-labelledby="`completed-run-${group.learningRunNo}`"
        >
          <h3 :id="`completed-run-${group.learningRunNo}`">
            {{ group.learningRunNo === completedLessonsCurrentRunNo ? '当前轮次' : '历史轮次' }}
            · 第 {{ group.learningRunNo }} 轮
          </h3>
          <div class="completed-lessons__choices">
            <UiButton
              v-for="lesson in group.lessons"
              :key="lesson.sourceSessionId"
              context="learner"
              variant="secondary"
              data-action="repeat-lesson"
              :loading="replayingSourceSessionId === lesson.sourceSessionId"
              :disabled="replayingSourceSessionId !== undefined"
              @click="startReplay(lesson)"
            >
              第 {{ lesson.lessonNo }} 课，再练一次
            </UiButton>
          </div>
        </section>
      </div>
      <p
        v-else-if="!completedLessonsLoading && !completedLessonsError"
        class="completed-lessons__empty"
      >
        完成一课后，可在这里再次选择练习。
      </p>
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
        读取更多课时
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

.completed-lessons {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-6);
  padding-top: var(--space-5);
  border-top: 1px solid var(--color-line);
}

.completed-lessons h2,
.completed-lessons p {
  margin: 0;
}

.completed-lessons h2 {
  font-size: 18px;
}

.completed-lessons__choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.completed-lessons__groups,
.completed-lessons__group {
  display: grid;
  gap: var(--space-3);
}

.completed-lessons__group h3 {
  margin: 0;
  color: var(--color-muted);
  font-size: 14px;
}

.completed-lessons__choices :deep(.ui-button),
.completed-lessons > :deep(.ui-button) {
  margin-top: 0;
}

.completed-lessons__empty {
  padding: var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-sm);
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

@media (max-width: 479px) {
  .completed-lessons__choices {
    grid-template-columns: 1fr;
  }
}
</style>
