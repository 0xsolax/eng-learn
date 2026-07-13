<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { enterCourseByAccessCodeRequestSchema } from '@shared/api/schemas'
import type { LearnerApiPort, LearnerSession } from './learnerApiPort'

type AccessApi = Pick<LearnerApiPort, 'exchangeAccessCode' | 'restoreSession'>

const props = defineProps<{ api: AccessApi }>()
const emit = defineEmits<{ authenticated: [session: LearnerSession] }>()

const restoring = ref(true)
const accessCode = ref('')
const inputError = ref<string>()
const submitting = ref(false)
const restoreError = ref<string>()

const submitAccessCode = async (): Promise<void> => {
  if (submitting.value) return

  const parsed = enterCourseByAccessCodeRequestSchema.safeParse({
    accessCode: accessCode.value,
  })
  if (!parsed.success) {
    inputError.value = '请输入有效的 10 位学习码'
    return
  }

  submitting.value = true
  inputError.value = undefined
  try {
    const session = await props.api.exchangeAccessCode(parsed.data.accessCode)
    accessCode.value = ''
    emit('authenticated', session)
  } catch (error) {
    inputError.value =
      error instanceof ApiFailureError && error.code === 'invalid_access_code'
        ? '学习码无效，请重新检查'
        : '暂时无法进入课程，请稍后重试'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  try {
    const session = await props.api.restoreSession()
    emit('authenticated', session)
  } catch (error) {
    if (error instanceof ApiFailureError) {
      if (error.code === 'learner_session_expired' || error.code === 'learner_session_revoked') {
        restoreError.value = '学习会话已失效，请重新输入学习码'
      } else if (error.code !== 'learner_session_required') {
        restoreError.value = '无法恢复学习会话，请检查网络后重试'
      }
    } else {
      restoreError.value = '无法恢复学习会话，请检查网络后重试'
    }
    restoring.value = false
  }
})
</script>

<template>
  <UiStatusMessage
    v-if="restoring"
    tone="info"
    title="正在恢复学习会话"
  >
    请稍候。
  </UiStatusMessage>
  <div
    v-else
    class="access-entry__ready"
  >
    <UiStatusMessage
      v-if="restoreError"
      tone="error"
      title="无法恢复学习会话"
    >
      {{ restoreError }}
    </UiStatusMessage>
    <form
      class="access-form"
      @submit.prevent="submitAccessCode"
    >
      <UiInput
        id="learner-access-code"
        v-model="accessCode"
        context="learner"
        label="10 位学习码"
        hint="输入老师提供的 10 位学习码"
        v-bind="inputError === undefined ? {} : { error: inputError }"
        :disabled="submitting"
        maxlength="10"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
      />
      <UiButton
        type="submit"
        context="learner"
        :loading="submitting"
        loading-label="正在进入"
      >
        进入课程
      </UiButton>
    </form>
  </div>
</template>

<style scoped>
.access-entry__ready,
.access-form {
  display: grid;
  gap: var(--space-4);
}

.access-form :deep(.ui-button) {
  width: 100%;
}
</style>
