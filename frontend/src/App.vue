<template>
  <div id="app">
    <header v-if="!isLoginPage" class="app-header">
      <router-link to="/" class="brand" aria-label="思库合同审核首页">
        <span class="brand-wordmark">THINK <em>OPEN</em></span>
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="brand-copy">
          <strong>合同审核</strong>
          <small>INTERNAL REVIEW</small>
        </span>
      </router-link>
      <div class="header-actions">
        <nav class="app-nav" aria-label="主导航">
          <router-link to="/review" class="nav-link" active-class="nav-link-active">合同审核</router-link>
        </nav>
        <span class="poc-badge"><i></i>企业法务</span>
        <div v-if="authState.user" class="account-control">
          <span class="account-avatar">{{ accountInitial }}</span>
          <span class="account-copy">
            <strong>{{ authState.user.displayName }}</strong>
            <small>{{ authState.user.username }}</small>
          </span>
          <button type="button" class="logout-button" @click="handleBackToTeam">返回 AI 团队</button>
        </div>
      </div>
    </header>
    <router-view />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authState, markSessionExpired } from './auth';

const route = useRoute();
const router = useRouter();
const isLoginPage = computed(() => route.name === 'Login');
const accountInitial = computed(() => String(authState.user?.displayName || authState.user?.username || 'Z').slice(0, 1).toUpperCase());

function handleBackToTeam() {
  window.location.assign('/agents');
}

function handleExpired() {
  markSessionExpired();
  if (route.name !== 'Login') {
    router.replace({ name: 'Login', query: { redirect: route.fullPath } });
  }
}

onMounted(() => window.addEventListener('za-auth-expired', handleExpired));
onBeforeUnmount(() => window.removeEventListener('za-auth-expired', handleExpired));
</script>

<style>
:root {
  --tp-accent: #d6002e;
  --tp-accent-hover: #be0029;
  --tp-accent-active: #9c0022;
  --tp-accent-subtle: #fce7ec;
  --tp-accent-muted: #ec5b78;
  --tp-bg-app: #fafbfb;
  --tp-bg-surface: #ffffff;
  --tp-bg-muted: #f5f6f6;
  --tp-text-primary: #232524;
  --tp-text-body: #3c3e3d;
  --tp-text-muted: #5e6160;
  --tp-text-subtle: #828584;
  --tp-line: #e3e5e4;
  --tp-line-strong: #c6c9c8;
  --tp-success: #1e8e4e;
  --tp-success-bg: #e7f3ec;
  --tp-warning: #b7791f;
  --tp-warning-bg: #fbf1df;
  --tp-shadow-sm: 0 1px 2px rgba(20, 21, 20, .06);
  --tp-shadow-card: 0 2px 6px rgba(20, 21, 20, .05), 0 14px 34px rgba(20, 21, 20, .07);
  --tp-radius-control: 10px;
  --tp-radius-card: 16px;

  /* 兼容现有组件变量，全部映射到 THINK Open 语义色。 */
  --za-teal: var(--tp-accent);
  --za-teal-deep: var(--tp-accent-active);
  --za-gold: var(--tp-accent-muted);
  --za-gold-ink: var(--tp-accent-active);
  --za-gold-soft: var(--tp-accent-subtle);
  --za-ink: var(--tp-text-primary);
  --za-muted: var(--tp-text-muted);
  --za-canvas: var(--tp-bg-app);
  --za-line: var(--tp-line);
  --el-color-primary: #d6002e;
  --el-color-primary-light-3: #e42953;
  --el-color-primary-light-5: #ec5b78;
  --el-color-primary-light-7: #f39aaf;
  --el-color-primary-light-8: #f8c2ce;
  --el-color-primary-light-9: #fce7ec;
  --el-color-primary-dark-2: #9c0022;
  color: var(--za-ink);
  background: var(--za-canvas);
  font-family: "PingFang SC", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif;
  letter-spacing: 0;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  min-height: 100%;
  margin: 0;
}

body {
  background: var(--tp-bg-app);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  color: inherit;
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--za-teal);
  outline-offset: 3px;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 0 clamp(18px, 2.7vw, 42px);
  border-bottom: 1px solid var(--tp-line);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(20px);
  box-shadow: 0 1px 2px rgba(20, 21, 20, .04);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  color: var(--za-ink);
  text-decoration: none;
  white-space: nowrap;
}

.brand img {
  width: 118px;
  height: auto;
}

.brand-wordmark {
  color: var(--tp-text-primary);
  font-size: 17px;
  font-weight: 900;
  letter-spacing: -.025em;
}

.brand-wordmark em {
  color: var(--tp-accent);
  font-style: normal;
}

.brand-divider {
  width: 1px;
  height: 30px;
  background: var(--tp-line);
}

.brand-copy {
  display: grid;
  gap: 2px;
}

.brand-copy strong {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -.015em;
}

.brand-copy small {
  color: var(--tp-text-subtle);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .12em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.app-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  position: relative;
  min-height: 36px;
  padding: 0 13px;
  border-radius: var(--tp-radius-control);
  color: var(--tp-text-muted);
  text-decoration: none;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  transition: color 0.18s ease;
}

.nav-link:hover {
  color: var(--tp-text-primary);
  background: var(--tp-bg-muted);
}

.nav-link-active {
  color: var(--tp-accent);
  background: var(--tp-accent-subtle);
}

.nav-link-active::after {
  display: none;
}

.poc-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--tp-line);
  border-radius: 999px;
  color: var(--tp-text-muted);
  background: var(--tp-bg-muted);
  font-size: 11px;
  white-space: nowrap;
}

.poc-badge i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-success);
  box-shadow: 0 0 0 3px var(--tp-success-bg);
}

.account-control {
  flex: 0 0 auto;
  height: 42px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 5px 4px 4px;
  border-left: 1px solid var(--tp-line);
  padding-left: 16px;
}

.account-avatar {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: white;
  background: linear-gradient(140deg, #3c3e3d, #141514);
  font-size: 13px;
}

.account-copy {
  display: grid;
  min-width: 72px;
  line-height: 1.15;
}

.account-copy strong {
  color: var(--tp-text-primary);
  font-size: 11px;
  font-weight: 700;
}

.account-copy small {
  margin-top: 3px;
  color: var(--tp-text-subtle);
  font-size: 9px;
}

.logout-button {
  white-space: nowrap;
  min-height: 32px;
  border: 1px solid var(--tp-line);
  border-radius: var(--tp-radius-control);
  padding: 0 10px;
  color: var(--tp-text-muted);
  background: var(--tp-bg-surface);
  cursor: pointer;
  font-size: 10px;
}

.logout-button:hover { border-color: var(--tp-accent-muted); color: var(--tp-accent); background: var(--tp-accent-subtle); }

.el-button,
.el-input__wrapper,
.el-textarea__inner,
.el-select__wrapper {
  border-radius: var(--tp-radius-control) !important;
}

.el-input__wrapper,
.el-select__wrapper {
  min-height: 34px !important;
}

.el-textarea__inner {
  font-size: 13px !important;
  line-height: 1.45 !important;
}

@media (max-width: 680px) {
  .app-header {
    height: auto;
    min-height: 64px;
    align-items: flex-start;
    flex-direction: column;
    padding: 10px 14px 0;
  }

  .app-nav {
    width: auto;
    flex: 1 1 auto;
    min-width: 0;
  }

  .header-actions {
    width: 100%;
    align-items: center;
  }

  .nav-link {
    min-height: 44px;
    padding: 0 10px;
  }

  .nav-link-active::after {
    right: 10px;
    left: 10px;
  }

  .poc-badge {
    display: none;
  }

  .account-copy { display: none; }
  .account-control {
    margin-left: auto;
    padding-left: 8px;
    border-left: 0;
  }
}
</style>
