const test = require('node:test');
const assert = require('node:assert/strict');

process.env.REVIEW_TEMPLATE_PROFILE = 'zhongan';

const {
    getConfiguredTemplateProfile,
    loadTemplatesFromJson,
} = require('../services/reviewTemplates');
const db = require('../database');

const requiredTemplateIds = [
    'zhongan_construction',
    'zhongan_procurement',
    'zhongan_design',
    'zhongan_consulting',
    'zhongan_property_service',
    'zhongan_overseas',
    'zhongan_general',
];

test('loads ZhongAn template profile with the required real-estate categories', () => {
    const templates = loadTemplatesFromJson();
    const ids = templates.map((template) => template.id);

    assert.equal(getConfiguredTemplateProfile(), 'zhongan');
    assert.equal(new Set(ids).size, ids.length);
    requiredTemplateIds.forEach((id) => assert.ok(ids.includes(id), `missing ${id}`));
    templates.forEach((template) => {
        assert.match(template.name, /众安/);
        assert.ok(template.review_points.length >= 10, `${template.id} review points are incomplete`);
        assert.ok(template.core_purposes.length >= 4, `${template.id} core purposes are incomplete`);
        assert.ok(template.prompt_rules.some((rule) => rule.includes('知识库')), `${template.id} must enforce knowledge-base-only citations`);
    });
});

test('uses distinct keywords for the five core cost-management categories', () => {
    const templates = loadTemplatesFromJson();
    const keywordMap = new Map(templates.map((template) => [template.id, template.contract_type_keywords]));

    assert.ok(keywordMap.get('zhongan_construction').includes('建设工程施工'));
    assert.ok(keywordMap.get('zhongan_procurement').includes('材料采购'));
    assert.ok(keywordMap.get('zhongan_design').includes('设计合同'));
    assert.ok(keywordMap.get('zhongan_consulting').includes('造价咨询'));
    assert.ok(keywordMap.get('zhongan_property_service').includes('物业服务'));
});

test('provides a brand-specific general fallback template', () => {
    const templates = loadTemplatesFromJson();
    const fallback = templates.find((template) => template.id.endsWith('_general'));

    assert.equal(fallback.id, 'zhongan_general');
    assert.deepEqual(fallback.contract_type_keywords, []);
});

test.after(async () => {
    await db.destroy();
});
