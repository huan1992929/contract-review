import { createRouter, createWebHistory } from 'vue-router'

const Review = () => import('../views/Review.vue')
const Home = () => import('../views/Home.vue')
const Login = () => import('../views/Login.vue')
import { ensureSession } from '../auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { public: true }
  },
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/review',
    name: 'Review',
    component: Review
  },
  {
    path: '/history',
    redirect: '/'
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior() {
    return { top: 0, left: 0 };
  },
})

router.beforeEach(async (to) => {
  const user = await ensureSession()
  if (to.meta.public) {
    if (to.name === 'Login' && user) return { path: '/' }
    return true
  }
  if (!user) {
    return { name: 'Login', query: { redirect: to.fullPath } }
  }
  return true
})

export default router 
