const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCaseJsonDocument } = require('../services/caseJsonParser');

const caseDir = path.join(__dirname, '..', 'data', 'official_contract_cases');

test('all bundled official contract cases are traceable and parseable', () => {
    const files = fs.readdirSync(caseDir).filter((name) => name.endsWith('.json')).sort();
    assert.ok(files.length >= 9);

    const parsed = files.map((name) => {
        const document = JSON.parse(fs.readFileSync(path.join(caseDir, name), 'utf8'));
        const entry = parseCaseJsonDocument(document, { sourceFile: name });
        assert.ok(entry, `${name} should parse`);
        assert.equal(entry.source_type, 'case');
        assert.match(entry.source_url, /^https:\/\/www\.court\.gov\.cn\//);
        assert.equal(entry.metadata.approval_status, 'official_verified');
        assert.equal(entry.metadata.parser, 'official-case-v1');
        assert.ok(entry.content.length >= 100, `${name} content is unexpectedly short`);
        return entry;
    });

    assert.equal(new Set(parsed.map((entry) => entry.source_id)).size, parsed.length);
    assert.ok(parsed.some((entry) => entry.metadata.applicable_contract_types.includes('施工类')));
    assert.ok(parsed.some((entry) => entry.metadata.applicable_contract_types.includes('采购类')));
});

test('official cases without a court URL are rejected', () => {
    const entry = parseCaseJsonDocument({
        schema: 'official_case_v1',
        title: '无官方来源案例',
        facts: '用于验证拒绝逻辑的基本案情。',
    });
    assert.equal(entry, null);
});
