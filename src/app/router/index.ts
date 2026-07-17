import {
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
} from 'vue-router'

export const createAppRouter = (history: RouterHistory = createWebHistory()): Router =>
  createRouter({
    history,
    routes: [
      {
        path: '/',
        redirect: '/app',
      },
      {
        path: '/admin/login',
        name: 'admin-login',
        component: () => import('../../pages/admin/AdminLoginPage.vue'),
        meta: { requiresAdmin: false },
      },
      {
        path: '/admin',
        name: 'admin-gate',
        component: () => import('../AdminGate.vue'),
        meta: { requiresAdmin: true },
        children: [
          {
            path: '',
            name: 'admin',
            component: () => import('../layouts/AdminLayout.vue'),
            meta: { requiresAdmin: true },
            children: [
              {
                path: '',
                name: 'admin-home',
                redirect: { name: 'admin-source-versions' },
                meta: { requiresAdmin: true },
              },
              {
                path: 'source-versions',
                name: 'admin-source-versions',
                component: () => import('../../pages/admin/SourceVersionsPage.vue'),
                meta: { requiresAdmin: true },
                props: (route) => ({
                  initialMode:
                    route.query.mode === 'next_version'
                      ? 'next_version'
                      : 'new_source',
                  initialSourceId:
                    typeof route.query.sourceId === 'string'
                      ? route.query.sourceId
                      : '',
                }),
              },
              {
                path: 'source-versions/:versionId',
                name: 'admin-source-version-detail',
                component: () => import('../../pages/admin/SourceVersionDetailPage.vue'),
                props: true,
                meta: { requiresAdmin: true },
              },
              {
                path: 'source-versions/:versionId/review/:itemId?',
                name: 'admin-exercise-review',
                component: () => import('../../pages/admin/ExerciseReviewPage.vue'),
                props: true,
                meta: { requiresAdmin: true },
              },
              {
                path: 'source-versions/:versionId/exercises/:itemId',
                name: 'admin-exercise-item',
                component: () => import('../../pages/admin/ExerciseItemPage.vue'),
                props: true,
                meta: { requiresAdmin: true },
              },
              {
                path: 'courses',
                name: 'admin-courses',
                component: () => import('../../pages/admin/CoursesPage.vue'),
                meta: { requiresAdmin: true },
              },
            ],
          },
        ],
      },
      {
        path: '/app',
        name: 'learner',
        component: () => import('../layouts/LearnerLayout.vue'),
        children: [
          {
            path: '',
            name: 'learner-home',
            component: () => import('../../pages/app/LearnerHomePage.vue'),
          },
          {
            path: 'course',
            name: 'learner-course',
            component: () => import('../../pages/app/LearnerCoursePage.vue'),
          },
          {
            path: 'lesson/:sessionId',
            name: 'learner-lesson',
            component: () => import('../../pages/app/LearnerLessonPage.vue'),
          },
          {
            path: 'lesson/:sessionId/report',
            name: 'learner-lesson-report',
            component: () => import('../../pages/app/LearnerLessonReportPage.vue'),
          },
        ],
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: () => import('../../pages/NotFoundPage.vue'),
      },
    ],
    scrollBehavior: () => ({ top: 0 }),
  })
