const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { verifyThinkParkUser } = require('../routes/auth');

const listen = (server) => new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
});

test('ThinkPark SSO verifies the bearer token and contract-review permission', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, authorization: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/me') {
            res.end(JSON.stringify({ id: '41db8128-8138-4db6-b679-2ae2ed32e665', name: '思库法务' }));
            return;
        }
        if (req.url === '/api/contract-reviews/cases?limit=1&offset=0') {
            res.end('[]');
            return;
        }
        res.statusCode = 404;
        res.end('{}');
    });
    const port = await listen(server);
    const previousEnabled = process.env.THINKPARK_SSO_ENABLED;
    const previousUrl = process.env.THINKPARK_API_URL;
    process.env.THINKPARK_SSO_ENABLED = 'true';
    process.env.THINKPARK_API_URL = `http://127.0.0.1:${port}`;
    try {
        const profile = await verifyThinkParkUser({
            header: (name) => (name === 'Authorization' ? 'Bearer signed-thinkpark-token' : ''),
        });
        assert.equal(profile.name, '思库法务');
        assert.deepEqual(requests, [
            { url: '/api/me', authorization: 'Bearer signed-thinkpark-token' },
            { url: '/api/contract-reviews/cases?limit=1&offset=0', authorization: 'Bearer signed-thinkpark-token' },
        ]);
    } finally {
        if (previousEnabled === undefined) delete process.env.THINKPARK_SSO_ENABLED;
        else process.env.THINKPARK_SSO_ENABLED = previousEnabled;
        if (previousUrl === undefined) delete process.env.THINKPARK_API_URL;
        else process.env.THINKPARK_API_URL = previousUrl;
        await close(server);
    }
});

test('ThinkPark SSO rejects a token without contract-review access', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/me') {
            res.end(JSON.stringify({ id: '41db8128-8138-4db6-b679-2ae2ed32e665', name: '无权限用户' }));
            return;
        }
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'forbidden' }));
    });
    const port = await listen(server);
    const previousEnabled = process.env.THINKPARK_SSO_ENABLED;
    const previousUrl = process.env.THINKPARK_API_URL;
    process.env.THINKPARK_SSO_ENABLED = 'true';
    process.env.THINKPARK_API_URL = `http://127.0.0.1:${port}`;
    try {
        await assert.rejects(
            verifyThinkParkUser({ header: () => 'Bearer denied-token' }),
            (error) => error.status === 403 && error.message === 'THINKPARK_AUTH_REJECTED',
        );
    } finally {
        if (previousEnabled === undefined) delete process.env.THINKPARK_SSO_ENABLED;
        else process.env.THINKPARK_SSO_ENABLED = previousEnabled;
        if (previousUrl === undefined) delete process.env.THINKPARK_API_URL;
        else process.env.THINKPARK_API_URL = previousUrl;
        await close(server);
    }
});
