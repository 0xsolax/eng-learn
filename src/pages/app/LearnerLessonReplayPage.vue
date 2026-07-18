<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createLearnerApi } from '@/api/learnerApi'
import { useLearnerApi } from '@/features/learner-course/learnerApiPort'
import LessonReplayRunner from '@/features/lesson-runner/LessonReplayRunner.vue'

const route = useRoute()
const router = useRouter()
const api = useLearnerApi(createLearnerApi)
const replaySessionId = computed(() => {
  const value = route.params.replaySessionId
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
})

const returnToCourse = (): void => {
  void router.replace({ name: 'learner-course' })
}

const returnToCode = (): void => {
  void router.replace({ name: 'learner-home' })
}
</script>

<template>
  <LessonReplayRunner
    :key="replaySessionId"
    class="page-enter"
    :api="api"
    :replay-session-id="replaySessionId"
    @access-required="returnToCode"
    @completed="returnToCourse"
    @exit="returnToCourse"
  />
</template>
