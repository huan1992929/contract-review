const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTH_SESSION_SECRET = 'unit-test-session-secret-that-is-long-enough';
process.env.AUTH_SESSION_TTL_SECONDS = '3600';

const {
    SESSION_COOKIE,
    hashPassword,
    verifyPassword,
    signSession,
    verifySession,
    parseCookies,
    sessionCookie,
    clearSessionCookie,
    requireSession,
} = require('../services/appAuth');

test('password hashing is salted and rejects an incorrect password', () => {
    const first = hashPassword('test1234');
    const second = hashPassword('test1234');
    assert.notEqual(first, second);
    assert.equal(verifyPassword('test1234', first), true);
    assert.equal(verifyPassword('wrong-password', first), false);
});

test('session token and HttpOnly cookie preserve the authenticated account', () => {
    const token = signSession({ id: 12, username: 'zatest', role: 'reviewer' });
    const payload = verifySession(token);
    assert.equal(payload.sub, '12');
    assert.equal(payload.username, 'zatest');
    const header = sessionCookie(token);
    assert.match(header, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.equal(parseCookies(header)[SESSION_COOKIE], token);
    assert.match(clearSessionCookie(), /Max-Age=0/);
});

test('API middleware replaces spoofed user ids with the signed session identity', () => {
    const token = signSession({ id: 27, username: 'zatest', role: 'reviewer' });
    const req = { path: '/contracts', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'x-user-id': '999' } };
    let nextCalled = false;
    requireSession(req, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.headers['x-user-id'], '27');
    assert.equal(req.auth.username, 'zatest');
});

test('OnlyOffice save callback remains available without a browser session', () => {
    const req = { path: '/contracts/save-callback', headers: {} };
    let nextCalled = false;
    requireSession(req, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
});

test('unauthenticated API requests return the login-required response', () => {
    const req = { path: '/contracts', headers: {} };
    const response = {
        statusCode: 0,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; },
    };
    requireSession(req, response, () => assert.fail('next should not be called'));
    assert.equal(response.statusCode, 401);
    assert.equal(response.payload.code, 'AUTH_REQUIRED');
});
