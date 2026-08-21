import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import 'element-plus/dist/index.css';
import './assets/css/tailwind.css';

document.title = '思库合同审核';
// Keep a visible build revision in the DOM so production acceptance can
// distinguish a post-proxy-fix bundle from a browser-cached invalid module.
document.documentElement.dataset.contractReviewBuild = '20260821-static-proxy-hotfix';

const app = createApp(App);
app.use(router);
app.mount('#app');

window.ResizeObserver = class _NewResizeObserver extends ResizeObserver {
  constructor(callback) {
    super((entries, observer) => {
      window.requestAnimationFrame(() => callback(entries, observer));
    });
  }
};
