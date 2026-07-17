<script setup lang="ts">
import { useRouter } from 'vue-router'
import type { ExerciseReviewApi } from '@/api/adminApi'
import ExerciseReviewRunner from '@/features/admin-content/ExerciseReviewRunner.vue'
import { createAdminApi } from '@/api/adminApi'

const props = defineProps<{
  api?: ExerciseReviewApi
  versionId: string
  itemId?: string
}>()

const router = useRouter()
const api = props.api ?? createAdminApi()

const updateRouteItem = (itemId?: string): void => {
  void router.replace({
    name: 'admin-exercise-review',
    params: {
      versionId: props.versionId,
      ...(itemId ? { itemId } : {}),
    },
  })
}
</script>

<template>
  <exercise-review-runner
    :api="api"
    :version-id="versionId"
    v-bind="itemId ? { itemId } : {}"
    @item-change="updateRouteItem"
  />
</template>
