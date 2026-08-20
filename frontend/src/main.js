import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import 'element-plus/dist/index.css';
import './assets/css/tailwind.css';

document.title = '思库合同审核';

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
