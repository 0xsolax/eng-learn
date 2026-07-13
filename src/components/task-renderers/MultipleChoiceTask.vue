<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'multiple_choice' }>['prompt']
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'multiple_choice' }>

const props = withDefaults(defineProps<{ prompt: Prompt; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ submit: [submission: Submission] }>()
const selected = ref('')
const submitted = ref(false)

const submit = (): void => {
  if (selected.value && !props.disabled && !submitted.value) {
    submitted.value = true
    emit('submit', { taskType: 'multiple_choice', answer: selected.value })
  }
}
</script>

<template>
  <form
    class="task-form"
    @submit.prevent="submit"
  >
    <fieldset :disabled="disabled || submitted">
      <legend>选择“{{ prompt.meaning }}”对应的英文单词</legend>
      <label
        v-for="option in prompt.options"
        :key="option"
        class="choice-row"
      >
        <input
          v-model="selected"
          type="radio"
          name="word-choice"
          :value="option"
        >
        <span lang="en">{{ option }}</span>
      </label>
    </fieldset>
    <UiButton
      context="learner"
      type="submit"
      :disabled="disabled || submitted || !selected"
    >
      检查答案
    </UiButton>
  </form>
</template>

<style scoped>
.task-form, fieldset { display: grid; gap: var(--space-3); }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: var(--space-4); font-size: 22px; font-weight: 750; line-height: 1.4; }
.choice-row { display: grid; grid-template-columns: 24px minmax(0, 1fr); min-height: 56px; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 2px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); cursor: pointer; }
.choice-row:has(input:checked) { border-color: var(--color-brand-strong); background: var(--color-brand-soft); }
.choice-row:has(input:focus-visible) { outline: 3px solid var(--color-brand-strong); outline-offset: 2px; }
fieldset:disabled .choice-row { background: var(--color-canvas); color: var(--color-muted); cursor: not-allowed; }
.choice-row input { width: 20px; height: 20px; accent-color: var(--color-brand-strong); }
.choice-row span { font-size: 18px; font-weight: 700; }
</style>
