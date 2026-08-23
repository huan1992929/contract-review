const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    CORE_REVIEW_TOPICS,
    buildReviewFingerprint,
    mergeCoverageCandidates,
    validateFixedTopicCoverage,
} = require('../services/contractAnalysis/reviewStability');
const { dedupeKnowledgeWithTrace } = require('../services/contractAnalysis/knowledge');

const template = {
    id: 'supplier-service',
    updated_at: '2026-08-24T00:00:00.000Z',
    review_points: ['付款与验收', '违约责任'],
    core_purposes: ['保障思库交易安全'],
};

const fingerprint = (storagePath, plainText) => buildReviewFingerprint({
    storagePath,
    plainText,
    template,
    contractType: '服务合同',
    perspective: '甲方（思库）',
    knowledgeReleaseId: 'release-7',
    requestOptions: { timeout: 300000, maxRetries: 0 },
    env: {
        LLM_BASE_URL: 'https://model.example/v1',
        LLM_MODEL: 'review-model-v1',
        REVIEW_LLM_TEMPERATURE: '0',
        REVIEW_LLM_SEED: '7',
    },
});

test('review fingerprint follows logical review text instead of OOXML wrapper bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stability-'));
    const first = path.join(dir, 'first.docx');
    const second = path.join(dir, 'second.docx');
    fs.writeFileSync(first, 'zip-wrapper-a');
    fs.writeFileSync(second, 'zip-wrapper-b');
    try {
        const firstFingerprint = fingerprint(first, '第一条  付款\r\n\r\n第二条 验收');
        const secondFingerprint = fingerprint(second, '第一条 付款\n\n第二条 验收');
        assert.equal(firstFingerprint.fingerprint, secondFingerprint.fingerprint);
        assert.notEqual(firstFingerprint.descriptor.document_sha256, secondFingerprint.descriptor.document_sha256);
        assert.equal(firstFingerprint.descriptor.logical_text_sha256, secondFingerprint.descriptor.logical_text_sha256);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('existing revision dual view changes the logical review fingerprint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stability-'));
    const file = path.join(dir, 'contract.docx');
    fs.writeFileSync(file, 'same-wrapper');
    try {
        const baseline = fingerprint(file, '【修订前原文】付款后不退费\n【已有修订意见】未履行部分可退费');
        const changed = fingerprint(file, '【修订前原文】付款后不退费\n【已有修订意见】不退费');
        assert.notEqual(baseline.fingerprint, changed.fingerprint);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fixed topic risk candidates precede free planner supplements and retain stable query', () => {
    const raw = {
        topic_coverage: [{
            topic_id: 'payment',
            status: 'risk',
            candidate: { title: '预付款无保障', knowledge_query: '保障措施' },
        }],
        candidate_issues: [{ title: '合同特有问题' }],
    };
    const merged = mergeCoverageCandidates(raw);
    assert.deepEqual(merged.candidate_issues.map((item) => item.title), ['预付款无保障', '合同特有问题']);
    assert.match(merged.candidate_issues[0].knowledge_query, new RegExp(CORE_REVIEW_TOPICS[0].query));
});

test('incomplete fixed topic coverage fails closed instead of saving fewer risks', () => {
    const complete = {
        topic_coverage: CORE_REVIEW_TOPICS.map((topic) => ({
            topic_id: topic.id,
            status: 'covered',
            reason: '合同已覆盖',
        })),
    };
    assert.doesNotThrow(() => validateFixedTopicCoverage(complete));
    assert.throws(
        () => validateFixedTopicCoverage({ topic_coverage: complete.topic_coverage.slice(1) }),
        (error) => error.code === 'HOLISTIC_TOPIC_COVERAGE_INCOMPLETE'
            && error.missing_topics.includes(CORE_REVIEW_TOPICS[0].id),
    );
    assert.throws(
        () => validateFixedTopicCoverage({
            topic_coverage: complete.topic_coverage.map((item, index) => (
                index === 0 ? { ...item, status: 'risk' } : item
            )),
        }),
        (error) => error.code === 'HOLISTIC_TOPIC_COVERAGE_INCOMPLETE'
            && error.invalid_topics.includes(CORE_REVIEW_TOPICS[0].id),
    );
});

test('knowledge batches deduplicate documents and retain fixed-query trace', () => {
    const result = dedupeKnowledgeWithTrace([{
        queryId: 'payment',
        items: [{ law: '供应商范本', content: '付款与验收挂钩', score: 0.8, metadata: { document_id: 'doc-1' } }],
    }, {
        queryId: 'acceptance',
        items: [{ law: '供应商范本', content: '验收后付款', score: 0.9, metadata: { document_id: 'doc-1' } }],
    }], 8);
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.9);
    assert.deepEqual(result[0].metadata.matched_queries, ['acceptance', 'payment']);
});
