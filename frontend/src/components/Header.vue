<template>
  <div class="header-component">
    <strong class="logo">THINK OPEN</strong>
    <div>
      <h1>合同审核</h1>
      <p>INTERNAL REVIEW</p>
    </div>
  </div>
</template>

<script>
export default {
  name: 'HeaderComponent',
};
</script>

<style scoped>
.header-component {
  display: flex;
  align-items: center;
  padding: 10px 20px;
  background-color: #141514;
  color: white;
}

.logo {
  width: 132px;
  height: auto;
  margin-right: 12px;
}

h1 {
  margin: 0;
  font-size: 20px;
}

p {
  margin: 2px 0 0;
  color: #f39aaf;
  font-family: Georgia, serif;
  font-size: 9px;
  letter-spacing: .16em;
}
</style>
