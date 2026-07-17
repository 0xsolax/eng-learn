<script setup lang="ts">
import FillBlankTask from './FillBlankTask.vue'
import MultipleChoiceTask from './MultipleChoiceTask.vue'
import RecallWordTask from './RecallWordTask.vue'
import RecognizeMeaningTask from './RecognizeMeaningTask.vue'
import SentenceBuildTask from './SentenceBuildTask.vue'
import SentenceOutputTask from './SentenceOutputTask.vue'
import type {
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
  TaskRenderDto,
} from '@shared/api/taskSchemas'

withDefaults(
  defineProps<{
    task: TaskRenderDto
    disabled?: boolean
    referenceSentence?: string
    recoveryDraft?: string
  }>(),
  { disabled: false },
)

defineEmits<{
  preview: [request: SentenceOutputPreviewRequest]
  submit: [submission: SubmitTaskAnswerRequest]
}>()

const rendererCoverage = {
  recognize_meaning: true,
  recall_word: true,
  multiple_choice: true,
  fill_blank: true,
  sentence_build: true,
  sentence_output: true,
} satisfies Record<TaskRenderDto['taskType'], true>

void rendererCoverage
</script>

<template>
  <RecognizeMeaningTask
    v-if="task.taskType === 'recognize_meaning'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    @submit="$emit('submit', $event)"
  />
  <RecallWordTask
    v-else-if="task.taskType === 'recall_word'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    @submit="$emit('submit', $event)"
  />
  <MultipleChoiceTask
    v-else-if="task.taskType === 'multiple_choice'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    @submit="$emit('submit', $event)"
  />
  <FillBlankTask
    v-else-if="task.taskType === 'fill_blank'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    @submit="$emit('submit', $event)"
  />
  <SentenceBuildTask
    v-else-if="task.taskType === 'sentence_build'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    @submit="$emit('submit', $event)"
  />
  <SentenceOutputTask
    v-else-if="task.taskType === 'sentence_output'"
    :key="task.id"
    :prompt="task.prompt"
    :disabled="disabled"
    v-bind="{
      ...(referenceSentence === undefined ? {} : { referenceSentence }),
      ...(task.preview === undefined ? {} : { restoredPreview: task.preview }),
      ...(recoveryDraft === undefined ? {} : { recoveryDraft }),
    }"
    @preview="$emit('preview', $event)"
    @submit="$emit('submit', $event)"
  />
</template>
