<template>
  <main class="login-page">
    <section class="login-card">
      <span class="login-eyebrow">THINK OPEN · CONTRACT REVIEW</span>
      <h1>请从 AI 团队进入合同审核</h1>
      <p>合同审核使用思库账号和权限，不提供独立账号登录。</p>
      <a href="/agents">返回 AI 团队</a>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background:
    radial-gradient(circle at 50% 18%, rgba(214, 0, 46, .09), transparent 28%),
    #fafbfb;
}

.login-card {
  width: min(560px, 100%);
  padding: 52px;
  border: 1px solid #e3e5e4;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 2px 6px rgba(20, 21, 20, .05), 0 24px 70px rgba(20, 21, 20, .08);
}

.login-eyebrow {
  color: #d6002e;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .14em;
}

h1 {
  margin: 18px 0 12px;
  color: #232524;
  font-size: clamp(30px, 5vw, 44px);
  line-height: 1.2;
}

p {
  margin: 0 0 28px;
  color: #5e6160;
  line-height: 1.8;
}

a {
  display: inline-flex;
  padding: 12px 22px;
  border-radius: 10px;
  color: #fff;
  background: #d6002e;
  box-shadow: 0 1px 2px rgba(118, 0, 26, .4), 0 6px 16px rgba(214, 0, 46, .22);
  font-weight: 700;
  text-decoration: none;
}
</style>
