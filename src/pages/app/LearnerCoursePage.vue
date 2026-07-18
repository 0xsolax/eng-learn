<script setup lang="ts">
import { useRouter } from 'vue-router'
import { createLearnerApi } from '@/api/learnerApi'
import LearnerCourseHome from '@/features/learner-course/LearnerCourseHome.vue'
import { useLearnerApi } from '@/features/learner-course/learnerApiPort'

const router = useRouter()
const api = useLearnerApi(createLearnerApi)

const openLesson = (sessionId: string): void => {
  void router.push({ name: 'learner-lesson', params: { sessionId } })
}

const openReplay = (replaySessionId: string): void => {
  void router.push({ name: 'learner-lesson-replay', params: { replaySessionId } })
}

const returnToCode = (): void => {
  void router.replace({ name: 'learner-home' })
}
</script>

<template>
  <LearnerCourseHome
    class="page-enter"
    :api="api"
    @started="openLesson"
    @replay-started="openReplay"
    @access-required="returnToCode"
  />
</template>
