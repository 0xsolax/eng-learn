<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AdminExerciseItemDto } from '@shared/api/contentSchemas'
import {
  exerciseItemContentSchema,
  type ExerciseItemContent,
} from '@shared/api/taskSchemas'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'

type EditorFields = {
  promptWord: string
  meaning: string
  exampleSentence: string
  answerWord: string
  options: string
  sentence: string
  pieces: string
  pieceIds: string
  instruction: string
  referenceSentence: string
}

const props = withDefaults(
  defineProps<{
    item: AdminExerciseItemDto
    readonly?: boolean
    saving?: boolean
  }>(),
  {
    readonly: false,
    saving: false,
  },
)

const emit = defineEmits<{
  save: [content: ExerciseItemContent]
}>()

const fields = reactive<EditorFields>(emptyFields())
const formError = ref('')

watch(
  () => props.item,
  (item) => {
    Object.assign(fields, emptyFields())

    switch (item.taskType) {
      case 'recognize_meaning':
        fields.promptWord = item.prompt.word
        fields.meaning = item.prompt.meaning
        fields.exampleSentence = item.prompt.exampleSentence
        fields.answerWord = item.answer.word
        break
      case 'recall_word':
        fields.meaning = item.prompt.meaning
        fields.answerWord = item.answer.word
        break
      case 'multiple_choice':
        fields.meaning = item.prompt.meaning
        fields.options = item.prompt.options.join('\n')
        fields.answerWord = item.answer.word
        break
      case 'fill_blank':
        fields.sentence = item.prompt.sentence
        fields.answerWord = item.answer.word
        break
      case 'sentence_build':
        fields.pieces = item.prompt.pieces.map((piece) => `${piece.id}|${piece.text}`).join('\n')
        fields.pieceIds = item.answer.pieceIds.join('\n')
        fields.referenceSentence = item.answer.referenceSentence
        break
      case 'sentence_output':
        fields.meaning = item.prompt.meaning
        fields.instruction = item.prompt.instruction
        fields.referenceSentence = item.answer.referenceSentence
        break
    }

    formError.value = ''
  },
  { immediate: true },
)

const submit = (): void => {
  formError.value = ''
  const result = exerciseItemContentSchema.safeParse(toCandidate(props.item, fields))

  if (!result.success) {
    formError.value = toFormError(result.error.issues[0]?.message)
    return
  }

  emit('save', result.data)
}

const toCandidate = (item: AdminExerciseItemDto, values: EditorFields): unknown => {
  switch (item.taskType) {
    case 'recognize_meaning':
      return {
        stage: 'S0',
        taskType: 'recognize_meaning',
        prompt: {
          word: values.promptWord,
          meaning: values.meaning,
          exampleSentence: values.exampleSentence,
        },
        answer: { word: values.answerWord, expectedResponse: 'known' },
      }
    case 'recall_word':
      return {
        stage: 'S1',
        taskType: 'recall_word',
        prompt: { meaning: values.meaning },
        answer: { word: values.answerWord },
      }
    case 'multiple_choice':
      return {
        stage: 'S2',
        taskType: 'multiple_choice',
        prompt: { meaning: values.meaning, options: toLines(values.options) },
        answer: { word: values.answerWord },
      }
    case 'fill_blank':
      return {
        stage: 'S3',
        taskType: 'fill_blank',
        prompt: { sentence: values.sentence },
        answer: { word: values.answerWord },
      }
    case 'sentence_build':
      return {
        stage: 'S4',
        taskType: 'sentence_build',
        prompt: { pieces: toPieces(values.pieces) },
        answer: {
          pieceIds: toLines(values.pieceIds),
          referenceSentence: values.referenceSentence,
        },
      }
    case 'sentence_output':
      return {
        stage: 'S5',
        taskType: 'sentence_output',
        prompt: { meaning: values.meaning, instruction: values.instruction },
        answer: { referenceSentence: values.referenceSentence },
      }
  }
}

const toLines = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const toPieces = (value: string): Array<{ id: string; text: string }> =>
  toLines(value).map((line) => {
    const separator = line.indexOf('|')
    return separator < 0
      ? { id: '', text: line }
      : {
          id: line.slice(0, separator).trim(),
          text: line.slice(separator + 1).trim(),
        }
  })

const toFormError = (message: string | undefined): string => {
  if (message === 'Multiple-choice answer must be one of the options') {
    return '答案必须是选项之一。'
  }
  if (message === 'Fill-blank sentence must contain a blank marker') {
    return '填空句必须包含 ____ 占位符。'
  }
  if (message?.startsWith('Sentence-build answer')) {
    return '答案顺序必须且只能使用全部词块编号。'
  }
  if (message === 'Sentence-build prompt must visibly differ from the answer order') {
    return '题面词块顺序必须与正确答案顺序不同。'
  }

  return '请补齐当前题型要求的结构化字段。'
}

function emptyFields(): EditorFields {
  return {
    promptWord: '',
    meaning: '',
    exampleSentence: '',
    answerWord: '',
    options: '',
    sentence: '',
    pieces: '',
    pieceIds: '',
    instruction: '',
    referenceSentence: '',
  }
}
</script>

<template>
  <form
    class="exercise-form"
    @submit.prevent="submit"
  >
    <div class="identity-grid">
      <div>
        <span>阶段</span>
        <strong>{{ item.stage }}</strong>
      </div>
      <div>
        <span>题型</span>
        <strong>{{ item.taskType }}</strong>
      </div>
    </div>

    <template v-if="item.taskType === 'recognize_meaning'">
      <ui-input
        v-model="fields.promptWord"
        name="prompt-word"
        label="题面单词"
        :disabled="readonly || saving"
      />
      <ui-input
        v-model="fields.meaning"
        name="meaning"
        label="中文词义"
        :disabled="readonly || saving"
      />
      <label class="native-field">
        <span>例句</span>
        <textarea
          v-model="fields.exampleSentence"
          name="example-sentence"
          rows="3"
          :disabled="readonly || saving"
        />
      </label>
      <ui-input
        v-model="fields.answerWord"
        name="answer-word"
        label="标准单词"
        :disabled="readonly || saving"
      />
      <p class="fixed-contract">
        S0 的标准响应固定为“认识”，不在表单中改写。
      </p>
    </template>

    <template v-else-if="item.taskType === 'recall_word'">
      <ui-input
        v-model="fields.meaning"
        name="meaning"
        label="中文词义"
        :disabled="readonly || saving"
      />
      <ui-input
        v-model="fields.answerWord"
        name="answer-word"
        label="标准单词"
        :disabled="readonly || saving"
      />
    </template>

    <template v-else-if="item.taskType === 'multiple_choice'">
      <ui-input
        v-model="fields.meaning"
        name="meaning"
        label="中文词义"
        :disabled="readonly || saving"
      />
      <label class="native-field">
        <span>选项（每行一个）</span>
        <textarea
          v-model="fields.options"
          name="options"
          rows="5"
          :disabled="readonly || saving"
        />
      </label>
      <ui-input
        v-model="fields.answerWord"
        name="answer-word"
        label="正确选项"
        :disabled="readonly || saving"
      />
    </template>

    <template v-else-if="item.taskType === 'fill_blank'">
      <label class="native-field">
        <span>填空句</span>
        <textarea
          v-model="fields.sentence"
          name="sentence"
          rows="3"
          :disabled="readonly || saving"
        />
        <small>用 ____ 标记需要填写单词的位置。</small>
      </label>
      <ui-input
        v-model="fields.answerWord"
        name="answer-word"
        label="标准答案"
        :disabled="readonly || saving"
      />
    </template>

    <template v-else-if="item.taskType === 'sentence_build'">
      <label class="native-field">
        <span>题面词块（每行：编号|文字）</span>
        <textarea
          v-model="fields.pieces"
          name="pieces"
          rows="6"
          :disabled="readonly || saving"
        />
      </label>
      <label class="native-field">
        <span>正确编号顺序（每行一个）</span>
        <textarea
          v-model="fields.pieceIds"
          name="piece-ids"
          rows="6"
          :disabled="readonly || saving"
        />
      </label>
      <label class="native-field">
        <span>参考句</span>
        <textarea
          v-model="fields.referenceSentence"
          name="reference-sentence"
          rows="3"
          :disabled="readonly || saving"
        />
      </label>
    </template>

    <template v-else>
      <ui-input
        v-model="fields.meaning"
        name="meaning"
        label="中文词义"
        :disabled="readonly || saving"
      />
      <label class="native-field">
        <span>作答指令</span>
        <textarea
          v-model="fields.instruction"
          name="instruction"
          rows="3"
          :disabled="readonly || saving"
        />
      </label>
      <label class="native-field">
        <span>参考句</span>
        <textarea
          v-model="fields.referenceSentence"
          name="reference-sentence"
          rows="3"
          :disabled="readonly || saving"
        />
      </label>
    </template>

    <p
      v-if="formError"
      class="form-error"
      role="alert"
    >
      {{ formError }}
    </p>

    <ui-button
      v-if="!readonly"
      type="submit"
      :loading="saving"
      loading-label="正在保存"
    >
      保存练习内容
    </ui-button>
  </form>
</template>

<style scoped>
.exercise-form {
  display: grid;
  max-width: 760px;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
}

.identity-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-line);
}

.identity-grid > div {
  display: grid;
  gap: 2px;
}

.identity-grid span,
.native-field > span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
}

.identity-grid strong {
  font-size: 14px;
}

.native-field {
  display: grid;
  gap: var(--space-2);
}

.native-field textarea {
  width: 100%;
  min-height: 88px;
  padding: var(--space-3);
  resize: vertical;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.55;
}

.native-field textarea:disabled {
  background: var(--color-canvas);
  color: var(--color-muted);
  cursor: not-allowed;
}

.native-field small,
.fixed-contract {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.form-error {
  margin: 0;
  padding: var(--space-3);
  border-left: 3px solid var(--color-coral-strong);
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
  font-size: 13px;
  font-weight: 650;
}

.exercise-form > .ui-button {
  justify-self: start;
}

@media (max-width: 767px) {
  .exercise-form {
    padding: var(--space-4);
  }
}
</style>
