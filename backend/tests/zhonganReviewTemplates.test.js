const test = require('node:test');
const assert = require('node:assert/strict');

process.env.REVIEW_TEMPLATE_PROFILE = 'thinkpark';

const {
    getConfiguredTemplateProfile,
    loadTemplatesFromJson,
} = require('../services/reviewTemplates');
const db = require('../database');

const requiredTemplateIds = [
    'thinkpark_client_creative_service',
    'thinkpark_supplier_single_service',
    'thinkpark_supplier_framework',
    'thinkpark_event_service',
    'thinkpark_design_production',
    'thinkpark_technology_service',
    'thinkpark_general',
];

test('loads ThinkPark template profile derived from the legal assistant knowledge base', () => {
    const templates = loadTemplatesFromJson();
    const ids = templates.map((template) => template.id);

    assert.equal(getConfiguredTemplateProfile(), 'thinkpark');
    assert.equal(new Set(ids).size, ids.length);
    requiredTemplateIds.forEach((id) => assert.ok(ids.includes(id), `missing ${id}`));
    templates.forEach((template) => {
        assert.match(template.name, /思库/);
        assert.doesNotMatch(template.name, /众安/);
        assert.ok(template.review_points.length >= 8, `${template.id} review points are incomplete`);
        assert.ok(template.core_purposes.length >= 4, `${template.id} core purposes are incomplete`);
        assert.ok(template.prompt_rules.some((rule) => rule.includes('知识库')), `${template.id} must enforce knowledge-base-only citations`);
    });
});

test('uses distinct keywords for the ThinkPark business categories', () => {
    const templates = loadTemplatesFromJson();
    const keywordMap = new Map(templates.map((template) => [template.id, template.contract_type_keywords]));

    assert.ok(keywordMap.get('thinkpark_client_creative_service').includes('创意服务'));
    assert.ok(keywordMap.get('thinkpark_supplier_single_service').includes('委托服务协议'));
    assert.ok(keywordMap.get('thinkpark_supplier_framework').includes('年框'));
    assert.ok(keywordMap.get('thinkpark_event_service').includes('活动承办'));
    assert.ok(keywordMap.get('thinkpark_technology_service').includes('技术开发'));
});

test('provides a brand-specific general fallback template', () => {
    const templates = loadTemplatesFromJson();
    const fallback = templates.find((template) => template.id.endsWith('_general'));

    assert.equal(fallback.id, 'thinkpark_general');
    assert.deepEqual(fallback.contract_type_keywords, []);
});

test.after(async () => {
    await db.destroy();
});
