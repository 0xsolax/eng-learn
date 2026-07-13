<script setup lang="ts">
import { ref, watch } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'

const props = defineProps<{
  lessonNo: number
  position: number
  total: number
  feedback?: {
    tone: 'neutral' | 'info' | 'success' | 'error'
    title: string
    message: string
  }
  retryLabel?: string
}>()

const emit = defineEmits<{ exit: []; retry: [] }>()
const retryQueued = ref(false)

const retry = (): void => {
  if (!retryQueued.value) {
    retryQueued.value = true
    emit('retry')
  }
}

watch(
  () => props.retryLabel,
  (retryLabel, previousRetryLabel) => {
    if (retryLabel !== previousRetryLabel) retryQueued.value = false
  },
)
</script>

<template>
  <section class="task-shell">
    <header class="task-shell__header">
      <button
        type="button"
        class="task-shell__exit"
        data-action="exit"
        aria-label="退出本课"
        @click="$emit('exit')"
      >
        退出
      </button>
      <strong>第 {{ lessonNo }} 课</strong>
      <span>{{ position }} / {{ total }}</span>
    </header>
    <div
      class="task-shell__progress"
      role="progressbar"
      aria-label="本课进度"
      aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuenow="position"
    >
      <span :style="{ inlineSize: `${total === 0 ? 0 : Math.min(100, position / total * 100)}%` }" />
    </div>
    <div class="task-shell__body">
      <slot />
    </div>
    <UiStatusMessage
      v-if="feedback"
      :tone="feedback.tone"
      :title="feedback.title"
    >
      <p>{{ feedback.message }}</p>
    </UiStatusMessage>
    <UiButton
      v-if="retryLabel"
      context="learner"
      data-action="retry"
      :disabled="retryQueued"
      @click="retry"
    >
      {{ retryLabel }}
    </UiButton>
  </section>
</template>

<style scoped>
.task-shell { display: grid; gap: var(--space-6); }
.task-shell__header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: var(--space-3); }
.task-shell__header strong { text-align: center; }
.task-shell__header > span { color: var(--color-muted); font-variant-numeric: tabular-nums; text-align: end; }
.task-shell__exit { min-width: 48px; min-height: 48px; justify-self: start; padding: 0 var(--space-3); border: 1px solid var(--color-line-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-ink); font: inherit; font-weight: 700; cursor: pointer; }
.task-shell__exit:focus-visible { outline: 3px solid var(--color-brand-strong); outline-offset: 2px; }
.task-shell__progress { height: 8px; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-line); }
.task-shell__progress span { display: block; block-size: 100%; border-radius: inherit; background: var(--color-brand-strong); transition: transform var(--motion-feedback) var(--ease-standard); transform-origin: left; }
.task-shell__body { min-width: 0; padding-block: var(--space-4); }
</style>
