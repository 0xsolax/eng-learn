<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'recognize_meaning' }>['prompt']
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'recognize_meaning' }>

const props = withDefaults(defineProps<{ prompt: Prompt; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ submit: [submission: Submission] }>()
const submitted = ref(false)

const submit = (response: Submission['response']): void => {
  if (!props.disabled && !submitted.value) {
    submitted.value = true
    emit('submit', { taskType: 'recognize_meaning', response })
  }
}
</script>

<template>
  <section
    class="task-surface"
    aria-labelledby="recognize-word"
  >
    <p class="task-instruction">
      看一看这个单词和意思，你认识它吗？
    </p>
    <h2
      id="recognize-word"
      lang="en"
    >
      {{ prompt.word }}
    </h2>
    <p class="task-meaning">
      {{ prompt.meaning }}
    </p>
    <p
      v-if="prompt.exampleSentence"
      class="task-example"
      lang="en"
    >
      {{ prompt.exampleSentence }}
    </p>
    <div class="task-actions">
      <UiButton
        context="learner"
        variant="secondary"
        data-response="learning"
        :disabled="disabled || submitted"
        @click="submit('learning')"
      >
        还要学习
      </UiButton>
      <UiButton
        context="learner"
        data-response="known"
        :disabled="disabled || submitted"
        @click="submit('known')"
      >
        我认识
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.task-surface { display: grid; gap: var(--space-4); }
.task-instruction, .task-meaning, .task-example { margin: 0; }
.task-instruction, .task-example { color: var(--color-muted); }
h2 { margin: var(--space-4) 0 0; font-family: var(--font-display); font-size: clamp(36px, 9vw, 56px); line-height: 1.1; }
.task-meaning { font-size: 24px; font-weight: 700; }
.task-example { font-size: 17px; line-height: 1.6; }
.task-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin-top: var(--space-6); }
@media (max-width: 479px) { .task-actions { grid-template-columns: 1fr; } }
</style>
