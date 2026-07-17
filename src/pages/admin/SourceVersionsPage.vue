<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SourceVersionSummaryDto } from '@shared/api/contentSchemas'
import { generateAdminOperationToken } from '@shared/security/adminOperationToken'
import { Download as DownloadIcon, Upload } from '@lucide/vue'
import { createAdminApi, type ImportSourceVersionCommand } from '@/api/adminApi'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'
import UiStatusMessage from '@/components/ui/UiStatusMessage.vue'
import {
  ADMIN_CSV_TEMPLATE_FILENAME,
  ADMIN_CSV_TEMPLATE_URL,
  parseAdminCsv,
  type CsvImportResult,
} from '@/features/admin-content/csvImport'
import { useSourceVersionImport } from '@/features/admin-content/useSourceVersionImport'

type SourceVersionsApi = Pick<
  ReturnType<typeof createAdminApi>,
  'importSourceVersion' | 'listSourceVersions'
>
type ImportMode = 'new_source' | 'next_version'
type ListState = 'loading' | 'ready' | 'error'
type ImportCommand = ImportSourceVersionCommand

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
const importExpanded = ref(
  props.initialMode === 'next_version' || props.initialSourceId.length > 0,
)
const compactMediaQuery = window.matchMedia('(max-width: 479px)')
const isCompactReadOnly = ref(compactMediaQuery.matches)
let importVisibilityInitialized = false
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

const loadVersions = async (): Promise<void> => {
  listState.value = 'loading'

  try {
    versions.value = await api.listSourceVersions()
    listState.value = 'ready'

    if (!importVisibilityInitialized) {
      importExpanded.value =
        importExpanded.value || versions.value.length === 0
      importVisibilityInitialized = true
    }

    if (mode.value === 'next_version' && !sourceId.value) {
      sourceId.value = sources.value[0]?.id ?? ''
    }
  } catch {
    listState.value = 'error'
  }
}

const {
  importError,
  importState,
  importSuccess,
  isImportBusy,
  resetImportResult,
  submitImportCommand,
} = useSourceVersionImport({
  importSourceVersion: (command) => api.importSourceVersion(command),
  onImported: loadVersions,
  onInvalidRestore: () => {
    importExpanded.value = true
  },
  onRestore: (command) => {
    importExpanded.value = true
    mode.value = command.mode
    preview.value = { ok: true, words: command.words }

    if (command.mode === 'new_source') {
      sourceName.value = command.sourceName
    } else {
      sourceId.value = command.sourceId
    }
  },
})

const canImport = computed(
  () =>
    preview.value?.ok === true &&
    !isImportBusy.value &&
    !isCompactReadOnly.value &&
    (mode.value === 'new_source' ? sourceName.value.trim().length > 0 : sourceId.value.length > 0),
)

const handleFile = async (event: Event): Promise<void> => {
  const sequence = ++fileSelectionSequence
  const file = (event.target as HTMLInputElement).files?.[0]
  resetImportResult()
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
          operationToken: generateAdminOperationToken(),
          sourceId: sourceId.value,
          words: preview.value.words,
        }

  await submitImportCommand(command)
}

const setMode = (nextMode: ImportMode): void => {
  if (isImportBusy.value) return
  mode.value = nextMode
  resetImportResult()

  if (nextMode === 'next_version' && !sourceId.value) {
    sourceId.value = sources.value[0]?.id ?? ''
  }
}

const toggleImport = (): void => {
  if (
    isCompactReadOnly.value ||
    isImportBusy.value
  ) {
    return
  }
  importExpanded.value = !importExpanded.value
}

const syncCompactReadOnly = (event: MediaQueryListEvent): void => {
  isCompactReadOnly.value = event.matches
}

const formatAdminTime = (value: string): string =>
  value.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*$/,
    '$1 $2',
  )

const statusLabel = (status: SourceVersionSummaryDto['status']): string =>
  ({ draft: '草稿', published: '已发布', archived: '已丢弃' })[status]

onMounted(() => {
  compactMediaQuery.addEventListener('change', syncCompactReadOnly)
  void loadVersions()
})

onBeforeUnmount(() => {
  compactMediaQuery.removeEventListener('change', syncCompactReadOnly)
})
</script>

<template>
  <section class="admin-page page-enter">
    <header class="page-heading">
      <div>
        <p>内容构建</p>
        <h1>词库版本</h1>
        <span>先预览并校验 CSV，再由服务端创建新词库或同一词库的下一版本。</span>
      </div>
      <ui-button
        v-if="listState === 'ready' && !isCompactReadOnly"
        data-toggle-import
        :aria-expanded="importExpanded"
        aria-controls="source-import-workspace"
        :disabled="isImportBusy"
        @click="toggleImport"
      >
        <upload
          :size="18"
          aria-hidden="true"
        />
        {{ importExpanded ? '收起导入' : '导入词表' }}
      </ui-button>
    </header>

    <ui-status-message
      v-if="isCompactReadOnly"
      data-compact-readonly
      tone="info"
      title="当前仅供查看"
    >
      请使用至少 480px 宽的设备导入词表或创建草稿版本。
    </ui-status-message>

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
        <p>{{ isCompactReadOnly ? '可在当前设备查看；导入请使用至少 480px 宽的设备。' : '在下方导入第一份通过预览的 CSV。' }}</p>
      </div>

      <div
        v-else
        data-version-table
        data-scroll-region="versions"
        class="table-scroll"
        tabindex="0"
        aria-label="词库版本表格"
      >
        <table>
          <thead data-sticky-header>
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
                时间
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
              <td class="numeric">
                v{{ version.versionNo }}
              </td>
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
              <td class="time-cell">
                <time :datetime="version.createdAt">创建 {{ formatAdminTime(version.createdAt) }}</time>
                <time
                  v-if="version.publishedAt"
                  :datetime="version.publishedAt"
                >发布 {{ formatAdminTime(version.publishedAt) }}</time>
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

    <section
      v-if="importExpanded && !isCompactReadOnly"
      id="source-import-workspace"
      data-import-workspace
      class="import-workspace"
      aria-labelledby="import-title"
    >
      <header class="section-heading">
        <div>
          <h2 id="import-title">
            导入词表
          </h2>
          <p>
            UTF-8 CSV，表头依次为 word、meaning、examplePhrase、exampleSentence、exampleSentenceExtended、partOfSpeech。
          </p>
          <p>请按“短语 → 基础句 → 扩展句”填写三层语境；词性可留空。</p>
        </div>
        <a
          data-download-csv-template
          class="template-download"
          :href="ADMIN_CSV_TEMPLATE_URL"
          :download="ADMIN_CSV_TEMPLATE_FILENAME"
        >
          <download-icon
            :size="16"
            aria-hidden="true"
          />
          下载 CSV 模板
        </a>
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
              :disabled="isImportBusy"
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
              :disabled="sources.length === 0 || isImportBusy"
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
          :disabled="isImportBusy"
        />

        <label
          v-else
          class="native-field"
        >
          <span>选择词库</span>
          <select
            v-model="sourceId"
            name="source-id"
            :disabled="isImportBusy"
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
            :disabled="isImportBusy"
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
          v-if="importState === 'confirming'"
          data-import-confirming
          tone="info"
          title="正在自动确认导入结果"
        >
          无需再次点击；页面会使用同一次导入命令继续确认，连接恢复后自动完成。
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
            :loading="isImportBusy"
            :loading-label="importState === 'confirming' ? '正在确认' : '正在导入'"
          >
            导入并创建草稿
          </ui-button>
        </div>
      </form>
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
  min-width: 0;
  gap: var(--space-6);
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
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
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

.template-download {
  display: inline-flex;
  min-height: 40px;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-brand-strong);
  font-size: 13px;
  font-weight: 700;
}

.template-download:hover {
  text-decoration: underline;
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
  max-height: min(560px, calc(100vh - 260px));
  overflow: auto;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

table {
  width: 100%;
  min-width: 940px;
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
  position: sticky;
  z-index: 1;
  top: 0;
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

.time-cell {
  min-width: 174px;
  padding-block: var(--space-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
}

.time-cell time {
  display: block;
  white-space: nowrap;
}

.table-scroll:focus-visible {
  outline: 3px solid var(--color-brand);
  outline-offset: 2px;
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

.status-badge[data-status='draft'] {
  border-color: color-mix(in srgb, var(--color-sun) 60%, var(--color-line));
  background: var(--color-sun-soft);
  color: #71550a;
}

.status-badge[data-status='archived'] {
  background: var(--color-canvas);
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
