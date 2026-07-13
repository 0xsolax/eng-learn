<template>
  <main class="not-found page-enter">
    <span
      class="not-found__mark"
      aria-hidden="true"
    >Aa</span>
    <p>404</p>
    <h1>页面不存在</h1>
    <span>这个地址没有对应的学习或管理页面。</span>
    <router-link to="/app">
      返回学习入口
    </router-link>
  </main>
</template>

<style scoped>
.not-found {
  display: grid;
  width: min(100% - 40px, 520px);
  min-height: 100svh;
  place-content: center;
  justify-items: start;
  gap: var(--space-3);
  margin-inline: auto;
}

.not-found__mark {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
}

.not-found p,
.not-found h1,
.not-found > span:not(.not-found__mark) {
  margin: 0;
}

.not-found p {
  color: var(--color-brand-strong);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
}

.not-found h1 {
  font-size: 28px;
  line-height: 1.25;
}

.not-found > span:not(.not-found__mark) {
  color: var(--color-muted);
  font-size: 16px;
  line-height: 1.7;
}

.not-found a {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  margin-top: var(--space-3);
  padding: 0 var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-brand-strong);
  color: var(--color-surface);
  font-weight: 700;
  text-decoration: none;
  transition: transform var(--motion-fast) var(--ease-standard);
}

.not-found a:hover {
  background: var(--color-brand-strong-hover);
}

.not-found a:active {
  transform: scale(0.96);
}
</style>
