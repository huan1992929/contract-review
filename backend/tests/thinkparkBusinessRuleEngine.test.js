const test = require('node:test');
const assert = require('node:assert/strict');

const {
    detectBusinessScenarios,
    evaluateBusinessRules,
    mergeBusinessRuleResults,
} = require('../services/contractAnalysis/businessRuleEngine');

test('detects venue and supplier scenarios for ThinkPark as venue customer', () => {
    const scenarios = detectBusinessScenarios({
        text: '甲方预订乙方宴会厅作为活动场地。',
        perspective: '甲方（场地预订方）',
        contractType: '活动场地预订服务合同',
        templateId: 'thinkpark_event_service',
    });
    assert.ok(scenarios.some((item) => item.id === 'venue'));
    assert.ok(scenarios.some((item) => item.id === 'supplier_service'));
    assert.equal(scenarios.some((item) => item.id === 'client_service'), false);
});

test('reports full supplier prepayment as independently grounded internal policy risk', () => {
    const text = '第三条 本合同签订后三日内，甲方向乙方预付100%服务费。乙方完成活动执行服务。';
    const result = evaluateBusinessRules({
        text,
        perspective: '甲方（委托方）',
        contractType: '委托服务协议',
        templateId: 'thinkpark_supplier_single_service',
    });
    const finding = result.compliance_findings.find((item) => item.rule_id === 'TP-SUPPLIER-PAYMENT-001');
    assert.ok(finding);
    assert.equal(finding.severity, 'high');
    assert.equal(finding.source_type, 'thinkpark_internal_policy');
    assert.equal(finding.basis[0].source_id, 'TP-SUPPLIER-PAYMENT-001');
    assert.match(finding.issue_id, /^tp-risk-tp-supplier-payment-001-/);
    const suggestion = result.modification_suggestions.find((item) => item.rule_id === finding.rule_id);
    assert.equal(suggestion.operation, 'replace');
    assert.match(suggestion.suggested_text, /20%至30%/);
});

test('reports missing venue authorization as append operation', () => {
    const result = evaluateBusinessRules({
        text: '甲方向乙方预订宴会厅作为活动场地，使用期限一天。',
        perspective: '甲方（场地预订方）',
        contractType: '场地预订合同',
        templateId: 'thinkpark_event_service',
    });
    const finding = result.compliance_findings.find((item) => item.rule_id === 'TP-VENUE-AUTH-001');
    assert.ok(finding);
    assert.equal(finding.original_clause, '合同未约定');
    const suggestion = result.modification_suggestions.find((item) => item.rule_id === finding.rule_id);
    assert.equal(suggestion.operation, 'append');
});

test('does not apply buyer controls when ThinkPark is the service provider', () => {
    const result = evaluateBusinessRules({
        text: '客户委托思库提供创意服务，客户在收到交付成果后验收。',
        perspective: '乙方（服务提供方）',
        contractType: '创意服务协议',
        templateId: 'thinkpark_client_creative_service',
    });
    assert.equal(result.compliance_findings.some((item) => item.rule_id.startsWith('TP-SUPPLIER-')), false);
    assert.ok(result.compliance_findings.some((item) => item.rule_id === 'TP-CLIENT-ACCEPTANCE-001'));
});

test('merges internal findings before model findings and deduplicates stable issue ids', () => {
    const internal = evaluateBusinessRules({
        text: '本合同签订后甲方预付100%采购款。',
        perspective: '甲方（采购方）',
        contractType: '采购合同',
        templateId: 'thinkpark_supplier_single_service',
    });
    const duplicated = internal.compliance_findings[0];
    const merged = mergeBusinessRuleResults({
        compliance_findings: [
            duplicated,
            { title: duplicated.title, original_clause: duplicated.original_clause },
            { title: '范本差异', original_clause: '其他条款' },
        ],
        dispute_points: [],
        modification_suggestions: [],
    }, internal);
    assert.equal(merged.compliance_findings.filter((item) => item.issue_id === duplicated.issue_id).length, 1);
    assert.equal(merged.compliance_findings.filter((item) => item.title === duplicated.title).length, 1);
    assert.equal(merged.compliance_findings[0].source_type, 'thinkpark_internal_policy');
    assert.equal(merged.business_rule_review.audit.matched_count, internal.compliance_findings.length);
});
