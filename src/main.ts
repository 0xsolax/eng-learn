import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { createAppRouter } from './app/router'
import './styles/tokens.css'
import './styles/base.css'
import './styles/motion.css'

const router = createAppRouter()

createApp(App).use(createPinia()).use(router).mount('#app')
