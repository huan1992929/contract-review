const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getReviewLlmRequestOptions,
    shouldUseSegmentedReview,
} = require('../services/contractAnalysis/llm');

test('full contract review waits up to five minutes without duplicate retries', () => {
    assert.deepEqual(getReviewLlmRequestOptions({}), {
        timeout: 300000,
        maxRetries: 0,
    });
});

test('full contract review timeout policy accepts explicit non-negative overrides', () => {
    assert.deepEqual(getReviewLlmRequestOptions({
        REVIEW_LLM_TIMEOUT_MS: '240000',
        REVIEW_LLM_MAX_RETRIES: '1',
    }), {
        timeout: 240000,
        maxRetries: 1,
    });
});

test('invalid full contract review timeout policy falls back safely', () => {
    assert.deepEqual(getReviewLlmRequestOptions({
        REVIEW_LLM_TIMEOUT_MS: 'invalid',
        REVIEW_LLM_MAX_RETRIES: '-1',
    }), {
        timeout: 300000,
        maxRetries: 0,
    });
});

test('near-threshold contracts use segmented review before monolithic output becomes unstable', () => {
    assert.equal(shouldUseSegmentedReview(5999), false);
    assert.equal(shouldUseSegmentedReview(6000), true);
    assert.equal(shouldUseSegmentedReview(7569), true);
});
