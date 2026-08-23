const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFixedTemplateReviewProfile } = require('../routes/contracts/analyzeRoutes');

test('keeps template review dimensions formal and marks LLM-only ideas supplemental', () => {
    const result = applyFixedTemplateReviewProfile({
        suggested_review_points: ['付款保障', '合同特有建议', '付款保障', ''],
        suggested_core_purposes: ['控制付款风险', '关注合同特有目标'],
    }, {
        review_points: ['付款保障', '验收机制'],
        core_purposes: ['控制付款风险', '确保权责对等'],
    });

    assert.deepEqual(result.formal_review_points, ['付款保障', '验收机制']);
    assert.deepEqual(result.formal_core_purposes, ['控制付款风险', '确保权责对等']);
    assert.deepEqual(result.supplemental_review_points, ['合同特有建议']);
    assert.deepEqual(result.supplemental_core_purposes, ['关注合同特有目标']);
    assert.deepEqual(result.suggested_review_points, ['付款保障', '验收机制', '合同特有建议']);
    assert.deepEqual(result.suggested_core_purposes, ['控制付款风险', '确保权责对等', '关注合同特有目标']);
    assert.deepEqual(result.review_profile, {
        source: 'matched_template',
        formal_scope: 'template_only',
        supplemental_default_selected: false,
        trace_version: 'fixed-template-review-profile-v1',
    });
});

test('does not promote LLM suggestions when a template has no formal dimensions', () => {
    const result = applyFixedTemplateReviewProfile({
        suggested_review_points: ['模型临时建议'],
        suggested_core_purposes: ['模型临时目的'],
    }, null);

    assert.deepEqual(result.formal_review_points, []);
    assert.deepEqual(result.formal_core_purposes, []);
    assert.deepEqual(result.supplemental_review_points, ['模型临时建议']);
    assert.deepEqual(result.supplemental_core_purposes, ['模型临时目的']);
});
