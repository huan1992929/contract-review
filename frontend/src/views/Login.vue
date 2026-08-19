<template>
  <main class="login-page">
    <section class="login-story" aria-label="众安集团合同审核系统介绍">
      <div class="story-grid" aria-hidden="true"></div>
      <div class="story-topline">
        <img src="/asserts/zhongan-logo.png" alt="众安集团" />
        <span>INTERNAL REVIEW</span>
      </div>
      <div class="story-copy">
        <p class="story-index">01 / COST &amp; LEGAL</p>
        <h1>让每一份合同，<br><em>回到依据之上。</em></h1>
        <p class="story-description">面向成本与法务协同的合同审查工作台。标准范本、法规案例与审查要点，在一个受控流程中形成可执行意见。</p>
      </div>
      <div class="story-foot">
        <span>众安集团 · 内部试用系统</span>
        <span class="story-rule"></span>
        <span>ZA · 2026</span>
      </div>
    </section>

    <section class="login-panel">
      <div class="login-card">
        <div class="login-heading">
          <span class="login-eyebrow">CONTRACT INTELLIGENCE</span>
          <h2>欢迎登录</h2>
          <p>使用内部试用账号进入合同审核工作台</p>
        </div>

        <form class="login-form" @submit.prevent="submit">
          <label class="field-label" for="username">账号</label>
          <div class="field-shell" :class="{ focused: focusField === 'username' }">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 8a7 7 0 0 0-14 0"/></svg>
            <input id="username" v-model.trim="form.username" autocomplete="username" inputmode="text" placeholder="请输入账号" @focus="focusField = 'username'" @blur="focusField = ''">
          </div>

          <label class="field-label" for="password">密码</label>
          <div class="field-shell" :class="{ focused: focusField === 'password' }">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
            <input id="password" v-model="form.password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" @focus="focusField = 'password'" @blur="focusField = ''">
            <button class="password-toggle" type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </div>

          <p v-if="errorMessage" class="login-error" role="alert">{{ errorMessage }}</p>

          <button class="login-submit" type="submit" :disabled="submitting || !form.username || !form.password">
            <span>{{ submitting ? '正在验证…' : '进入审核系统' }}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
        </form>

        <div class="login-security">
          <span class="security-mark" aria-hidden="true"></span>
          <span>仅限授权人员使用 · 会话与访问记录受系统保护</span>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../auth';

const router = useRouter();
const route = useRoute();
const form = reactive({ username: '', password: '' });
const submitting = ref(false);
const showPassword = ref(false);
const focusField = ref('');
const errorMessage = ref('');

async function submit() {
  if (!form.username || !form.password || submitting.value) return;
  submitting.value = true;
  errorMessage.value = '';
  try {
    await login(form.username, form.password);
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/';
    await router.replace(redirect);
  } catch (error) {
    errorMessage.value = error.response?.data?.error || '登录失败，请稍后重试。';
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(440px, 1.08fr) minmax(420px, .92fr);
  background: #f7f6f1;
}

.login-story {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: clamp(32px, 5vw, 72px);
  color: #f6f1e6;
  background: #153b38;
  isolation: isolate;
}

.login-story::before {
  content: '';
  position: absolute;
  z-index: -1;
  width: min(70vw, 900px);
  aspect-ratio: 1;
  right: -45%;
  bottom: -45%;
  border: 1px solid rgba(210, 174, 98, .28);
  border-radius: 50%;
  box-shadow: 0 0 0 90px rgba(210, 174, 98, .035), 0 0 0 180px rgba(210, 174, 98, .025);
}

.story-grid {
  position: absolute;
  inset: 0;
  z-index: -2;
  opacity: .08;
  background-image: linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: linear-gradient(to bottom right, #000, transparent 78%);
}

.story-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.story-topline img {
  width: clamp(145px, 16vw, 198px);
  filter: brightness(0) invert(1);
  opacity: .96;
}

.story-topline span,
.login-eyebrow,
.story-index {
  font-family: Georgia, "Times New Roman", serif;
  letter-spacing: .2em;
}

.story-topline span {
  font-size: 10px;
  color: #d2ae62;
}

.story-copy {
  width: min(650px, 92%);
  margin: auto 0;
  animation: reveal .65s cubic-bezier(.2,.75,.25,1) both;
}

.story-index {
  margin: 0 0 26px;
  color: #d2ae62;
  font-size: 11px;
}

.story-copy h1 {
  margin: 0;
  font-family: "Songti SC", "STSong", serif;
  font-size: clamp(44px, 5.4vw, 78px);
  font-weight: 500;
  line-height: 1.16;
  letter-spacing: .02em;
}

.story-copy h1 em {
  color: #dfbe76;
  font-style: normal;
}

.story-description {
  max-width: 540px;
  margin: 34px 0 0;
  color: rgba(246, 241, 230, .7);
  font-size: 15px;
  line-height: 2;
}

.story-foot {
  display: flex;
  align-items: center;
  gap: 18px;
  color: rgba(246, 241, 230, .48);
  font-size: 10px;
  letter-spacing: .12em;
}

.story-rule { flex: 1; height: 1px; background: rgba(210, 174, 98, .28); }

.login-panel {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: clamp(28px, 6vw, 90px);
  background:
    radial-gradient(circle at 90% 10%, rgba(210,174,98,.11), transparent 28%),
    #f7f6f1;
}

.login-card {
  width: min(430px, 100%);
  animation: reveal .65s .08s cubic-bezier(.2,.75,.25,1) both;
}

.login-heading { margin-bottom: 42px; }
.login-eyebrow { color: #9a7939; font-size: 10px; }
.login-heading h2 {
  margin: 12px 0 8px;
  color: #173533;
  font-family: "Songti SC", "STSong", serif;
  font-size: 36px;
  letter-spacing: .08em;
}
.login-heading p { margin: 0; color: #7a8885; font-size: 13px; }

.login-form { display: grid; }
.field-label { margin: 0 0 9px; color: #445d5a; font-size: 12px; font-weight: 700; }
.field-label:not(:first-child) { margin-top: 22px; }
.field-shell {
  height: 54px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border: 1px solid #d7ddd8;
  background: rgba(255,255,255,.78);
  transition: border-color .2s, box-shadow .2s, background .2s;
}
.field-shell.focused { border-color: #008c88; background: #fff; box-shadow: 0 0 0 3px rgba(0,140,136,.08); }
.field-shell svg { width: 19px; fill: none; stroke: #81908d; stroke-width: 1.6; }
.field-shell input { flex: 1; min-width: 0; border: 0; outline: 0; color: #173533; background: transparent; font: inherit; font-size: 14px; }
.field-shell input::placeholder { color: #a8b1af; }
.password-toggle { border: 0; padding: 7px 0 7px 8px; color: #6b817e; background: transparent; cursor: pointer; font-size: 11px; }
.login-error { margin: 14px 0 -2px; color: #b53b32; font-size: 12px; line-height: 1.6; }

.login-submit {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 30px;
  padding: 0 22px;
  border: 0;
  color: white;
  background: #008c88;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: .08em;
  transition: transform .18s, background .18s, box-shadow .18s;
}
.login-submit:hover:not(:disabled) { transform: translateY(-2px); background: #006f6c; box-shadow: 0 14px 28px rgba(0,111,108,.18); }
.login-submit:disabled { cursor: not-allowed; opacity: .55; }
.login-submit svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }

.login-security {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 24px;
  color: #8c9895;
  font-size: 10px;
}
.security-mark { width: 7px; height: 7px; border-radius: 50%; background: #d2ae62; box-shadow: 0 0 0 4px rgba(210,174,98,.13); }

@keyframes reveal { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }

@media (max-width: 820px) {
  .login-page { grid-template-columns: 1fr; }
  .login-story { min-height: 285px; padding: 28px; }
  .story-copy { margin: 48px 0 20px; }
  .story-copy h1 { font-size: 38px; }
  .story-description, .story-index { display: none; }
  .story-foot { display: none; }
  .login-panel { min-height: calc(100vh - 285px); padding: 42px 24px 60px; align-items: start; }
}

@media (prefers-reduced-motion: reduce) {
  .story-copy, .login-card { animation: none; }
}
</style>
