<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SourceVersionSummaryDto } from '@shared/api/contentSchemas'
import { generateAdminOperationToken } from '@shared/security/adminOperationToken'
import { createAdminApi } from '@/api/adminApi'
import {
  ApiFailureError,
  ApiNetworkError,
  InvalidApiResponseError,
} from '@/api/errors'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import { parseAdminCsv, type CsvImportResult } from '@/features/admin-content/csvImport'

type SourceVersionsApi = Pick<
  ReturnType<typeof createAdminApi>,
  'importSourceVersion' | 'listSourceVersions'
>
type ImportMode = 'new_source' | 'next_version'
type ListState = 'loading' | 'ready' | 'error'
type ImportCommand = Parameters<SourceVersionsApi['importSourceVersion']>[0]
type NewSourceCommand = Extract<ImportCommand, { mode: 'new_source' }>

const props = withDefaults(
  defineProps<{
    api?: SourceVersionsApi
    initialMode?: ImportMode
    initialSourceId?: string
  }>(),
  {
    initialMode: 'new_source',
    initialSourceId: '',
  },
)

const api = props.api ?? createAdminApi()
const versions = ref<SourceVersionSummaryDto[]>([])
const listState = ref<ListState>('loading')
const mode = ref<ImportMode>(props.initialMode)
const sourceName = ref('')
const sourceId = ref(props.initialSourceId)
const preview = ref<CsvImportResult | null>(null)
const previewing = ref(false)
const importing = ref(false)
const importError = ref('')
const importSuccess = ref('')
const pendingNewSource = ref<NewSourceCommand | null>(null)
const unknownResultMode = ref<ImportMode | null>(null)
let fileSelectionSequence = 0

const sources = computed(() => {
  const uniqueSources = new Map<string, { id: string; name: string }>()

  for (const version of versions.value) {
    uniqueSources.set(version.sourceId, {
      id: version.sourceId,
      name: version.sourceName,
    })
  }

  return [...uniqueSources.values()]
})

const canImport = computed(
  () =>
    preview.value?.ok === true &&
    !importing.value &&
    unknownResultMode.value === null &&
    (mode.value === 'new_source' ? sourceName.value.trim().length > 0 : sourceId.value.length > 0),
)

const loadVersions = async (): Promise<void> => {
  listState.value = 'loading'

  try {
    versions.value = await api.listSourceVersions()
    listState.value = 'ready'

    if (mode.value === 'next_version' && !sourceId.value) {
      sourceId.value = sources.value[0]?.id ?? ''
    }
  } catch {
    listState.value = 'error'
  }
}

const handleFile = async (event: Event): Promise<void> => {
  const sequence = ++fileSelectionSequence
  const file = (event.target as HTMLInputElement).files?.[0]
  importError.value = ''
  importSuccess.value = ''
  preview.value = null

  if (!file) {
    previewing.value = false
    return
  }

  previewing.value = true
  const parsed = await parseAdminCsv(file)

  if (sequence !== fileSelectionSequence) return

  preview.value = parsed
  previewing.value = false
}

const submitImport = async (): Promise<void> => {
  if (!canImport.value || preview.value?.ok !== true) return

  const command: ImportCommand =
    mode.value === 'new_source'
      ? {
          mode: 'new_source',
          operationToken: generateAdminOperationToken(),
          sourceName: sourceName.value,
          words: preview.value.words,
        }
      : {
          mode: 'next_version',
          sourceId: sourceId.value,
          words: preview.value.words,
        }

  if (command.mode === 'new_source') pendingNewSource.value = command

  await executeImport(command)
}

const executeImport = async (command: ImportCommand): Promise<void> => {

  importing.value = true
  importError.value = ''
  importSuccess.value = ''
  unknownResultMode.value = null

  try {
    const imported = await api.importSourceVersion(command)

    importSuccess.value = `服务端已创建 v${String(imported.versionNo)}，确认 ${String(imported.wordCount)} 个词、${String(imported.groupCount)} 个分组。`
    pendingNewSource.value = null
    await loadVersions()
  } catch (error) {
    if (isUnknownResult(error)) {
      unknownResultMode.value = command.mode
      return
    }

    pendingNewSource.value = null
    importError.value = getImportError(error)
  } finally {
    importing.value = false
  }
}

const retryUnknownImport = async (): Promise<void> => {
  if (
    unknownResultMode.value !== 'new_source' ||
    !pendingNewSource.value ||
    importing.value
  ) {
    return
  }

  await executeImport(pendingNewSource.value)
}

const reloadUnknownImport = async (): Promise<void> => {
  await loadVersions()

  if (listState.value === 'ready') {
    unknownResultMode.value = null
    pendingNewSource.value = null
  }
}

const setMode = (nextMode: ImportMode): void => {
  if (unknownResultMode.value !== null) return
  mode.value = nextMode
  importError.value = ''
  importSuccess.value = ''

  if (nextMode === 'next_version' && !sourceId.value) {
    sourceId.value = sources.value[0]?.id ?? ''
  }
}

const getImportError = (error: unknown): string => {
  if (error instanceof ApiFailureError && error.code === 'source_draft_exists') {
    return '该词库已有草稿版本，请先继续处理或丢弃现有草稿。'
  }

  if (error instanceof ApiFailureError && error.code === 'validation_error') {
    return '服务端未接受这份词表，请按字段错误修正后重试。'
  }

  return '导入未完成，请重新读取服务端状态或修正输入后再操作。'
}

const isUnknownResult = (error: unknown): boolean =>
  error instanceof ApiNetworkError ||
  error instanceof InvalidApiResponseError ||
  (error instanceof ApiFailureError &&
    (error.code === 'dependency_failure' || error.code === 'internal_error'))

const statusLabel = (status: SourceVersionSummaryDto['status']): string =>
  ({ draft: '草稿', published: '已发布', archived: '已丢弃' })[status]

onMounted(loadVersions)
</script>

<template>
  <section class="admin-page page-enter">
    <header class="page-heading">
      <div>
        <p>内容构建</p>
        <h1>词库版本</h1>
        <span>先预览并校验 CSV，再由服务端创建新词库或同一词库的下一版本。</span>
      </div>
    </header>

    <section
      class="import-workspace"
      aria-labelledby="import-title"
    >
      <header class="section-heading">
        <div>
          <h2 id="import-title">
            导入词表
          </h2>
          <p>UTF-8 CSV，表头必须为 word、meaning、exampleSentence、partOfSpeech。</p>
        </div>
      </header>

      <form
        data-import-form
        class="import-form"
        @submit.prevent="submitImport"
      >
        <fieldset class="mode-switch">
          <legend>版本方式</legend>
          <label>
            <input
              type="radio"
              name="import-mode"
              value="new_source"
              :checked="mode === 'new_source'"
              :disabled="importing || unknownResultMode !== null"
              @change="setMode('new_source')"
            >
            新词库
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              value="next_version"
              :checked="mode === 'next_version'"
              :disabled="sources.length === 0 || importing || unknownResultMode !== null"
              @change="setMode('next_version')"
            >
            同词库下一版本
          </label>
        </fieldset>

        <ui-input
          v-if="mode === 'new_source'"
          v-model="sourceName"
          name="source-name"
          maxlength="120"
          label="词库名称"
          hint="名称用于区分课程内容，不作为版本号。"
          :disabled="importing || unknownResultMode !== null"
        />

        <label
          v-else
          class="native-field"
        >
          <span>选择词库</span>
          <select
            v-model="sourceId"
            name="source-id"
            :disabled="importing || unknownResultMode !== null"
          >
            <option
              v-for="source in sources"
              :key="source.id"
              :value="source.id"
            >
              {{ source.name }}
            </option>
          </select>
        </label>

        <label class="file-field">
          <span>CSV 文件</span>
          <input
            type="file"
            name="source-file"
            accept=".csv,text/csv"
            :disabled="importing || unknownResultMode !== null"
            @change="handleFile"
          >
        </label>

        <p
          v-if="previewing"
          role="status"
          class="inline-state"
        >
          正在校验 CSV…
        </p>

        <section
          v-else-if="preview?.ok"
          data-csv-preview
          class="csv-preview"
          aria-labelledby="preview-title"
        >
          <h3 id="preview-title">
            预览通过 · {{ preview.words.length }} 个词
          </h3>
          <p>提交后以服务端返回的词数和分组数为准。</p>
          <ol>
            <li
              v-for="word in preview.words.slice(0, 5)"
              :key="word.word"
            >
              <span lang="en">{{ word.word }}</span>
              <span>{{ word.meaning }}</span>
            </li>
          </ol>
        </section>

        <ui-status-message
          v-else-if="preview && !preview.ok"
          tone="error"
          title="CSV 预览未通过"
        >
          <ul class="issue-list">
            <li
              v-for="(issue, index) in preview.issues"
              :key="`${issue.code}-${String(issue.row ?? 0)}-${String(index)}`"
            >
              <span v-if="issue.row">第 {{ issue.row }} 行：</span>{{ issue.message }}
            </li>
          </ul>
        </ui-status-message>

        <ui-status-message
          v-if="importError"
          tone="error"
          title="词表导入未完成"
        >
          {{ importError }}
        </ui-status-message>

        <ui-status-message
          v-if="unknownResultMode"
          data-unknown-result
          tone="error"
          title="词表导入结果未知"
        >
          <template v-if="unknownResultMode === 'new_source'">
            <p>结果未知：草稿可能已经创建。请安全重试同一次导入，不要新建另一项操作。</p>
            <ui-button
              data-retry-unknown
              variant="secondary"
              :loading="importing"
              @click="retryUnknownImport"
            >
              安全重试同一次导入
            </ui-button>
          </template>
          <template v-else>
            <p>结果未知：下一版本可能已经创建。请重新读取服务端状态后再决定，不要直接重复提交。</p>
            <ui-button
              data-reload-authority
              variant="secondary"
              :loading="listState === 'loading'"
              @click="reloadUnknownImport"
            >
              重新读取服务端状态
            </ui-button>
          </template>
        </ui-status-message>

        <ui-status-message
          v-if="importSuccess"
          tone="success"
          title="词表导入完成"
        >
          {{ importSuccess }}
        </ui-status-message>

        <div class="form-actions">
          <ui-button
            type="submit"
            :disabled="!canImport"
            :loading="importing"
            loading-label="正在导入"
          >
            创建草稿版本
          </ui-button>
        </div>
      </form>
    </section>

    <section
      class="versions"
      aria-labelledby="versions-title"
    >
      <header class="section-heading">
        <div>
          <h2 id="versions-title">
            已有版本
          </h2>
          <p>版本状态和统计均来自服务端。</p>
        </div>
        <span v-if="listState === 'ready'">{{ versions.length }} 个版本</span>
      </header>

      <ui-status-message
        v-if="listState === 'loading'"
        tone="info"
        title="正在读取词库版本"
      >
        等待服务端返回可查看的版本。
      </ui-status-message>

      <div
        v-else-if="listState === 'error'"
        class="error-actions"
      >
        <ui-status-message
          tone="error"
          title="无法读取词库版本"
        >
          当前没有显示旧缓存，请重新请求服务端状态。
        </ui-status-message>
        <ui-button
          data-retry-list
          variant="secondary"
          @click="loadVersions"
        >
          重新读取
        </ui-button>
      </div>

      <div
        v-else-if="versions.length === 0"
        class="empty-state"
      >
        <h3>还没有词库版本</h3>
        <p>在上方导入第一份通过预览的 CSV。</p>
      </div>

      <div
        v-else
        class="table-scroll"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">
                词库
              </th>
              <th scope="col">
                版本
              </th>
              <th scope="col">
                状态
              </th>
              <th
                scope="col"
                class="numeric"
              >
                词数
              </th>
              <th
                scope="col"
                class="numeric"
              >
                分组
              </th>
              <th
                scope="col"
                class="numeric"
              >
                已批准 / 全部
              </th>
              <th scope="col">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="version in versions"
              :key="version.versionId"
            >
              <th scope="row">
                {{ version.sourceName }}
              </th>
              <td>v{{ version.versionNo }}</td>
              <td>
                <span
                  class="status-badge"
                  :data-status="version.status"
                >{{ statusLabel(version.status) }}</span>
              </td>
              <td class="numeric">
                {{ version.wordCount }}
              </td>
              <td class="numeric">
                {{ version.groupCount }}
              </td>
              <td class="numeric">
                {{ version.approvedItemCount }} / {{ version.exerciseItemCount }}
              </td>
              <td>
                <router-link
                  class="row-link"
                  :to="`/admin/source-versions/${encodeURIComponent(version.versionId)}`"
                >
                  查看详情
                </router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.admin-page,
.import-workspace,
.versions,
.import-form,
.error-actions {
  display: grid;
}

.admin-page {
  gap: var(--space-8);
}

.page-heading,
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.page-heading p,
.page-heading h1,
.page-heading span,
.section-heading h2,
.section-heading p,
.section-heading > span,
.empty-state h3,
.empty-state p,
.csv-preview h3,
.csv-preview p {
  margin: 0;
}

.page-heading p {
  color: var(--color-brand-strong);
  font-size: 12px;
  font-weight: 700;
}

.page-heading h1 {
  margin-block: var(--space-1);
  font-size: 26px;
}

.page-heading span,
.section-heading p,
.section-heading > span,
.empty-state p,
.csv-preview p {
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.55;
}

.import-workspace,
.versions {
  gap: var(--space-4);
  border-top: 1px solid var(--color-line-strong);
}

.section-heading {
  padding-top: var(--space-4);
}

.section-heading h2 {
  font-size: 18px;
}

.import-form {
  max-width: 780px;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.mode-switch {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-6);
  padding: 0;
  border: 0;
}

.mode-switch legend,
.native-field > span,
.file-field > span {
  width: 100%;
  margin-bottom: var(--space-2);
  font-size: 13px;
  font-weight: 700;
}

.mode-switch label {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: var(--space-2);
  font-size: 14px;
}

.native-field,
.file-field {
  display: grid;
  font-size: 13px;
  font-weight: 700;
}

.native-field select,
.file-field input {
  min-height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font-size: 14px;
}

.file-field input {
  padding-block: 8px;
}

.csv-preview {
  padding: var(--space-4);
  border-left: 3px solid var(--color-brand);
  background: var(--color-brand-soft);
}

.csv-preview h3 {
  font-size: 15px;
}

.csv-preview ol,
.issue-list {
  padding-left: var(--space-6);
  margin-block: var(--space-3) 0;
}

.csv-preview li {
  display: grid;
  grid-template-columns: minmax(100px, 0.35fr) minmax(0, 1fr);
  gap: var(--space-4);
  padding-block: var(--space-1);
  font-size: 13px;
}

.issue-list {
  display: grid;
  gap: var(--space-1);
}

.inline-state {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.error-actions {
  justify-items: start;
  gap: var(--space-3);
}

.empty-state {
  padding: var(--space-8);
  border: 1px dashed var(--color-line-strong);
  background: var(--color-surface);
  text-align: center;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  height: 44px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--color-line);
  text-align: left;
}

thead th {
  background: var(--color-canvas);
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
}

tbody tr:last-child > * {
  border-bottom: 0;
}

.numeric {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.status-badge {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  padding-inline: var(--space-2);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 700;
}

.status-badge[data-status='published'] {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.status-badge[data-status='archived'] {
  color: var(--color-muted);
  text-decoration: line-through;
}

.row-link {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  color: var(--color-brand-strong);
  font-weight: 700;
}

@media (max-width: 767px) {
  .import-form {
    padding: var(--space-4);
  }

  .page-heading,
  .section-heading {
    display: grid;
  }
}
</style>
