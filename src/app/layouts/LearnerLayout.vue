<template>
  <div
    class="learner-shell"
    data-layout="learner"
  >
    <a
      class="skip-link"
      href="#learner-main"
    >跳到主要内容</a>

    <header class="learner-header">
      <div class="learner-brand">
        <span
          class="learner-brand__mark"
          aria-hidden="true"
        >Aa</span>
        <div>
          <strong lang="en">eng learn</strong>
          <span>课时学习</span>
        </div>
      </div>
    </header>

    <main
      id="learner-main"
      class="learner-main"
      tabindex="-1"
    >
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.learner-shell {
  min-height: 100svh;
  background: var(--color-canvas);
}

.learner-header {
  display: flex;
  min-height: 72px;
  align-items: center;
  padding-top: max(var(--space-3), env(safe-area-inset-top));
  padding-right: max(var(--space-4), env(safe-area-inset-right));
  padding-bottom: var(--space-3);
  padding-left: max(var(--space-4), env(safe-area-inset-left));
  border-bottom: 1px solid var(--color-line);
}

.learner-brand {
  display: flex;
  width: min(100%, var(--learner-content-width));
  align-items: center;
  gap: var(--space-3);
  margin-inline: auto;
}

.learner-brand__mark {
  display: inline-grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-brand-strong-hover);
  box-shadow: var(--shadow-learner-button);
  color: var(--color-surface);
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
}

.learner-brand div {
  display: grid;
  gap: 1px;
}

.learner-brand strong {
  font-family: var(--font-display);
  font-size: 17px;
  line-height: 1.2;
}

.learner-brand div span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 650;
}

.learner-main {
  width: min(100%, var(--learner-content-width));
  margin-inline: auto;
  padding-top: var(--space-12);
  padding-right: max(var(--space-6), env(safe-area-inset-right));
  padding-bottom: max(var(--space-12), env(safe-area-inset-bottom));
  padding-left: max(var(--space-6), env(safe-area-inset-left));
}

@media (max-width: 479px) {
  .learner-header {
    padding-right: max(20px, env(safe-area-inset-right));
    padding-left: max(20px, env(safe-area-inset-left));
  }

  .learner-main {
    padding-top: var(--space-8);
    padding-right: max(20px, env(safe-area-inset-right));
    padding-bottom: max(var(--space-8), env(safe-area-inset-bottom));
    padding-left: max(20px, env(safe-area-inset-left));
  }
}
</style>
