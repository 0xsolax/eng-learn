<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    tone?: 'neutral' | 'info' | 'success' | 'error'
    title: string
  }>(),
  {
    tone: 'neutral',
  },
)

const role = computed(() => (props.tone === 'error' ? 'alert' : 'status'))
const live = computed(() => (props.tone === 'error' ? 'assertive' : 'polite'))
</script>

<template>
  <section
    class="ui-status status-enter"
    :class="`ui-status--${tone}`"
    :role="role"
    :aria-live="live"
    aria-atomic="true"
  >
    <span
      class="ui-status__marker"
      aria-hidden="true"
    />
    <div class="ui-status__content">
      <h2 class="ui-status__title">
        {{ title }}
      </h2>
      <div
        v-if="$slots.default"
        class="ui-status__body"
      >
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
.ui-status {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-ink);
}

.ui-status--info {
  border-color: color-mix(in srgb, var(--color-sky) 45%, var(--color-line));
  background: var(--color-sky-soft);
}

.ui-status--success {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-line));
  background: var(--color-brand-soft);
}

.ui-status--error {
  border-color: color-mix(in srgb, var(--color-coral) 45%, var(--color-line));
  background: var(--color-coral-soft);
}

.ui-status__marker {
  width: 12px;
  height: 12px;
  margin-top: 5px;
  border: 3px solid var(--color-muted);
  border-radius: 50%;
}

.ui-status--info .ui-status__marker {
  border-color: var(--color-sky);
}

.ui-status--success .ui-status__marker {
  border-color: var(--color-brand-strong);
  border-radius: var(--radius-xs);
}

.ui-status--error .ui-status__marker {
  border-color: var(--color-coral-strong);
  border-radius: 2px;
  transform: rotate(45deg);
}

.ui-status__content {
  min-width: 0;
}

.ui-status__title {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}

.ui-status__body {
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.6;
}

.ui-status--info .ui-status__body,
.ui-status--success .ui-status__body {
  color: var(--color-ink);
}

.ui-status--error .ui-status__body {
  color: var(--color-coral-strong);
}

.ui-status__body :deep(*) {
  margin-block: 0;
}

@media (forced-colors: active) {
  .ui-status,
  .ui-status__marker {
    border-color: CanvasText;
  }
}
</style>
