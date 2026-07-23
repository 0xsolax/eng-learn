<script setup lang="ts">
import { useRouter } from 'vue-router'
import { createLearnerApi } from '@/api/learnerApi'
import LearnerAccessEntry from '@/features/learner-course/LearnerAccessEntry.vue'
import { useLearnerApi } from '@/features/learner-course/learnerApiPort'

const router = useRouter()
const api = useLearnerApi(createLearnerApi)

const enterCourse = (): void => {
  void router.replace({ name: 'learner-course' })
}
</script>

<template>
  <section class="learner-home page-enter">
    <div
      class="learner-home__word-block"
      aria-hidden="true"
    >
      Aa
    </div>
    <p class="learner-home__eyebrow">
      课时学习
    </p>
    <h1>进入你的课程</h1>
    <p class="learner-home__intro">
      输入老师设置的学习账号和 PIN，或恢复这台设备上已有的学习会话。
    </p>

    <LearnerAccessEntry
      class="learner-home__entry"
      :api="api"
      @authenticated="enterCourse"
    />
  </section>
</template>

<style scoped>
.learner-home {
  display: grid;
  width: min(100%, 520px);
  justify-items: start;
  gap: var(--space-3);
  margin-inline: auto;
}

.learner-home__word-block {
  display: grid;
  width: 72px;
  height: 72px;
  place-items: center;
  margin-bottom: var(--space-2);
  border: 2px solid var(--color-brand);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: 0 4px 0 var(--color-brand-strong);
  color: var(--color-brand-strong);
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
}

.learner-home__eyebrow,
.learner-home h1,
.learner-home__intro {
  margin: 0;
}

.learner-home__eyebrow {
  color: var(--color-brand-strong-hover);
  font-size: 14px;
  font-weight: 700;
}

.learner-home h1 {
  font-size: clamp(26px, 5vw, 32px);
  line-height: 1.2;
}

.learner-home__intro {
  max-width: 32rem;
  color: var(--color-muted);
  font-size: 16px;
  font-weight: 500;
  line-height: 1.7;
}

.learner-home__entry {
  width: 100%;
  margin-top: var(--space-4);
}
</style>
