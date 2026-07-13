<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { createAdminApi } from '@/api/adminApi'
import { subscribeAdminAuthorizationFailure } from '@/api/adminAuthorizationBoundary'
import { ApiFailureError, InvalidApiResponseError } from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'

type AdminSessionApi = Pick<ReturnType<typeof createAdminApi>, 'getAdminSession'>
type GateState = 'checking' | 'ready' | 'unauthorized' | 'error'

const props = defineProps<{
  api?: AdminSessionApi
}>()

const api = props.api ?? createAdminApi()
const state = ref<GateState>('checking')
const unsubscribeAuthorizationFailure = subscribeAdminAuthorizationFailure(() => {
  state.value = 'unauthorized'
})

const isRejectedAdminIdentity = (error: unknown): boolean =>
  (error instanceof ApiFailureError &&
    ['unauthorized', 'admin_disabled', 'admin_identity_invalid'].includes(error.code)) ||
  (error instanceof InvalidApiResponseError &&
    (error.status === 401 || error.status === 403))

const verifyIdentity = async (): Promise<void> => {
  state.value = 'checking'

  try {
    await api.getAdminSession()
    state.value = 'ready'
  } catch (error) {
    state.value = isRejectedAdminIdentity(error) ? 'unauthorized' : 'error'
  }
}

onUnmounted(unsubscribeAuthorizationFailure)
void verifyIdentity()
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

    <ui-status-message
      v-else-if="state === 'unauthorized'"
      tone="error"
      title="管理员身份未通过"
    >
      请通过受保护的管理端入口重新进入。
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
        @click="verifyIdentity"
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
