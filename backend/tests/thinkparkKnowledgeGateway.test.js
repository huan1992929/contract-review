const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    QUERY_MAX_CHARS,
    compactQuery,
    searchThinkParkKnowledge,
} = require('../services/thinkparkKnowledgeGateway');

test('ThinkPark knowledge queries retain the head and tail within the gateway limit', () => {
    const query = compactQuery({
        contractType: '服务合同',
        perspective: '甲方',
        text: `首部义务${'中间条款'.repeat(300)}尾部责任`,
    });
    assert.ok(query.length <= QUERY_MAX_CHARS);
    assert.match(query, /首部义务/);
    assert.match(query, /尾部责任/);
});

test('ThinkPark knowledge results retain verified release and document provenance', async () => {
    let requestBody;
    const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-thinkpark-contract-review-key'], 'test-integration-key');
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requestBody = JSON.parse(body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                legal_app_release_id: 'release-1',
                legal_app_release_no: 7,
                items: [{
                    document_id: 'doc-1',
                    knowledge_base_id: 'kb-1',
                    title: '采购合同模板',
                    content: '付款节点应与验收挂钩。',
                    score: 0.92,
                }],
            }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previousUrl = process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL;
    const previousKey = process.env.THINKPARK_INTEGRATION_KEY;
    process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL = `http://127.0.0.1:${server.address().port}/search`;
    process.env.THINKPARK_INTEGRATION_KEY = 'test-integration-key';
    try {
        const results = await searchThinkParkKnowledge('付款与验收', 5);
        assert.deepEqual(requestBody, { query: '付款与验收', limit: 5 });
        assert.equal(results[0].metadata.verified_release_binding, true);
        assert.equal(results[0].metadata.legal_app_release_id, 'release-1');
        assert.equal(results[0].metadata.knowledge_base_id, 'kb-1');
        assert.equal(results[0].metadata.document_id, 'doc-1');
    } finally {
        if (previousUrl === undefined) delete process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL;
        else process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL = previousUrl;
        if (previousKey === undefined) delete process.env.THINKPARK_INTEGRATION_KEY;
        else process.env.THINKPARK_INTEGRATION_KEY = previousKey;
        await new Promise((resolve) => server.close(resolve));
    }
});
