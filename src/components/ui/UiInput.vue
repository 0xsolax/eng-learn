<script setup lang="ts">
import { computed, useId } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    id?: string
    label: string
    modelValue: string
    hint?: string
    error?: string
    context?: 'admin' | 'learner'
    type?: 'text' | 'email' | 'password' | 'search'
    disabled?: boolean
  }>(),
  {
    context: 'admin',
    type: 'text',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const generatedId = useId()
const inputId = computed(() => props.id ?? generatedId)
const hintId = computed(() => `${inputId.value}-hint`)
const errorId = computed(() => `${inputId.value}-error`)
const describedBy = computed(() => {
  const ids = [props.hint ? hintId.value : undefined, props.error ? errorId.value : undefined].filter(
    (value): value is string => Boolean(value),
  )

  return ids.length > 0 ? ids.join(' ') : undefined
})

const handleInput = (event: Event): void => {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div
    class="ui-field"
    :class="`ui-field--${context}`"
  >
    <label
      class="ui-field__label"
      :for="inputId"
    >{{ label }}</label>
    <input
      v-bind="$attrs"
      :id="inputId"
      class="ui-field__input"
      :class="{ 'ui-field__input--error': error }"
      :type="type"
      :value="modelValue"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      @input="handleInput"
    >
    <p
      v-if="hint"
      :id="hintId"
      class="ui-field__hint"
    >
      {{ hint }}
    </p>
    <p
      v-if="error"
      :id="errorId"
      class="ui-field__error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.ui-field {
  display: grid;
  gap: var(--space-2);
  color: var(--color-ink);
}

.ui-field__label {
  font-weight: 700;
  line-height: 1.4;
}

.ui-field--admin .ui-field__label {
  font-size: 13px;
}

.ui-field--learner .ui-field__label {
  font-size: 14px;
}

.ui-field__input {
  width: 100%;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
}

.ui-field--admin .ui-field__input {
  min-height: 40px;
  padding: 0 var(--space-3);
  font-size: 14px;
}

.ui-field--learner .ui-field__input {
  min-height: 52px;
  padding: 0 var(--space-4);
  font-size: 18px;
  font-weight: 600;
}

.ui-field__input:hover:not(:disabled) {
  border-color: var(--color-muted);
}

.ui-field__input:focus-visible {
  border-color: var(--color-focus);
  outline: 3px solid var(--color-focus);
  outline-offset: 2px;
  box-shadow: 0 0 0 3px var(--color-brand-soft);
}

.ui-field__input--error {
  border-color: var(--color-coral);
}

.ui-field__input--error:focus-visible {
  border-color: var(--color-coral-strong);
  outline-color: var(--color-coral-strong);
  box-shadow: 0 0 0 3px var(--color-coral-soft);
}

.ui-field__input:disabled {
  background: var(--color-canvas);
  color: var(--color-muted);
  cursor: not-allowed;
}

.ui-field__hint,
.ui-field__error {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.ui-field__hint {
  color: var(--color-muted);
}

.ui-field__error {
  color: var(--color-coral-strong);
  font-weight: 600;
}
</style>
