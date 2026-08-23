const test = require('node:test');
const assert = require('node:assert/strict');

const {
    THINKPARK_ENTITIES,
    identifyThinkParkParty,
    classifyBusinessScenarios,
    analyzePartyAndScenario,
} = require('../services/partyScenarioClassifier');
const {
    scoreTemplateCandidates,
    rankKnowledgeTemplateDocuments,
} = require('../services/reviewTemplates');
const db = require('../database');

test('uses the versioned 10-entity ThinkPark whitelist from the legal department requirement', () => {
    assert.equal(THINKPARK_ENTITIES.length, 10);
    assert.ok(THINKPARK_ENTITIES.includes('思库文化传播集团有限公司'));
    assert.ok(THINKPARK_ENTITIES.includes('杭州光映场景科技有限公司'));
});

test('identifies ThinkPark as party A from exact whitelist and returns evidence', () => {
    const text = '甲方（服务接受方）：思库文化传播集团有限公司\n乙方（服务提供方）：北京示例科技有限公司';
    const result = identifyThinkParkParty(text);

    assert.equal(result.our_party, '思库文化传播集团有限公司');
    assert.equal(result.our_role, 'party_a');
    assert.equal(result.role_label, '甲方');
    assert.equal(result.confidence, 'high');
    assert.equal(result.requires_confirmation, false);
    assert.match(result.evidence[0].snippet, /甲方.*思库文化传播集团有限公司/);
});

test('normalizes controlled parentheses and whitespace without loose brand matching', () => {
    const exact = identifyThinkParkParty('乙方：思库 ( 成都 ) 文化传播有限公司');
    assert.equal(exact.our_party, '思库（成都）文化传播有限公司');
    assert.equal(exact.our_role, 'party_b');

    const loose = identifyThinkParkParty('甲方：思库项目组');
    assert.equal(loose.our_party, null);
    assert.equal(loose.requires_confirmation, true);
});

test('maps a branch name to its whitelisted parent legal entity', () => {
    const result = identifyThinkParkParty('甲方：杭州思库文化创意有限公司北京分公司');

    assert.equal(result.our_party, '杭州思库文化创意有限公司');
    assert.equal(result.our_role, 'party_a');
    assert.deepEqual(result.candidates, ['杭州思库文化创意有限公司']);
});

test('does not guess when role evidence conflicts', () => {
    const text = [
        '甲方：杭州思库文化创意有限公司',
        '签章页乙方：杭州思库文化创意有限公司',
    ].join('\n');
    const result = identifyThinkParkParty(text);

    assert.equal(result.our_role, 'unknown');
    assert.equal(result.requires_confirmation, true);
    assert.match(result.confirmation_reason, /冲突/);
});

test('classifies one primary and bounded secondary scenarios with evidence', () => {
    const result = classifyBusinessScenarios(
        '场地预订服务合同。甲方向酒店预订会议室及活动场地，需确认档期和取消安排。',
        { contractType: '活动场地预订服务合同', ourRole: 'party_a' },
    );

    assert.equal(result.primary.id, 'venue');
    assert.ok(result.primary.evidence.some((item) => item.keyword === '场地'));
    assert.ok(result.secondary.length <= 2);
    assert.equal(result.requires_confirmation, false);
});

test('combines party and six-scenario classification deterministically', () => {
    const result = analyzePartyAndScenario(
        '乙方（服务提供方）：杭州思库营销策划有限公司。乙方向客户提供品牌创意服务和营销服务。',
        { contractType: '品牌创意服务合同' },
    );

    assert.equal(result.party_identification.our_role, 'party_b');
    assert.equal(result.scenario_detection.primary.id, 'client_service');
});

test('routes ThinkPark buyer software contracts to supplier service despite counterparty labels', () => {
    const result = analyzePartyAndScenario(
        '甲方（服务接受方）：思库文化传播集团有限公司。乙方（服务提供方）：北京示例科技有限公司。甲方采购乙方企业AI软件服务，乙方负责系统部署。',
        { contractType: '企业软件服务协议' },
    );

    assert.equal(result.party_identification.our_role, 'party_a');
    assert.equal(result.scenario_detection.primary.id, 'supplier_service');
    assert.equal(result.scenario_detection.primary.template_ids[0], 'thinkpark_supplier_single_service');
    assert.equal(result.scenario_detection.candidates.some((item) => item.id === 'client_service'), false);
});

test('ranks traceable template candidates using scenario and keyword reasons', () => {
    const templates = [
        {
            id: 'thinkpark_event_service',
            name: '思库·活动承办与会务服务合同',
            contract_type_keywords: ['活动承办', '会务服务'],
        },
        {
            id: 'thinkpark_general',
            name: '思库·通用商务合同',
            contract_type_keywords: [],
        },
    ];
    const ranked = scoreTemplateCandidates(templates, {
        contractType: '活动承办服务合同',
        text: '本项目提供活动承办及会务服务。',
        scenarioDetection: {
            primary: {
                name: '客户服务与创意服务',
                template_ids: ['thinkpark_event_service'],
            },
            secondary: [],
        },
    });

    assert.equal(ranked[0].template_id, 'thinkpark_event_service');
    assert.ok(ranked[0].score > ranked[1].score);
    assert.ok(ranked[0].reasons.some((reason) => reason.startsWith('业务场景推荐')));
});

test('ranks a supplier venue document above a slightly closer client document', () => {
    const ranked = rankKnowledgeTemplateDocuments([
        {
            title: '1-客户相关合同文件（思库是乙方）/01-思库创意服务合同模板（通用版）.docx',
            score: 0.7041146,
        },
        {
            title: '2-供应商相关合同文件（思库是甲方）/10-场地预定服务合同.docx',
            score: 0.7039023,
        },
    ], {
        ourRole: 'party_a',
        scenarioDetection: { primary: { id: 'venue' }, secondary: [] },
    });

    assert.match(ranked[0].title, /场地预定服务合同/);
    assert.equal(ranked[0].rank, 1);
    assert.ok(ranked[0].ranking_reasons.some((reason) => reason.startsWith('甲方方向匹配')));
    assert.ok(ranked[0].ranking_reasons.some((reason) => reason.startsWith('主场景匹配')));
});

test('ranks client-side knowledge documents first when ThinkPark is party B', () => {
    const ranked = rankKnowledgeTemplateDocuments([
        {
            title: '2-供应商相关合同文件（思库是甲方）/服务采购合同.docx',
            score: 0.8,
        },
        {
            title: '1-客户相关合同文件（思库是乙方）/思库创意服务合同模板.docx',
            score: 0.7,
        },
    ], {
        ourRole: 'party_b',
        scenarioDetection: { primary: { id: 'client_service' }, secondary: [] },
    });

    assert.match(ranked[0].title, /客户相关合同文件/);
    assert.ok(ranked[0].ranking_reasons.some((reason) => reason.startsWith('乙方方向匹配')));
});

test.after(async () => {
    await db.destroy();
});
