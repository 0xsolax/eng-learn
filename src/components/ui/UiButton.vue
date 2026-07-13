<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: 'button' | 'submit' | 'reset'
    variant?: 'primary' | 'secondary'
    context?: 'admin' | 'learner'
    disabled?: boolean
    loading?: boolean
    loadingLabel?: string
  }>(),
  {
    type: 'button',
    variant: 'primary',
    context: 'admin',
    disabled: false,
    loading: false,
    loadingLabel: '处理中',
  },
)

defineEmits<{
  click: [event: MouseEvent]
}>()
</script>

<template>
  <button
    :type="type"
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${context}`]"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="$emit('click', $event)"
  >
    <span
      v-if="loading"
      class="ui-button__spinner"
      aria-hidden="true"
    />
    <span>{{ loading ? loadingLabel : undefined }}<slot v-if="!loading" /></span>
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  cursor: pointer;
  transition: transform var(--motion-fast) var(--ease-standard);
}

.ui-button--admin {
  min-height: 40px;
  padding: 0 var(--space-4);
  font-size: 14px;
}

.ui-button--learner {
  min-height: 56px;
  padding: var(--space-3) var(--space-6);
  font-size: 16px;
}

.ui-button--primary {
  background: var(--color-brand-strong);
  color: var(--color-surface);
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--color-brand-strong-hover);
}

.ui-button--primary.ui-button--learner {
  background: var(--color-brand-strong-hover);
  box-shadow: var(--shadow-learner-button);
}

.ui-button--secondary {
  border-color: var(--color-line-strong);
  background: var(--color-surface);
  color: var(--color-ink);
}

.ui-button--secondary:hover:not(:disabled) {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.ui-button--admin:active:not(:disabled) {
  transform: scale(0.96);
}

.ui-button--learner:active:not(:disabled) {
  box-shadow: 0 1px 0 var(--color-brand-strong-hover);
  transform: translateY(2px);
}

.ui-button:disabled {
  border-color: var(--color-line);
  background: var(--color-line);
  box-shadow: none;
  color: var(--color-muted);
  cursor: not-allowed;
  transform: none;
}

.ui-button__spinner {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ui-button-spin 700ms linear infinite;
}

@keyframes ui-button-spin {
  to {
    transform: rotate(1turn);
  }
}

@media (forced-colors: active) {
  .ui-button {
    border-color: ButtonText;
  }

  .ui-button:disabled {
    border-color: GrayText;
  }
}
</style>
