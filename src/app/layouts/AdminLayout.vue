<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { BookOpenText, LogOut, UsersRound } from '@lucide/vue'
import {
  adminPageContextKey,
  type AdminPageContext,
  type AdminPageContextPort,
} from '@/features/admin-auth/adminPageContext'
import { useAdminSessionContext } from '@/features/admin-auth/adminSessionContext'

const router = useRouter()
const route = useRoute()
const sessionContext = useAdminSessionContext()
const pageContext = ref<AdminPageContext | null>(null)
const isWideSidebar = ref(window.innerWidth >= 1200)
const logoutPending = ref(false)
const logoutError = ref('')

const defaultBreadcrumbs = computed<readonly string[]>(() => {
  switch (route.name) {
    case 'admin-courses':
      return ['课程工作台', '学习者与课程']
    case 'admin-source-version-detail':
      return ['词库工作台', '版本详情']
    case 'admin-exercise-item':
      return ['词库工作台', '练习项目']
    default:
      return ['词库工作台', '词库版本']
  }
})

const breadcrumbs = computed(
  () => pageContext.value?.breadcrumbs ?? defaultBreadcrumbs.value,
)

const pageContextPort: AdminPageContextPort = {
  setPageContext(context) {
    pageContext.value = context
  },
  clearPageContext() {
    pageContext.value = null
  },
}
provide(adminPageContextKey, pageContextPort)

const confirmPageLeave = async (): Promise<boolean> => {
  try {
    return (await pageContext.value?.confirmLeave?.()) ?? true
  } catch {
    return false
  }
}

const removeRouteGuard = router.beforeEach(async (to, from) => {
  if (to.fullPath === from.fullPath) {
    return true
  }
  if (
    to.name === 'admin-login' &&
    typeof to.query.reason === 'string' &&
    ['expired', 'invalid', 'logged_out'].includes(to.query.reason)
  ) {
    return true
  }
  return confirmPageLeave()
})

const removeAfterEach = router.afterEach(() => {
  pageContextPort.clearPageContext()
})

const handleLogout = async (): Promise<void> => {
  if (logoutPending.value || !(await confirmPageLeave())) {
    return
  }

  logoutPending.value = true
  logoutError.value = ''
  try {
    await sessionContext.logout()
  } catch {
    logoutError.value = '退出失败，会话仍可能有效，请重试'
  } finally {
    logoutPending.value = false
  }
}

const updateSidebarMode = (): void => {
  isWideSidebar.value = window.innerWidth >= 1200
}

onMounted(() => {
  window.addEventListener('resize', updateSidebarMode)
})

onUnmounted(() => {
  removeRouteGuard()
  removeAfterEach()
  window.removeEventListener('resize', updateSidebarMode)
})
</script>

<template>
  <div
    class="admin-shell"
    data-layout="admin"
  >
    <a
      class="skip-link"
      href="#admin-main"
    >跳到主要内容</a>

    <aside class="admin-sidebar">
      <div class="admin-brand">
        <span
          class="admin-brand__mark"
          aria-hidden="true"
        >Aa</span>
        <div>
          <strong lang="en">eng learn</strong>
          <span>内容管理</span>
        </div>
      </div>

      <nav
        class="admin-nav"
        aria-label="管理端主导航"
      >
        <router-link
          to="/admin/source-versions"
          title="词库工作台"
        >
          <book-open-text
            :size="18"
            aria-hidden="true"
          />
          <span class="admin-nav__label">词库工作台</span>
        </router-link>
        <router-link
          to="/admin/courses"
          title="课程工作台"
        >
          <users-round
            :size="18"
            aria-hidden="true"
          />
          <span class="admin-nav__label">课程工作台</span>
        </router-link>
      </nav>

      <section
        v-if="isWideSidebar && sessionContext.session.value"
        class="admin-identity admin-identity--sidebar"
        data-admin-identity="sidebar"
      >
        <div>
          <strong>{{ sessionContext.session.value.displayName }}</strong>
          <span>内容管理员</span>
        </div>
        <button
          type="button"
          data-action="admin-logout"
          :disabled="logoutPending"
          @click="handleLogout"
        >
          <log-out
            :size="16"
            aria-hidden="true"
          />
          {{ logoutPending ? '正在退出…' : '退出' }}
        </button>
      </section>
    </aside>

    <div class="admin-frame">
      <p
        class="admin-mobile-notice"
        role="note"
      >
        窄屏可查看；编辑建议使用宽度至少 768px 的桌面设备。
      </p>

      <header class="admin-topbar">
        <nav aria-label="当前页面">
          <ol>
            <li
              v-for="(item, index) in breadcrumbs"
              :key="`${index}-${item}`"
            >
              {{ item }}
            </li>
          </ol>
        </nav>
        <section
          v-if="!isWideSidebar && sessionContext.session.value"
          class="admin-identity admin-identity--topbar"
          data-admin-identity="topbar"
        >
          <div>
            <strong>{{ sessionContext.session.value.displayName }}</strong>
            <span>内容管理员</span>
          </div>
          <button
            type="button"
            data-action="admin-logout"
            :disabled="logoutPending"
            @click="handleLogout"
          >
            <log-out
              :size="16"
              aria-hidden="true"
            />
            {{ logoutPending ? '正在退出…' : '退出' }}
          </button>
        </section>
      </header>

      <p
        v-if="logoutError"
        class="admin-logout-error"
        role="alert"
      >
        {{ logoutError }}
      </p>

      <main
        id="admin-main"
        class="admin-main"
        tabindex="-1"
      >
        <router-view :key="$route.fullPath" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-shell {
  display: grid;
  grid-template-columns: var(--admin-sidebar-width) minmax(0, 1fr);
  min-height: 100vh;
  background: var(--color-canvas);
}

.admin-sidebar {
  position: sticky;
  top: 0;
  display: flex;
  height: 100vh;
  flex-direction: column;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--color-line);
  background: var(--color-surface);
}

.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 10px 22px;
}

.admin-brand__mark {
  display: inline-grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-brand-strong-hover);
  border-radius: var(--radius-sm);
  background: var(--color-brand-strong-hover);
  color: var(--color-surface);
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
}

.admin-brand > div,
.admin-identity > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.admin-brand strong {
  font-family: var(--font-display);
  font-size: 16px;
  line-height: 1.2;
}

.admin-brand > div span,
.admin-identity span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 600;
}

.admin-nav {
  display: grid;
  gap: var(--space-1);
}

.admin-nav a {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  min-height: 40px;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}

.admin-nav a:hover,
.admin-nav a.router-link-active {
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.admin-identity {
  align-items: center;
  gap: var(--space-3);
}

.admin-identity--sidebar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  margin-top: auto;
  padding: var(--space-4) var(--space-2) 0;
  border-top: 1px solid var(--color-line);
}

.admin-identity strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-identity button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
}

.admin-identity button:hover:not(:disabled) {
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
}

.admin-frame {
  min-width: 0;
}

.admin-mobile-notice {
  display: none;
}

.admin-topbar {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 0 var(--space-6);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
}

.admin-topbar ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  margin: 0;
  list-style: none;
}

.admin-topbar nav {
  min-width: 0;
}

.admin-topbar li {
  max-width: min(360px, 42vw);
  overflow: hidden;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-topbar li:not(:last-child)::after {
  margin-left: var(--space-2);
  color: var(--color-line-strong);
  content: '/';
}

.admin-topbar li:last-child {
  color: var(--color-ink);
  font-weight: 700;
}

.admin-identity--topbar {
  display: flex;
}

.admin-logout-error {
  margin: var(--space-4) var(--space-6) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid color-mix(in srgb, var(--color-coral) 45%, var(--color-line));
  border-radius: var(--radius-sm);
  background: var(--color-coral-soft);
  color: var(--color-coral-strong);
  font-size: 13px;
  font-weight: 650;
}

.admin-main {
  width: min(100%, var(--admin-content-width));
  padding: var(--space-6);
}

@media (min-width: 768px) and (max-width: 1199px) {
  .admin-shell {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .admin-sidebar {
    padding-inline: var(--space-3);
  }

  .admin-brand {
    justify-content: center;
    padding-inline: 0;
  }

  .admin-brand > div {
    display: none;
  }

  .admin-nav a {
    grid-template-columns: 1fr;
    justify-items: center;
    padding-inline: 0;
  }

  .admin-nav__label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}

@media (max-width: 767px) {
  .admin-shell {
    display: block;
  }

  .admin-sidebar {
    position: static;
    height: auto;
    padding: var(--space-4) var(--space-4) var(--space-3);
    border-right: 0;
    border-bottom: 1px solid var(--color-line);
  }

  .admin-brand {
    padding-bottom: var(--space-3);
  }

  .admin-nav {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .admin-nav a {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .admin-mobile-notice {
    display: block;
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-line);
    background: var(--color-sun-soft);
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 650;
    line-height: 1.5;
  }

  .admin-topbar {
    min-height: 60px;
    padding-inline: var(--space-4);
  }

  .admin-identity--topbar > div {
    max-width: 96px;
  }

  .admin-identity--topbar span {
    display: none;
  }

  .admin-main {
    padding: var(--space-4);
  }

  .admin-logout-error {
    margin-inline: var(--space-4);
  }
}
</style>
