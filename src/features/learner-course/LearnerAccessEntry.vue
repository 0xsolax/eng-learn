<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { ApiFailureError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import {
  enterCourseByAccessCodeRequestSchema,
  enterCourseByAccountRequestSchema,
} from '@shared/api/schemas'
import type { LearnerApiPort, LearnerSession } from './learnerApiPort'

type AccessApi = Pick<
  LearnerApiPort,
  'exchangeAccountLogin' | 'exchangeAccessCode' | 'restoreSession'
>

const props = defineProps<{ api: AccessApi }>()
const emit = defineEmits<{ authenticated: [session: LearnerSession] }>()

const restoring = ref(true)
const loginAccount = ref('')
const pin = ref('')
const accountError = ref<string>()
const submittingAccount = ref(false)
const showLegacyCode = ref(false)
const accessCode = ref('')
const codeError = ref<string>()
const submittingCode = ref(false)
const restoreError = ref<string>()

const focusPin = async (): Promise<void> => {
  await nextTick()
  document.querySelector<HTMLInputElement>('#learner-login-pin')?.focus()
}

const submitAccount = async (): Promise<void> => {
  if (submittingAccount.value) return

  const parsed = enterCourseByAccountRequestSchema.safeParse({
    loginAccount: loginAccount.value,
    pin: pin.value,
  })
  if (!parsed.success) {
    accountError.value = '请输入有效的学习账号和 6 位 PIN'
    await focusPin()
    return
  }

  submittingAccount.value = true
  accountError.value = undefined
  let shouldRefocusPin = false
  try {
    const session = await props.api.exchangeAccountLogin(
      parsed.data.loginAccount,
      parsed.data.pin,
    )
    pin.value = ''
    emit('authenticated', session)
  } catch (error) {
    pin.value = ''
    accountError.value =
      error instanceof ApiFailureError && error.code === 'learner_login_rate_limited'
        ? '尝试次数过多，请稍后重试'
        : error instanceof ApiFailureError && error.code === 'invalid_learner_credentials'
          ? '账号或 PIN 不正确'
          : '暂时无法进入课程，请稍后重试'
    shouldRefocusPin = true
  } finally {
    submittingAccount.value = false
  }

  if (shouldRefocusPin) await focusPin()
}

const submitAccessCode = async (): Promise<void> => {
  if (submittingCode.value) return

  const parsed = enterCourseByAccessCodeRequestSchema.safeParse({
    accessCode: accessCode.value,
  })
  if (!parsed.success) {
    codeError.value = '请输入有效的 10 位学习码'
    return
  }

  submittingCode.value = true
  codeError.value = undefined
  try {
    const session = await props.api.exchangeAccessCode(parsed.data.accessCode)
    accessCode.value = ''
    emit('authenticated', session)
  } catch (error) {
    codeError.value =
      error instanceof ApiFailureError && error.code === 'invalid_access_code'
        ? '学习码无效，请重新检查'
        : '暂时无法进入课程，请稍后重试'
  } finally {
    submittingCode.value = false
  }
}

onMounted(async () => {
  try {
    const session = await props.api.restoreSession()
    emit('authenticated', session)
  } catch (error) {
    if (error instanceof ApiFailureError) {
      if (error.code === 'learner_session_expired' || error.code === 'learner_session_revoked') {
        restoreError.value = '学习会话已失效，请重新登录'
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
      data-account-form
      class="access-form"
      @submit.prevent="submitAccount"
    >
      <UiInput
        id="learner-login-account"
        v-model="loginAccount"
        context="learner"
        label="学习账号"
        hint="输入老师为你设置的账号"
        :disabled="submittingAccount"
        maxlength="32"
        autocomplete="username"
        autocapitalize="none"
        spellcheck="false"
      />
      <UiInput
        id="learner-login-pin"
        v-model="pin"
        context="learner"
        type="password"
        label="6 位 PIN"
        hint="只输入 6 位数字"
        v-bind="accountError === undefined ? {} : { error: accountError }"
        :disabled="submittingAccount"
        maxlength="6"
        inputmode="numeric"
        autocomplete="current-password"
        pattern="[0-9]*"
      />
      <UiButton
        type="submit"
        context="learner"
        :loading="submittingAccount"
        loading-label="正在进入"
      >
        进入课程
      </UiButton>
    </form>

    <div class="legacy-access">
      <UiButton
        data-toggle-legacy-code
        context="learner"
        variant="secondary"
        :aria-expanded="String(showLegacyCode)"
        aria-controls="legacy-code-region"
        @click="showLegacyCode = !showLegacyCode"
      >
        {{ showLegacyCode ? '收起原学习码登录' : '使用原学习码' }}
      </UiButton>
      <Transition name="legacy-reveal">
        <form
          v-if="showLegacyCode"
          id="legacy-code-region"
          data-legacy-code-form
          class="access-form legacy-access__form"
          @submit.prevent="submitAccessCode"
        >
          <UiInput
            id="learner-access-code"
            v-model="accessCode"
            context="learner"
            label="10 位学习码"
            hint="仅适用于老师尚未设置学习账号的旧课程"
            v-bind="codeError === undefined ? {} : { error: codeError }"
            :disabled="submittingCode"
            maxlength="10"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
          />
          <UiButton
            type="submit"
            context="learner"
            variant="secondary"
            :loading="submittingCode"
            loading-label="正在进入"
          >
            使用学习码进入
          </UiButton>
        </form>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.access-entry__ready,
.access-form,
.legacy-access {
  display: grid;
  gap: var(--space-4);
}

.access-form :deep(.ui-button),
.legacy-access > :deep(.ui-button) {
  width: 100%;
}

.legacy-access {
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.legacy-access__form {
  transform-origin: top;
}

.legacy-reveal-enter-active,
.legacy-reveal-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.legacy-reveal-enter-from,
.legacy-reveal-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .legacy-reveal-enter-active,
  .legacy-reveal-leave-active {
    transition: none;
  }
}
</style>
