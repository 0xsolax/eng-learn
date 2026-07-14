import type { AdminSessionDto } from '@shared/api/adminAuthSchemas'
import { inject, type InjectionKey, type Ref } from 'vue'

export type AdminSessionContext = {
  session: Readonly<Ref<AdminSessionDto | null>>
  refreshSession: () => Promise<AdminSessionDto>
  logout: () => Promise<void>
  clearPrivateState: () => void
}

export const adminSessionContextKey: InjectionKey<AdminSessionContext> = Symbol(
  'admin-session-context',
)

export const useAdminSessionContext = (): AdminSessionContext => {
  const context = inject(adminSessionContextKey)

  if (!context) {
    throw new Error('Admin session context is unavailable')
  }

  return context
}
