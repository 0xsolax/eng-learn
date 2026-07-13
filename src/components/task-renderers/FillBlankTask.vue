<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'fill_blank' }>['prompt']
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'fill_blank' }>

const props = withDefaults(defineProps<{ prompt: Prompt; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ submit: [submission: Submission] }>()
const answer = ref('')
const submitted = ref(false)

const submit = (): void => {
  const value = answer.value.trim()
  if (value && !props.disabled && !submitted.value) {
    submitted.value = true
    emit('submit', { taskType: 'fill_blank', answer: value })
  }
}
</script>

<template>
  <form
    class="task-form"
    @submit.prevent="submit"
  >
    <p class="task-instruction">
      把缺少的单词填进句子。
    </p>
    <h2 lang="en">
      {{ prompt.sentence }}
    </h2>
    <UiInput
      v-model="answer"
      label="填入缺少的单词"
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
h2 { margin: 0; font-size: clamp(24px, 6vw, 38px); line-height: 1.45; }
</style>
