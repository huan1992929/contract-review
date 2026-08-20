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

function bearerToken(req) {
    const authorization = String(req.header('Authorization') || '');
    return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function verifyThinkParkUser(req) {
    if (String(process.env.THINKPARK_SSO_ENABLED || '').toLowerCase() !== 'true') {
        const error = new Error('THINKPARK_SSO_DISABLED');
        error.status = 404;
        throw error;
    }
    const token = bearerToken(req);
    if (!token) {
        const error = new Error('THINKPARK_TOKEN_REQUIRED');
        error.status = 401;
        throw error;
    }
    const baseUrl = String(process.env.THINKPARK_API_URL || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('THINKPARK_API_URL is required when SSO is enabled');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const [profileResponse, permissionResponse] = await Promise.all([
        fetch(`${baseUrl}/api/me`, { headers, signal: AbortSignal.timeout(10000) }),
        fetch(`${baseUrl}/api/contract-reviews/cases?limit=1&offset=0`, {
            headers,
            signal: AbortSignal.timeout(10000),
        }),
    ]);
    if (!profileResponse.ok || !permissionResponse.ok) {
        const error = new Error('THINKPARK_AUTH_REJECTED');
        error.status = profileResponse.status === 401 ? 401 : 403;
        throw error;
    }
    const profile = await profileResponse.json();
    if (!profile?.id) {
        const error = new Error('THINKPARK_PROFILE_INVALID');
        error.status = 502;
        throw error;
    }
    return profile;
}

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
    if (String(process.env.THINKPARK_SSO_ENABLED || '').toLowerCase() === 'true') {
        return res.status(404).json({ error: '请从思库 AI 团队进入合同审核。' });
    }
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

router.post('/thinkpark', asyncHandler(async (req, res) => {
    const profile = await verifyThinkParkUser(req);
    const fingerprintId = `thinkpark:${profile.id}`;
    const username = `thinkpark-${profile.id}`;
    const displayName = String(profile.name || profile.username || '思库用户').slice(0, 120);
    let user = await db('users').where({ fingerprint_id: fingerprintId }).first();
    if (user) {
        await db('users').where({ id: user.id }).update({
            username,
            display_name: displayName,
            role: 'legal_reviewer',
            is_active: true,
            last_login_at: db.fn.now(),
            updated_at: db.fn.now(),
        });
        user = await db('users').where({ id: user.id }).first();
    } else {
        const inserted = await db('users').insert({
            fingerprint_id: fingerprintId,
            username,
            display_name: displayName,
            role: 'legal_reviewer',
            is_active: true,
            last_login_at: db.fn.now(),
        }).returning('*');
        user = inserted[0];
    }
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
module.exports.bearerToken = bearerToken;
module.exports.verifyThinkParkUser = verifyThinkParkUser;
