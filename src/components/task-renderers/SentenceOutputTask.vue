<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import type {
  LessonTaskDto,
  SentenceOutputPreviewRequest,
  SubmitTaskAnswerRequest,
} from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'sentence_output' }>['prompt']
type RestoredPreview = NonNullable<
  Extract<LessonTaskDto, { taskType: 'sentence_output' }>['preview']
>
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'sentence_output' }>

const props = withDefaults(
  defineProps<{
    prompt: Prompt
    disabled?: boolean
    referenceSentence?: string
    restoredPreview?: RestoredPreview
  }>(),
  { disabled: false },
)
const emit = defineEmits<{
  preview: [request: SentenceOutputPreviewRequest]
  submit: [submission: Submission]
}>()
const draft = ref(props.restoredPreview?.draft ?? '')
const previewRequested = ref(Boolean(props.restoredPreview))
const previewPending = ref(false)
const submitted = ref(false)
const referenceAnnouncement = ref<HTMLElement>()
const visibleReferenceSentence = computed(
  () => props.restoredPreview?.referenceSentence ?? props.referenceSentence,
)
const previewReady = computed(
  () => previewRequested.value && Boolean(visibleReferenceSentence.value),
)

const preview = (): void => {
  const value = draft.value.trim()
  if (value && !props.disabled && !previewPending.value) {
    previewRequested.value = true
    previewPending.value = true
    emit('preview', { taskType: 'sentence_output', draft: value })
  }
}
const submit = (selfScore: 0 | 1 | 2 | 3): void => {
  const value = draft.value.trim()
  if (value && visibleReferenceSentence.value && !props.disabled && !submitted.value) {
    submitted.value = true
    emit('submit', { taskType: 'sentence_output', draft: value, selfScore })
  }
}

watch(previewReady, async (ready) => {
  if (ready) {
    await nextTick()
    referenceAnnouncement.value?.focus()
  }
})
</script>

<template>
  <section class="task-form">
    <p class="task-instruction">
      {{ prompt.instruction }}
    </p>
    <h2>{{ prompt.meaning }}</h2>
    <label for="sentence-output">写下你的英文句子</label>
    <textarea
      id="sentence-output"
      v-model="draft"
      rows="4"
      :disabled="disabled || (previewPending && !previewReady)"
      :readonly="previewReady"
    />
    <UiButton
      v-if="!previewReady"
      context="learner"
      data-action="preview"
      :disabled="disabled || previewPending || !draft.trim()"
      @click="preview"
    >
      查看参考句
    </UiButton>
    <div
      v-else
      class="reference"
    >
      <div
        ref="referenceAnnouncement"
        class="reference__announcement"
        role="status"
        aria-live="polite"
        tabindex="-1"
      >
        <strong>参考句</strong>
        <p lang="en">
          {{ visibleReferenceSentence }}
        </p>
      </div>
      <fieldset>
        <legend>和参考句比一比，你给自己几分？</legend>
        <button
          v-for="score in ([0, 1, 2, 3] as const)"
          :key="score"
          type="button"
          :data-self-score="score"
          :disabled="disabled || submitted"
          @click="submit(score)"
        >
          {{ score }} 分
        </button>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.task-form { display: grid; gap: var(--space-4); }
.task-instruction, h2, .reference p { margin: 0; }
.task-instruction { color: var(--color-muted); }
h2 { font-size: clamp(24px, 6vw, 38px); }
label, .reference strong, legend { font-weight: 750; }
textarea { width: 100%; min-height: 120px; resize: vertical; padding: var(--space-4); border: 2px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-ink); font: inherit; font-size: 18px; line-height: 1.5; }
textarea:focus-visible { border-color: var(--color-brand-strong); outline: 3px solid var(--color-brand-strong); outline-offset: 2px; }
textarea:disabled { background: var(--color-line); color: var(--color-muted); cursor: not-allowed; }
.reference { display: grid; gap: var(--space-3); padding: var(--space-4); border: 2px solid var(--color-brand); border-radius: var(--radius-md); background: var(--color-brand-soft); }
.reference__announcement { display: grid; gap: var(--space-2); }
.reference p { font-size: 18px; }
fieldset { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); margin: 0; padding: var(--space-3) 0 0; border: 0; }
legend { grid-column: 1 / -1; margin-bottom: var(--space-2); }
fieldset button { min-height: 56px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-ink); font: inherit; font-weight: 700; cursor: pointer; }
fieldset button:disabled { background: var(--color-line); color: var(--color-muted); cursor: not-allowed; }
@media (max-width: 479px) { fieldset { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
