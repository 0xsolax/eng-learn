<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  type ComponentPublicInstance,
} from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import type { LessonTaskDto, SubmitTaskAnswerRequest } from '@shared/api/taskSchemas'

type Prompt = Extract<LessonTaskDto, { taskType: 'sentence_build' }>['prompt']
type Submission = Extract<SubmitTaskAnswerRequest, { taskType: 'sentence_build' }>

const props = withDefaults(defineProps<{ prompt: Prompt; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ submit: [submission: Submission] }>()
const selectedIds = ref<string[]>([])
const submitted = ref(false)
const selectedPieceButtons = new Map<string, HTMLButtonElement>()
const availablePieceButtons = new Map<string, HTMLButtonElement>()
const selectedPieces = computed(() =>
  selectedIds.value.flatMap((id) => props.prompt.pieces.filter((piece) => piece.id === id)),
)
const selectedSentence = computed(() => selectedPieces.value.map((piece) => piece.text).join(' '))
const availablePieces = computed(() =>
  props.prompt.pieces.filter((piece) => !selectedIds.value.includes(piece.id)),
)

const bindPieceButton = (
  buttons: Map<string, HTMLButtonElement>,
  pieceId: string,
  element: Element | ComponentPublicInstance | null,
): void => {
  if (element instanceof HTMLButtonElement) {
    buttons.set(pieceId, element)
  } else {
    buttons.delete(pieceId)
  }
}
const selectPiece = async (pieceId: string): Promise<void> => {
  if (!props.disabled && !submitted.value && !selectedIds.value.includes(pieceId)) {
    selectedIds.value.push(pieceId)
    await nextTick()
    selectedPieceButtons.get(pieceId)?.focus()
  }
}
const removePiece = async (pieceId: string): Promise<void> => {
  if (!props.disabled && !submitted.value) {
    selectedIds.value = selectedIds.value.filter((id) => id !== pieceId)
    await nextTick()
    availablePieceButtons.get(pieceId)?.focus()
  }
}
const submit = (): void => {
  if (
    !props.disabled &&
    !submitted.value &&
    selectedIds.value.length === props.prompt.pieces.length
  ) {
    submitted.value = true
    emit('submit', { taskType: 'sentence_build', pieceIds: [...selectedIds.value] })
  }
}
</script>

<template>
  <form
    class="task-form"
    @submit.prevent="submit"
  >
    <p class="task-instruction">
      按顺序点击词块，拼成一个完整句子。
    </p>
    <p
      class="sr-only"
      aria-live="polite"
    >
      {{ selectedSentence }}
    </p>
    <div
      class="sentence-line"
      aria-label="已经拼好的句子"
    >
      <span v-if="selectedPieces.length === 0">从下面选择第一个词块</span>
      <button
        v-for="piece in selectedPieces"
        v-else
        :key="piece.id"
        :ref="(element) => bindPieceButton(selectedPieceButtons, piece.id, element)"
        type="button"
        :disabled="disabled || submitted"
        :aria-label="`移除词块 ${piece.text}`"
        @click="removePiece(piece.id)"
      >
        {{ piece.text }}<span aria-hidden="true" />
      </button>
    </div>
    <div
      class="piece-bank"
      aria-label="可选词块"
    >
      <button
        v-for="piece in availablePieces"
        :key="piece.id"
        :ref="(element) => bindPieceButton(availablePieceButtons, piece.id, element)"
        type="button"
        :aria-label="`选择词块 ${piece.text}`"
        :disabled="disabled || submitted"
        @click="selectPiece(piece.id)"
      >
        {{ piece.text }}
      </button>
    </div>
    <UiButton
      context="learner"
      type="submit"
      :disabled="disabled || submitted || selectedIds.length !== prompt.pieces.length"
    >
      检查答案
    </UiButton>
  </form>
</template>

<style scoped>
.task-form { display: grid; gap: var(--space-6); }
.task-instruction { margin: 0; color: var(--color-muted); }
.sentence-line, .piece-bank { display: flex; min-height: 64px; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-md); }
.sentence-line { border: 2px solid var(--color-brand); background: var(--color-brand-soft); }
.sentence-line > span { color: var(--color-muted); }
.piece-bank { border: 1px solid var(--color-line); background: var(--color-canvas); }
.sentence-line button, .piece-bank button { min-width: 48px; min-height: 56px; padding: 0 var(--space-4); border: 1px solid var(--color-line-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-ink); font: inherit; font-weight: 700; cursor: pointer; }
.sentence-line button:focus-visible, .piece-bank button:focus-visible { outline: 3px solid var(--color-brand-strong); outline-offset: 2px; }
.sentence-line button:disabled, .piece-bank button:disabled { background: var(--color-line); color: var(--color-muted); cursor: not-allowed; }
</style>
