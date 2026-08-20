import { reactive, readonly } from 'vue';
import { apiClient } from './api';
import { clearAuthenticatedUser, setAuthenticatedUser } from './user';

const state = reactive({
  user: null,
  ready: false,
  checking: false,
});

let sessionRequest = null;
const THINKPARK_AUTH_KEY = 'thinkpark.auth';

function currentThinkParkToken() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(THINKPARK_AUTH_KEY) || '{}');
    if (!parsed.token || !parsed.expiresAt || parsed.expiresAt <= Math.floor(Date.now() / 1000)) return '';
    return String(parsed.token);
  } catch {
    return '';
  }
}

async function exchangeThinkParkSession() {
  const token = currentThinkParkToken();
  if (!token) return null;
  const response = await apiClient.post('/auth/thinkpark', {}, {
    skipAuthRedirect: true,
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data?.user || null;
}

function applyUser(user) {
  state.user = user || null;
  if (user) setAuthenticatedUser(user);
  else clearAuthenticatedUser();
}

export async function ensureSession({ force = false } = {}) {
  if (state.ready && !force) return state.user;
  if (sessionRequest) return sessionRequest;
  state.checking = true;
  sessionRequest = apiClient.get('/auth/session', { skipAuthRedirect: true })
    .then((response) => {
      applyUser(response.data?.user);
      return state.user;
    })
    .catch(async () => {
      try {
        const user = await exchangeThinkParkSession();
        applyUser(user);
        return state.user;
      } catch {
        applyUser(null);
        return null;
      }
    })
    .finally(() => {
      state.ready = true;
      state.checking = false;
      sessionRequest = null;
    });
  return sessionRequest;
}

export async function login(username, password) {
  const response = await apiClient.post('/auth/login', { username, password }, { skipAuthRedirect: true });
  applyUser(response.data?.user);
  state.ready = true;
  return state.user;
}

export async function logout() {
  try {
    await apiClient.post('/auth/logout', {}, { skipAuthRedirect: true });
  } finally {
    applyUser(null);
    state.ready = true;
  }
}

export function markSessionExpired() {
  applyUser(null);
  state.ready = true;
}

export const authState = readonly(state);
