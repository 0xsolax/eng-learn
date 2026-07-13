<script setup lang="ts">
import { ref } from 'vue'
import TaskRenderer from '@/components/task-renderers/TaskRenderer.vue'
import type {
  LessonTaskDto,
  SubmitTaskAnswerRequest,
} from '@shared/api/taskSchemas'

const base = {
  sessionId: 'fixture-session',
  courseId: 'fixture-course',
  wordId: 'fixture-word',
  status: 'pending' as const,
  role: 'primary' as const,
  required: false,
}

const tasks = {
  recognize: {
    ...base,
    id: 'fixture-s0',
    orderIndex: 1,
    stage: 'S0',
    taskType: 'recognize_meaning',
    prompt: { word: 'apple', meaning: '苹果', exampleSentence: 'I see an apple.' },
  },
  recall: {
    ...base,
    id: 'fixture-s1',
    orderIndex: 2,
    stage: 'S1',
    taskType: 'recall_word',
    prompt: { meaning: '苹果' },
  },
  choice: {
    ...base,
    id: 'fixture-s2',
    orderIndex: 3,
    stage: 'S2',
    taskType: 'multiple_choice',
    prompt: { meaning: '苹果', options: ['pear', 'apple', 'peach'] },
  },
  fill: {
    ...base,
    id: 'fixture-s3',
    orderIndex: 4,
    stage: 'S3',
    taskType: 'fill_blank',
    prompt: { sentence: 'I see an ____.' },
  },
  build: {
    ...base,
    id: 'fixture-s4',
    orderIndex: 5,
    stage: 'S4',
    taskType: 'sentence_build',
    prompt: {
      pieces: [
        { id: 'correct-position-2', text: 'see' },
        { id: 'correct-position-3', text: 'an apple' },
        { id: 'correct-position-1', text: 'I' },
      ],
    },
  },
  output: {
    ...base,
    id: 'fixture-s5',
    orderIndex: 6,
    stage: 'S5',
    taskType: 'sentence_output',
    prompt: { meaning: '我看见一个苹果。', instruction: '写一个完整英文句子' },
  },
} satisfies Record<string, LessonTaskDto>

const submittedTypes = ref<string[]>([])
const referenceSentence = ref<string>()

const recordSubmission = (submission: SubmitTaskAnswerRequest): void => {
  submittedTypes.value.push(submission.taskType)
}

const showReference = (): void => {
  referenceSentence.value = 'PRIVATE REFERENCE SENTENCE'
}
</script>

<template>
  <main class="fixture-main">
    <h1>六类任务浏览器夹具</h1>
    <p
      data-testid="submission-status"
      role="status"
    >
      已提交 {{ submittedTypes.length }} 类任务
    </p>

    <section
      data-renderer="s0"
      aria-label="S0 认识任务"
    >
      <TaskRenderer
        :task="tasks.recognize"
        @submit="recordSubmission"
      />
    </section>
    <section
      data-renderer="s1"
      aria-label="S1 回忆任务"
    >
      <TaskRenderer
        :task="tasks.recall"
        @submit="recordSubmission"
      />
    </section>
    <section
      data-renderer="s2"
      aria-label="S2 选择任务"
    >
      <TaskRenderer
        :task="tasks.choice"
        @submit="recordSubmission"
      />
    </section>
    <section
      data-renderer="s3"
      aria-label="S3 填空任务"
    >
      <TaskRenderer
        :task="tasks.fill"
        @submit="recordSubmission"
      />
    </section>
    <section
      data-renderer="s4"
      aria-label="S4 拼句任务"
    >
      <TaskRenderer
        :task="tasks.build"
        @submit="recordSubmission"
      />
    </section>
    <section
      data-renderer="s5"
      aria-label="S5 输出任务"
    >
      <TaskRenderer
        :task="tasks.output"
        v-bind="referenceSentence === undefined ? {} : { referenceSentence }"
        @preview="showReference"
        @submit="recordSubmission"
      />
    </section>
  </main>
</template>

<style scoped>
.fixture-main {
  display: grid;
  width: min(100%, var(--learner-content-width));
  gap: var(--space-8);
  margin-inline: auto;
  padding: var(--space-8) max(20px, env(safe-area-inset-right)) var(--space-8)
    max(20px, env(safe-area-inset-left));
}

.fixture-main > h1,
.fixture-main > p {
  margin: 0;
}

.fixture-main > section {
  min-width: 0;
  padding-block: var(--space-8);
  border-block-start: 1px solid var(--color-line);
}
</style>
