<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiInput from '@/components/ui/UiInput.vue'

const activationCount = ref(0)
const learnerValue = ref('')
const adminValue = ref('')
</script>

<template>
  <main class="fixture-main">
    <h1>基础控件浏览器夹具</h1>

    <section aria-labelledby="learner-controls">
      <h2 id="learner-controls">
        学习端控件
      </h2>
      <ui-button
        data-testid="learner-button"
        context="learner"
        @click="activationCount += 1"
      >
        开始学习
      </ui-button>
      <ui-input
        id="fixture-learner-input"
        v-model="learnerValue"
        data-testid="learner-input"
        context="learner"
        label="学习码"
      />
    </section>

    <p role="status">
      学习按钮已激活 {{ activationCount }} 次
    </p>

    <section aria-labelledby="admin-controls">
      <h2 id="admin-controls">
        管理端控件
      </h2>
      <ui-button
        data-testid="admin-button"
        context="admin"
      >
        保存草稿
      </ui-button>
      <ui-input
        id="fixture-admin-input"
        v-model="adminValue"
        data-testid="admin-input"
        context="admin"
        label="词库名称"
      />
    </section>
  </main>
</template>

<style scoped>
.fixture-main {
  display: grid;
  width: min(100%, 720px);
  gap: var(--space-6);
  margin-inline: auto;
  padding: var(--space-8) max(20px, env(safe-area-inset-right)) var(--space-8)
    max(20px, env(safe-area-inset-left));
}

.fixture-main h1,
.fixture-main h2,
.fixture-main p {
  margin: 0;
}

.fixture-main section {
  display: grid;
  gap: var(--space-4);
  padding-block: var(--space-4);
  border-block: 1px solid var(--color-line);
}
</style>
