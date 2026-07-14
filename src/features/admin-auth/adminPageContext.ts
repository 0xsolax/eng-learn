import { inject, type InjectionKey } from 'vue'

export type AdminPageContext = {
  breadcrumbs: readonly string[]
  confirmLeave?: () => boolean | Promise<boolean>
}

export type AdminPageContextPort = {
  setPageContext: (context: AdminPageContext) => void
  clearPageContext: () => void
}

export const adminPageContextKey: InjectionKey<AdminPageContextPort> = Symbol(
  'admin-page-context',
)

export const useAdminPageContext = (): AdminPageContextPort => {
  const context = inject(adminPageContextKey)

  if (!context) {
    throw new Error('Admin page context is unavailable')
  }

  return context
}
