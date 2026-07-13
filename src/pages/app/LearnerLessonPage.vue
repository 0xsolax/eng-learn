<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createLearnerApi } from '@/api/learnerApi'
import { useLearnerApi } from '@/features/learner-course/learnerApiPort'
import LessonRunner from '@/features/lesson-runner/LessonRunner.vue'

const route = useRoute()
const router = useRouter()
const api = useLearnerApi(createLearnerApi)
const sessionId = computed(() => {
  const value = route.params.sessionId
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
})

const returnToCourse = (): void => {
  void router.push({ name: 'learner-course' })
}

const returnToCode = (): void => {
  void router.replace({ name: 'learner-home' })
}

const openReport = (): void => {
  void router.replace({
    name: 'learner-lesson-report',
    params: { sessionId: sessionId.value },
  })
}
</script>

<template>
  <LessonRunner
    :key="sessionId"
    class="page-enter"
    :api="api"
    :session-id="sessionId"
    @access-required="returnToCode"
    @exit="returnToCourse"
    @completed="openReport"
  />
</template>
