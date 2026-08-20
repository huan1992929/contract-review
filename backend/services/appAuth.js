const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SESSION_COOKIE = 'za_review_session';
const SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS || 12 * 60 * 60);
const SESSION_COOKIE_PATH = String(process.env.AUTH_COOKIE_PATH || '/').trim() || '/';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
    const [algorithm, salt, expectedHex] = String(storedHash || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function getSessionSecret() {
    const secret = process.env.AUTH_SESSION_SECRET;
    if (!secret) throw new Error('AUTH_SESSION_SECRET is required');
    return secret;
}

function signSession(user) {
    return jwt.sign(
        { sub: String(user.id), username: user.username, role: user.role || 'reviewer' },
        getSessionSecret(),
        { expiresIn: SESSION_TTL_SECONDS, issuer: 'zhongan-contract-review' },
    );
}

function verifySession(token) {
    return jwt.verify(token, getSessionSecret(), { issuer: 'zhongan-contract-review' });
}

function parseCookies(cookieHeader = '') {
    return String(cookieHeader)
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, item) => {
            const separator = item.indexOf('=');
            if (separator < 0) return cookies;
            const key = decodeURIComponent(item.slice(0, separator));
            const value = decodeURIComponent(item.slice(separator + 1));
            cookies[key] = value;
            return cookies;
        }, {});
}

function getRequestSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    try {
        return verifySession(token);
    } catch {
        return null;
    }
}

function sessionCookie(token) {
    const secure = process.env.AUTH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' && process.env.APP_HOST?.startsWith('https://');
    return [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        `Path=${SESSION_COOKIE_PATH}`,
        'HttpOnly',
        'SameSite=Lax',
        secure ? 'Secure' : '',
        `Max-Age=${SESSION_TTL_SECONDS}`,
    ].filter(Boolean).join('; ');
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function requireSession(req, res, next) {
    const publicApiPaths = new Set(['/contracts/save-callback']);
    if (publicApiPaths.has(req.path)) return next();
    const session = getRequestSession(req);
    if (!session) return res.status(401).json({ error: '登录状态已失效，请重新登录。', code: 'AUTH_REQUIRED' });
    req.auth = session;
    req.headers['x-user-id'] = String(session.sub);
    next();
}

module.exports = {
    SESSION_COOKIE,
    hashPassword,
    verifyPassword,
    signSession,
    verifySession,
    parseCookies,
    getRequestSession,
    sessionCookie,
    clearSessionCookie,
    requireSession,
};
