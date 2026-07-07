import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import AdminHomePage from './pages/admin/AdminHomePage.vue'
import LearnerHomePage from './pages/app/LearnerHomePage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/app' },
    { path: '/admin', component: AdminHomePage },
    { path: '/app', component: LearnerHomePage },
  ],
})

createApp(App).use(createPinia()).use(router).mount('#app')

