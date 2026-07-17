import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ImportedSourceVersion } from '@shared/domain/content'
import type { ImportSourceVersionCommand } from '@/api/adminApi'
import { ApiFailureError } from '@/api/errors'
import {
  clearPendingSourceVersionImport,
  getSourceVersionImportConfirmationDelay,
  persistPendingSourceVersionImport,
  requiresSourceVersionImportConfirmation,
  restorePendingSourceVersionImport,
  type PendingSourceVersionImport,
} from './importRecovery'

export type SourceVersionImportState =
  | 'idle'
  | 'submitting'
  | 'confirming'
  | 'success'
  | 'failure'

type UseSourceVersionImportInput = {
  importSourceVersion: (
    command: ImportSourceVersionCommand,
  ) => Promise<ImportedSourceVersion>
  onImported: () => Promise<void>
  onInvalidRestore: () => void
  onRestore: (command: PendingSourceVersionImport) => void
}

export const useSourceVersionImport = ({
  importSourceVersion,
  onImported,
  onInvalidRestore,
  onRestore,
}: UseSourceVersionImportInput) => {
  const importState = ref<SourceVersionImportState>('idle')
  const importError = ref('')
  const importSuccess = ref('')
  const pendingCommand = ref<PendingSourceVersionImport | null>(null)
  const isImportBusy = computed(
    () => importState.value === 'submitting' || importState.value === 'confirming',
  )
  let requestInFlight = false
  let disposed = false
  let confirmationAttempt = 0
  let confirmationTimer: number | undefined
  const isDisposed = (): boolean => disposed

  const clearConfirmationTimer = (): void => {
    if (confirmationTimer === undefined) return

    window.clearTimeout(confirmationTimer)
    confirmationTimer = undefined
  }

  const executeImport = async (
    command: PendingSourceVersionImport,
    nextState: Extract<SourceVersionImportState, 'submitting' | 'confirming'>,
  ): Promise<void> => {
    if (disposed || requestInFlight) return

    requestInFlight = true
    clearConfirmationTimer()
    pendingCommand.value = command
    importState.value = nextState
    importError.value = ''
    importSuccess.value = ''

    try {
      const imported = await importSourceVersion(command)

      pendingCommand.value = null
      confirmationAttempt = 0
      clearPendingSourceVersionImport()

      if (isDisposed()) return

      try {
        await onImported()
      } catch {
        // The confirmed import result remains authoritative if list refresh fails.
      }

      if (isDisposed()) return

      importState.value = 'success'
      importSuccess.value = `服务端已创建 v${String(imported.versionNo)}，确认 ${String(imported.wordCount)} 个词、${String(imported.groupCount)} 个分组。`
    } catch (error) {
      if (isDisposed()) {
        if (!requiresSourceVersionImportConfirmation(error)) {
          pendingCommand.value = null
          confirmationAttempt = 0
          clearPendingSourceVersionImport()
        }
        return
      }

      if (requiresSourceVersionImportConfirmation(error)) {
        importState.value = 'confirming'
        scheduleImportConfirmation(command)
        return
      }

      importState.value = 'failure'
      pendingCommand.value = null
      confirmationAttempt = 0
      clearPendingSourceVersionImport()
      importError.value = getImportError(error)
    } finally {
      requestInFlight = false
    }
  }

  const scheduleImportConfirmation = (
    command: PendingSourceVersionImport,
    immediate = false,
  ): void => {
    clearConfirmationTimer()

    if (disposed || document.visibilityState === 'hidden' || !navigator.onLine) return

    const delay = immediate
      ? 0
      : getSourceVersionImportConfirmationDelay(confirmationAttempt++)

    confirmationTimer = window.setTimeout(() => {
      confirmationTimer = undefined
      void executeImport(command, 'confirming')
    }, delay)
  }

  const resumeImportConfirmation = (): void => {
    if (
      disposed ||
      importState.value !== 'confirming' ||
      requestInFlight ||
      !pendingCommand.value
    ) return

    scheduleImportConfirmation(pendingCommand.value, true)
  }

  const syncImportVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      clearConfirmationTimer()
      return
    }

    resumeImportConfirmation()
  }

  const submitImportCommand = async (
    command: ImportSourceVersionCommand,
  ): Promise<void> => {
    if (disposed) return

    let persistedCommand: PendingSourceVersionImport

    try {
      persistedCommand = persistPendingSourceVersionImport(command)
    } catch {
      importState.value = 'failure'
      importError.value = '浏览器无法保存本次导入状态，尚未向服务端提交。请释放当前标签页存储后重试。'
      return
    }

    pendingCommand.value = persistedCommand
    confirmationAttempt = 0
    await executeImport(persistedCommand, 'submitting')
  }

  const resetImportResult = (): void => {
    if (isImportBusy.value) return

    importState.value = 'idle'
    importError.value = ''
    importSuccess.value = ''
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', syncImportVisibility)
    window.addEventListener('online', resumeImportConfirmation)

    const restored = restorePendingSourceVersionImport()

    if (restored.status === 'invalid') {
      onInvalidRestore()
      importState.value = 'failure'
      importError.value = '当前标签页的导入恢复数据无效，已安全清除，未发送导入请求。'
      return
    }

    if (restored.status !== 'ready') return

    const command = restored.command

    onRestore(command)
    pendingCommand.value = command
    importState.value = 'confirming'

    if (document.visibilityState === 'hidden' || !navigator.onLine) {
      scheduleImportConfirmation(command)
    } else {
      void executeImport(command, 'confirming')
    }
  })

  onBeforeUnmount(() => {
    disposed = true
    clearConfirmationTimer()
    document.removeEventListener('visibilitychange', syncImportVisibility)
    window.removeEventListener('online', resumeImportConfirmation)
  })

  return {
    importError,
    importState,
    importSuccess,
    isImportBusy,
    resetImportResult,
    submitImportCommand,
  }
}

const getImportError = (error: unknown): string => {
  if (error instanceof ApiFailureError && error.code === 'source_draft_exists') {
    return '该词库已有草稿版本，请先继续处理或丢弃现有草稿。'
  }

  if (error instanceof ApiFailureError && error.code === 'validation_error') {
    return '服务端未接受这份词表，请按字段错误修正后重试。'
  }

  if (error instanceof ApiFailureError && error.code === 'schema_not_ready') {
    return '服务端数据库尚未完成升级，本次导入未创建。请完成数据库迁移后重试。'
  }

  if (error instanceof ApiFailureError && error.code === 'internal_error') {
    return '服务端未能完成本次导入，请稍后重新提交。'
  }

  if (error instanceof ApiFailureError && error.code === 'dependency_failure') {
    return '服务端暂时不可用，本次导入未进入提交，请稍后重新提交。'
  }

  return '导入未完成，请重新读取服务端状态或修正输入后再操作。'
}
