<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createLearnerApi } from '@/api/learnerApi'
import { useLearnerApi } from '@/features/learner-course/learnerApiPort'
import LessonReport from '@/features/lesson-runner/LessonReport.vue'

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

const returnToLesson = (): void => {
  void router.push({
    name: 'learner-lesson',
    params: { sessionId: sessionId.value },
  })
}
</script>

<template>
  <LessonReport
    :key="sessionId"
    :api="api"
    :session-id="sessionId"
    @access-required="returnToCode"
    @return-course="returnToCourse"
    @return-lesson="returnToLesson"
  />
</template>
