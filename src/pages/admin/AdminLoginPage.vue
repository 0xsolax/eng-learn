<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LoaderCircle, LogIn } from '@lucide/vue'
import { createAdminApi } from '@/api/adminApi'
import { isAdminSessionFailureCode } from '@/api/adminAuthorizationBoundary'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import { resolveSafeAdminReturnTo } from '@/features/admin-auth/adminRoutePolicy'

type AdminLoginApi = Pick<
  ReturnType<typeof createAdminApi>,
  'getAdminSession' | 'loginAdmin'
>

const props = defineProps<{
  api?: AdminLoginApi
}>()

const api = props.api ?? createAdminApi()
const route = useRoute()
const router = useRouter()
type LoginState =
  | 'checking'
  | 'checkNetworkError'
  | 'checkServiceError'
  | 'idle'
  | 'submitting'
  | 'invalidCredentials'
  | 'coolingDown'
  | 'notConfigured'
  | 'networkError'
  | 'serviceError'

const state = ref<LoginState>('checking')
const username = ref('')
const password = ref('')
const passwordInput = ref<HTMLInputElement | null>(null)
const cooldownSeconds = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | undefined
const errorMessage = computed(() =>
  state.value === 'invalidCredentials'
    ? '账号或密码不正确'
    : state.value === 'coolingDown'
      ? `尝试次数过多，请在 ${String(cooldownSeconds.value)} 秒后重试`
      : state.value === 'notConfigured'
        ? '管理员登录尚未配置，请先在部署终端完成初始化'
        : state.value === 'networkError'
          ? '无法连接服务器，请检查网络后重试'
          : state.value === 'serviceError'
            ? '登录服务暂不可用，请稍后重试'
            : '',
)
const recoveryNotice = computed(() =>
  route.query.reason === 'expired'
    ? '登录已过期，请重新登录'
    : route.query.reason === 'invalid'
      ? '登录已失效，请重新登录'
      : route.query.reason === 'logged_out'
        ? '已安全退出'
        : '',
)
const recoveryNoticeTone = computed(() =>
  route.query.reason === 'logged_out' ? 'success' : 'info',
)
const errorTone = computed(() =>
  state.value === 'coolingDown' || state.value === 'notConfigured'
    ? 'warning'
    : 'error',
)

const isUnavailableSession = (error: unknown): boolean =>
  (error instanceof ApiFailureError && isAdminSessionFailureCode(error.code)) ||
  (error instanceof InvalidApiResponseError &&
    (error.status === 401 || error.status === 403))

const startCooldown = (seconds: number): void => {
  if (cooldownTimer !== undefined) {
    clearInterval(cooldownTimer)
  }

  cooldownSeconds.value = seconds
  state.value = 'coolingDown'
  cooldownTimer = setInterval(() => {
    cooldownSeconds.value -= 1
    if (cooldownSeconds.value <= 0) {
      clearInterval(cooldownTimer)
      cooldownTimer = undefined
      state.value = 'idle'
    }
  }, 1_000)
}

const checkExistingSession = async (): Promise<void> => {
  state.value = 'checking'

  try {
    await api.getAdminSession()
    await router.replace(resolveSafeAdminReturnTo(router, route.query.returnTo))
  } catch (error) {
    state.value = isUnavailableSession(error)
      ? 'idle'
      : error instanceof ApiNetworkError
        ? 'checkNetworkError'
        : 'checkServiceError'
    if (
      state.value === 'idle' &&
      (route.query.reason === 'expired' || route.query.reason === 'invalid')
    ) {
      await nextTick()
      passwordInput.value?.focus()
    }
  }
}

const submitLogin = async (): Promise<void> => {
  if (state.value === 'submitting' || cooldownSeconds.value > 0) {
    return
  }

  state.value = 'submitting'

  try {
    await api.loginAdmin({ username: username.value, password: password.value })
    password.value = ''
    await router.replace(resolveSafeAdminReturnTo(router, route.query.returnTo))
  } catch (error) {
    password.value = ''

    if (error instanceof ApiFailureError && error.code === 'invalid_admin_credentials') {
      state.value = 'invalidCredentials'
      await nextTick()
      passwordInput.value?.focus()
      return
    }

    if (
      error instanceof ApiFailureError &&
      error.apiError.code === 'admin_login_rate_limited'
    ) {
      startCooldown(error.apiError.details.retryAfterSeconds)
      return
    }

    if (error instanceof ApiFailureError && error.code === 'admin_not_configured') {
      state.value = 'notConfigured'
      return
    }

    if (error instanceof ApiNetworkError) {
      try {
        await api.getAdminSession()
        await router.replace(resolveSafeAdminReturnTo(router, route.query.returnTo))
        return
      } catch (sessionError) {
        state.value = isUnavailableSession(sessionError) ? 'networkError' : 'serviceError'
        await nextTick()
        passwordInput.value?.focus()
        return
      }
    }

    state.value = 'serviceError'
  }
}

onMounted(() => {
  void checkExistingSession()
})

onUnmounted(() => {
  if (cooldownTimer !== undefined) {
    clearInterval(cooldownTimer)
  }
})
</script>

<template>
  <main class="admin-login-page">
    <section
      class="admin-login-card"
      aria-labelledby="admin-login-title"
    >
      <div class="admin-login-brand">
        <span
          class="admin-login-brand__mark"
          aria-hidden="true"
        >Aa</span>
        <div>
          <strong lang="en">eng learn</strong>
          <span>内容管理</span>
        </div>
      </div>

      <header class="admin-login-heading">
        <h1 id="admin-login-title">
          管理员登录
        </h1>
        <p>使用已在终端初始化的管理员账号进入内容工作台。</p>
      </header>

      <p
        v-if="state === 'checking'"
        class="admin-login-checking"
        role="status"
      >
        <loader-circle
          :size="18"
          aria-hidden="true"
        />
        <span>正在检查管理员会话…</span>
      </p>
      <div
        v-else-if="state === 'checkNetworkError' || state === 'checkServiceError'"
        class="admin-login-check-error"
      >
        <p
          class="admin-login-message admin-login-message--error"
          role="alert"
        >
          {{
            state === 'checkNetworkError'
              ? '无法连接服务器，请检查网络后重试'
              : '登录服务暂不可用，请稍后重试'
          }}
        </p>
        <ui-button
          variant="secondary"
          @click="checkExistingSession"
        >
          重新检查
        </ui-button>
      </div>
      <form
        v-else
        @submit.prevent="submitLogin"
      >
        <p
          v-if="recoveryNotice"
          class="admin-login-message"
          :class="`admin-login-message--${recoveryNoticeTone}`"
          role="status"
        >
          {{ recoveryNotice }}
        </p>
        <p
          v-if="errorMessage"
          class="admin-login-message"
          :class="`admin-login-message--${errorTone}`"
          role="alert"
        >
          {{ errorMessage }}
        </p>
        <label for="admin-username">管理员账号</label>
        <input
          id="admin-username"
          v-model="username"
          name="username"
          autocomplete="username"
          placeholder="输入管理员账号"
          required
          :disabled="state === 'submitting'"
        >
        <label for="admin-password">密码</label>
        <input
          id="admin-password"
          ref="passwordInput"
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="输入管理员密码"
          required
          :disabled="state === 'submitting'"
        >
        <ui-button
          class="admin-login-submit"
          type="submit"
          :loading="state === 'submitting'"
          :disabled="cooldownSeconds > 0 || state === 'notConfigured'"
          loading-label="正在登录…"
        >
          <log-in
            :size="18"
            aria-hidden="true"
          />
          {{ state === 'coolingDown' ? '稍后重试' : '登录管理台' }}
        </ui-button>
      </form>

      <router-link
        class="admin-login-learner-link"
        to="/app"
      >
        前往学生学习端
      </router-link>
    </section>
  </main>
</template>

<style scoped>
.admin-login-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: var(--space-4);
  background: var(--color-canvas);
}

.admin-login-card {
  display: grid;
  width: min(100%, 420px);
  gap: 0;
  padding: 30px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: var(--shadow-low);
}

.admin-login-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: 26px;
}

.admin-login-brand__mark {
  display: inline-grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid var(--color-brand-strong);
  border-radius: var(--radius-sm);
  background: var(--color-brand-strong);
  color: var(--color-surface);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 700;
}

.admin-login-brand > div {
  display: grid;
  gap: 2px;
}

.admin-login-brand strong {
  font-family: var(--font-display);
  font-size: 16px;
  line-height: 1.2;
}

.admin-login-brand div span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 600;
}

.admin-login-heading {
  display: grid;
  gap: var(--space-2);
  margin-bottom: 22px;
}

.admin-login-heading h1,
.admin-login-heading p,
.admin-login-checking,
.admin-login-check-error p {
  margin: 0;
}

.admin-login-heading h1 {
  font-size: 24px;
  line-height: 1.3;
}

.admin-login-heading p,
.admin-login-checking {
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.6;
}

.admin-login-card form,
.admin-login-check-error {
  display: grid;
  gap: var(--space-4);
}

.admin-login-checking {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--color-sky) 45%, var(--color-line));
  border-radius: var(--radius-sm);
  background: var(--color-sky-soft);
}

.admin-login-card label {
  margin-bottom: calc(-1 * var(--space-2));
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 700;
}

.admin-login-card input {
  width: 100%;
  height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
}

.admin-login-card input:hover:not(:disabled) {
  border-color: var(--color-brand);
}

.admin-login-message {
  padding: var(--space-3);
  margin: 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.5;
}

.admin-login-message--error {
  border-color: color-mix(in srgb, var(--color-coral) 45%, var(--color-line));
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
}

.admin-login-message--info {
  border-color: color-mix(in srgb, var(--color-sky) 45%, var(--color-line));
  background: var(--color-sky-soft);
  color: var(--color-ink);
}

.admin-login-message--warning {
  border-color: color-mix(in srgb, var(--color-sun) 55%, var(--color-line));
  background: var(--color-sun-soft);
  color: #71550a;
}

.admin-login-message--success {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-line));
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.admin-login-submit {
  width: 100%;
  margin-top: var(--space-1);
}

.admin-login-learner-link {
  justify-self: center;
  margin-top: 18px;
  color: var(--color-brand-strong);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}

@media (max-width: 479px) {
  .admin-login-card {
    padding: var(--space-6);
  }
}
</style>
