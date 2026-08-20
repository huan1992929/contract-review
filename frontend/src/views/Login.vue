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
  background: #f5f4f8;
}

.login-card {
  width: min(560px, 100%);
  padding: 52px;
  border: 1px solid #ded9e5;
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 24px 70px rgba(35, 33, 66, .08);
}

.login-eyebrow {
  color: #7a1f3d;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .14em;
}

h1 {
  margin: 18px 0 12px;
  color: #232142;
  font-size: clamp(30px, 5vw, 44px);
  line-height: 1.2;
}

p {
  margin: 0 0 28px;
  color: #66617a;
  line-height: 1.8;
}

a {
  display: inline-flex;
  padding: 12px 22px;
  border-radius: 999px;
  color: #fff;
  background: #7a1f3d;
  font-weight: 700;
  text-decoration: none;
}
</style>
