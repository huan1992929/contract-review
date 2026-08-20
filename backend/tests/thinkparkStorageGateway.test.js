const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mirrorContractFile } = require('../services/thinkparkStorageGateway');

test('ThinkPark storage mirroring fails closed when production requires the gateway', async () => {
    const previousRequired = process.env.THINKPARK_STORAGE_REQUIRED;
    const previousUrl = process.env.THINKPARK_STORAGE_GATEWAY_URL;
    process.env.THINKPARK_STORAGE_REQUIRED = 'true';
    delete process.env.THINKPARK_STORAGE_GATEWAY_URL;
    try {
        await assert.rejects(
            mirrorContractFile('/missing.docx', { owner: 'user', contractId: 1, version: 'source' }),
            /NOT_CONFIGURED/,
        );
    } finally {
        if (previousRequired === undefined) delete process.env.THINKPARK_STORAGE_REQUIRED;
        else process.env.THINKPARK_STORAGE_REQUIRED = previousRequired;
        if (previousUrl === undefined) delete process.env.THINKPARK_STORAGE_GATEWAY_URL;
        else process.env.THINKPARK_STORAGE_GATEWAY_URL = previousUrl;
    }
});

test('ThinkPark storage mirroring sends a server-only authenticated multipart copy', async () => {
    let bodyLength = 0;
    const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-thinkpark-contract-review-key'], 'test-integration-key');
        assert.match(req.headers['content-type'], /^multipart\/form-data;/);
        req.on('data', (chunk) => { bodyLength += chunk.length; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ oss_key: 'contract-review/u/1/source.docx', sha256: 'abc', size: 4 }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thinkpark-storage-test-'));
    const filePath = path.join(tempDir, '合同.docx');
    await fs.promises.writeFile(filePath, 'docx');
    const previousUrl = process.env.THINKPARK_STORAGE_GATEWAY_URL;
    const previousKey = process.env.THINKPARK_INTEGRATION_KEY;
    process.env.THINKPARK_STORAGE_GATEWAY_URL = `http://127.0.0.1:${server.address().port}/mirror`;
    process.env.THINKPARK_INTEGRATION_KEY = 'test-integration-key';
    try {
        const result = await mirrorContractFile(filePath, { owner: 'thinkpark:user', contractId: 1, version: 'source' });
        assert.equal(result.oss_key, 'contract-review/u/1/source.docx');
        assert.ok(bodyLength > 4);
    } finally {
        if (previousUrl === undefined) delete process.env.THINKPARK_STORAGE_GATEWAY_URL;
        else process.env.THINKPARK_STORAGE_GATEWAY_URL = previousUrl;
        if (previousKey === undefined) delete process.env.THINKPARK_INTEGRATION_KEY;
        else process.env.THINKPARK_INTEGRATION_KEY = previousKey;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
