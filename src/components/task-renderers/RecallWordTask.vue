<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'recall_word' }>['prompt']
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'recall_word' }>

const props = withDefaults(defineProps<{ prompt: Prompt; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ submit: [submission: Submission] }>()
const answer = ref('')
const submitted = ref(false)

const submit = (): void => {
  const value = answer.value.trim()
  if (value && !props.disabled && !submitted.value) {
    submitted.value = true
    emit('submit', { taskType: 'recall_word', answer: value })
  }
}
</script>

<template>
  <form
    class="task-form"
    @submit.prevent="submit"
  >
    <p class="task-instruction">
      根据意思，写出英文单词。
    </p>
    <h2>{{ prompt.meaning }}</h2>
    <UiInput
      v-model="answer"
      label="写出英文单词"
      context="learner"
      autocomplete="off"
      autocapitalize="none"
      :disabled="disabled || submitted"
    />
    <UiButton
      context="learner"
      type="submit"
      :disabled="disabled || submitted || !answer.trim()"
    >
      检查答案
    </UiButton>
  </form>
</template>

<style scoped>
.task-form { display: grid; gap: var(--space-6); }
.task-instruction { margin: 0; color: var(--color-muted); }
h2 { margin: 0; font-size: clamp(28px, 7vw, 42px); line-height: 1.25; }
</style>
