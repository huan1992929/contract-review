const express = require('express');
const db = require('../database');
const {
    verifyPassword,
    signSession,
    getRequestSession,
    sessionCookie,
    clearSessionCookie,
} = require('../services/appAuth');

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        role: user.role || 'reviewer',
    };
}

function attemptKey(req, username) {
    return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
}

function registerFailure(key) {
    const now = Date.now();
    const current = attempts.get(key);
    const next = !current || now - current.startedAt > WINDOW_MS
        ? { count: 1, startedAt: now }
        : { ...current, count: current.count + 1 };
    attempts.set(key, next);
    return next;
}

function asyncHandler(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

router.post('/login', asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: '请输入账号和密码。' });

    const key = attemptKey(req, username);
    const recent = attempts.get(key);
    if (recent && recent.count >= MAX_ATTEMPTS && Date.now() - recent.startedAt <= WINDOW_MS) {
        return res.status(429).json({ error: '尝试次数过多，请十分钟后再试。' });
    }

    const user = await db('users').whereRaw('LOWER(username) = ?', [username]).first();
    if (!user || user.is_active === false || !verifyPassword(password, user.password_hash)) {
        registerFailure(key);
        return res.status(401).json({ error: '账号或密码不正确。' });
    }

    attempts.delete(key);
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now(), updated_at: db.fn.now() });
    res.setHeader('Set-Cookie', sessionCookie(signSession(user)));
    res.json({ user: publicUser(user) });
}));

router.get('/session', asyncHandler(async (req, res) => {
    const session = getRequestSession(req);
    if (!session) return res.status(401).json({ error: '未登录。', code: 'AUTH_REQUIRED' });
    const user = await db('users').where({ id: Number(session.sub), is_active: true }).first();
    if (!user) return res.status(401).json({ error: '账号已停用。', code: 'AUTH_REQUIRED' });
    res.json({ user: publicUser(user) });
}));

router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(204).end();
});

module.exports = router;
