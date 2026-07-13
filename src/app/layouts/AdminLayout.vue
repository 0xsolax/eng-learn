<script setup lang="ts">
import { BookOpenText, UsersRound } from '@lucide/vue'
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

      <p class="admin-sidebar__meta">
        MVP · 内容与课程
      </p>
    </aside>

    <div class="admin-frame">
      <p
        class="admin-mobile-notice"
        role="note"
      >
        窄屏可查看；编辑建议使用宽度至少 768px 的桌面设备。
      </p>

      <header class="admin-topbar">
        <div>
          <span class="admin-topbar__eyebrow">管理工作台</span>
          <strong>内容构建与课程</strong>
        </div>
        <span class="admin-topbar__state">身份已验证</span>
      </header>

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
  grid-template-columns: minmax(200px, var(--admin-sidebar-width)) minmax(0, 1fr);
  min-height: 100vh;
  background: var(--color-canvas);
}

.admin-sidebar {
  position: sticky;
  top: 0;
  display: flex;
  height: 100vh;
  flex-direction: column;
  padding: var(--space-6) var(--space-4);
  border-right: 1px solid var(--color-line);
  background: var(--color-surface);
}

.admin-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-2) var(--space-6);
}

.admin-brand__mark {
  display: inline-grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 700;
}

.admin-brand div {
  display: grid;
  gap: 2px;
}

.admin-brand strong {
  font-family: var(--font-display);
  font-size: 16px;
  line-height: 1.2;
}

.admin-brand div span {
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
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
}

.admin-nav a:hover,
.admin-nav a.router-link-active {
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
}

.admin-sidebar__meta {
  margin: auto var(--space-2) 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 600;
}

.admin-frame {
  min-width: 0;
}

.admin-mobile-notice {
  display: none;
}

.admin-topbar {
  display: flex;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 92%, transparent);
}

.admin-topbar div {
  display: grid;
  gap: 2px;
}

.admin-topbar__eyebrow {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 600;
}

.admin-topbar strong {
  font-size: 14px;
}

.admin-topbar__state {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-pill);
  color: var(--color-muted);
  font-size: 12px;
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

  .admin-brand > div,
  .admin-sidebar__meta {
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

  .admin-sidebar__meta {
    display: none;
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

  .admin-main {
    padding: var(--space-4);
  }
}
</style>
