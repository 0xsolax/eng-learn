<script setup lang="ts">
import { onMounted, onUnmounted, provide, readonly, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AdminSessionDto } from '@shared/api/adminAuthSchemas'
import { createAdminApi } from '@/api/adminApi'
import {
  getAdminSessionFailureCode,
  isAdminSessionAccessError,
  subscribeAdminAuthorizationFailure,
  type AdminSessionFailureCode,
} from '@/api/adminAuthorizationBoundary'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { resolveSafeAdminReturnTo } from '@/features/admin-auth/adminRoutePolicy'
import {
  adminSessionContextKey,
  type AdminSessionContext,
} from '@/features/admin-auth/adminSessionContext'

type AdminSessionApi = Pick<
  ReturnType<typeof createAdminApi>,
  'getAdminSession' | 'logoutAdmin'
>
type GateState = 'checking' | 'ready' | 'error'

const props = defineProps<{
  api?: AdminSessionApi
  navigateToAccessLogout?: () => void
}>()

const api = props.api ?? createAdminApi()
const router = useRouter()
const route = useRoute()
const state = ref<GateState>('checking')
const session = ref<AdminSessionDto | null>(null)
let requestVersion = 0
const SERVICE_TOKEN_BROWSER_REJECTED = new Error(
  'Service-token identities cannot mount the browser admin shell',
)

const sessionFailureReason = (
  code: AdminSessionFailureCode | undefined,
): 'expired' | 'invalid' | undefined =>
  code === 'admin_session_expired'
    ? 'expired'
    : code === 'admin_session_revoked' || code === 'admin_identity_invalid'
      ? 'invalid'
      : undefined

const clearPrivateState = (): void => {
  requestVersion += 1
  session.value = null
  state.value = 'checking'
}

const redirectToLogin = async (reason?: 'expired' | 'invalid'): Promise<void> => {
  const returnTo = resolveSafeAdminReturnTo(router, route.fullPath)
  await router.replace({
    name: 'admin-login',
    query: {
      returnTo,
      ...(reason ? { reason } : {}),
    },
  })
}

const refreshSession = async (): Promise<AdminSessionDto> => {
  const version = ++requestVersion
  state.value = 'checking'

  try {
    const currentSession = await api.getAdminSession()
    if (version !== requestVersion) {
      return currentSession
    }
    if (currentSession.source === 'service_token') {
      session.value = null
      await redirectToLogin('invalid')
      throw SERVICE_TOKEN_BROWSER_REJECTED
    }
    session.value = currentSession
    state.value = 'ready'
    return currentSession
  } catch (error) {
    if (version !== requestVersion) {
      throw error
    }
    session.value = null
    if (error === SERVICE_TOKEN_BROWSER_REJECTED) {
      state.value = 'checking'
    } else if (isAdminSessionAccessError(error)) {
      await redirectToLogin(sessionFailureReason(getAdminSessionFailureCode(error)))
    } else {
      state.value = 'error'
    }
    throw error
  }
}

const navigateToAccessLogout = (): void => {
  if (props.navigateToAccessLogout) {
    props.navigateToAccessLogout()
    return
  }
  window.location.assign('/cdn-cgi/access/logout')
}

const logout = async (): Promise<void> => {
  if (session.value?.source === 'cloudflare_access') {
    navigateToAccessLogout()
    return
  }
  if (session.value?.source !== 'application_session') {
    throw new Error('Service-token sessions cannot enter the browser admin shell')
  }

  await api.logoutAdmin()
  clearPrivateState()
  try {
    await router.replace({ name: 'admin-login', query: { reason: 'logged_out' } })
  } catch (error) {
    state.value = 'error'
    throw error
  }
}

const invalidateSession = (code: AdminSessionFailureCode): void => {
  clearPrivateState()
  void redirectToLogin(
    code === 'admin_session_expired' ? 'expired' : 'invalid',
  ).catch(() => {
    state.value = 'error'
  })
}

const context: AdminSessionContext = {
  session: readonly(session),
  refreshSession,
  logout,
  clearPrivateState,
}
provide(adminSessionContextKey, context)

const unsubscribeAuthorizationFailure = subscribeAdminAuthorizationFailure(invalidateSession)

const handlePageShow = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    void refreshSession().catch(() => undefined)
  }
}

onMounted(() => {
  window.addEventListener('pageshow', handlePageShow)
  void refreshSession().catch(() => undefined)
})

onUnmounted(() => {
  requestVersion += 1
  unsubscribeAuthorizationFailure()
  window.removeEventListener('pageshow', handlePageShow)
})
</script>

<template>
  <main
    v-if="state !== 'ready'"
    class="admin-gate"
  >
    <h1 class="sr-only">
      管理端身份验证
    </h1>
    <ui-status-message
      v-if="state === 'checking'"
      tone="info"
      title="正在验证管理员身份"
    >
      业务工作台会在服务端确认身份后显示。
    </ui-status-message>

    <template v-else>
      <ui-status-message
        tone="error"
        title="无法验证管理员身份"
      >
        网络或身份服务暂时不可用，工作台尚未载入。
      </ui-status-message>
      <ui-button
        variant="secondary"
        @click="refreshSession"
      >
        重新验证
      </ui-button>
    </template>
  </main>

  <slot v-else>
    <router-view />
  </slot>
</template>

<style scoped>
.admin-gate {
  display: grid;
  width: min(100% - (2 * var(--space-6)), 560px);
  min-height: 100vh;
  align-content: center;
  justify-items: start;
  gap: var(--space-4);
  margin-inline: auto;
}
</style>
