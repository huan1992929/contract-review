/**
 * Deterministic ThinkPark party/role and business-scenario classification.
 *
 * This module deliberately does not use an LLM. Exact, versioned entity names
 * take precedence; ambiguous or missing role evidence is surfaced for manual
 * confirmation instead of being guessed.
 */

const THINKPARK_ENTITY_POLICY_VERSION = 'thinkpark-entity-whitelist-v1-20260502';

const THINKPARK_ENTITIES = [
    '思库文化传播集团有限公司',
    '思门（杭州）品牌营销策划有限公司',
    '杭州光映场景科技有限公司',
    '思库（成都）文化传播有限公司',
    '思库（苏州）文化传播有限公司',
    '杭州思库文化创意有限公司',
    '杭州思库营销策划有限公司',
    '光格（杭州）文化传播有限公司',
    '思库共创（北京）营销策划有限公司',
    '上海造酷文化科技有限公司',
];

const ROLE_LABELS = {
    '甲方': 'party_a',
    '乙方': 'party_b',
};

const SCENARIOS = [
    {
        id: 'supplier_service',
        name: '通用供应商服务与采购',
        keywords: ['供应商', '采购合同', '委托服务', '服务采购', '供货', '承揽', '采购方'],
        templateIds: ['thinkpark_supplier_single_service', 'thinkpark_supplier_framework'],
        preferredRole: 'party_a',
    },
    {
        id: 'venue',
        name: '场地租赁与预订',
        keywords: ['场地', '会场', '展馆', '酒店', '会议室', '租赁', '预订', '档期'],
        templateIds: ['thinkpark_event_service', 'thinkpark_supplier_single_service'],
        preferredRole: 'party_a',
    },
    {
        id: 'custom_procurement',
        name: '定制产品与设计制作采购',
        keywords: ['定制', '设计制作', '物料制作', '视频制作', '印刷', '搭建', '打样', '成品交付'],
        templateIds: ['thinkpark_design_production', 'thinkpark_supplier_single_service'],
        preferredRole: 'party_a',
    },
    {
        id: 'client_service',
        name: '客户服务与创意服务',
        keywords: ['客户', '创意服务', '品牌服务', '营销服务', '活动承办', '综合服务', '服务提供方'],
        templateIds: ['thinkpark_client_creative_service', 'thinkpark_event_service'],
        preferredRole: 'party_b',
    },
    {
        id: 'legal_consultation',
        name: '通用法律咨询',
        keywords: ['法律咨询', '律师服务', '专项法律', '法律意见', '合规咨询'],
        templateIds: ['thinkpark_general'],
    },
    {
        id: 'contract_drafting',
        name: '合同起草与生成',
        keywords: ['合同起草', '协议起草', '合同生成', '拟定合同', '草拟协议'],
        templateIds: ['thinkpark_general'],
    },
];

const normalizeEntityText = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[()]/g, (character) => (character === '(' ? '（' : '）'));

const clipEvidence = (text, start, end, radius = 30) => String(text || '')
    .slice(Math.max(0, start - radius), Math.min(String(text || '').length, end + radius))
    .replace(/\s+/g, ' ')
    .trim();

const findRoleAroundEntity = (text, start, end) => {
    const before = text.slice(Math.max(0, start - 60), start);
    const after = text.slice(end, Math.min(text.length, end + 25));
    const beforeMatches = [...before.matchAll(/(甲方|乙方)(?:（[^）\n]{0,20}）|\([^）\n]{0,20}\))?\s*[：:]?\s*/g)];
    const nearestBefore = beforeMatches.at(-1);
    if (nearestBefore && before.length - (nearestBefore.index + nearestBefore[0].length) <= 24) {
        return { label: nearestBefore[1], role: ROLE_LABELS[nearestBefore[1]] };
    }
    const afterMatch = after.match(/^\s*(?:（[^）\n]{0,20}）)?\s*[，,；;]?\s*(甲方|乙方)/);
    if (afterMatch) return { label: afterMatch[1], role: ROLE_LABELS[afterMatch[1]] };
    return { label: null, role: 'unknown' };
};

const identifyThinkParkParty = (rawText, options = {}) => {
    const text = String(rawText || '');
    const normalizedText = normalizeEntityText(text);
    const configuredEntities = Array.isArray(options.entities) && options.entities.length
        ? options.entities
        : THINKPARK_ENTITIES;
    const evidence = [];
    const occupiedSpans = [];

    [...configuredEntities].sort((left, right) => right.length - left.length).forEach((entityName) => {
        const normalizedEntity = normalizeEntityText(entityName);
        if (!normalizedText.includes(normalizedEntity)) return;
        const flexibleParts = [...entityName].map((character) => {
            if (character === '（' || character === '(') return '[（(]';
            if (character === '）' || character === ')') return '[）)]';
            return character.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
        });
        const matches = [...text.matchAll(new RegExp(flexibleParts.join('\\s*'), 'g'))];
        matches.forEach((match) => {
            const start = match.index;
            const end = start + match[0].length;
            if (occupiedSpans.some((span) => start >= span.start && end <= span.end)) return;
            occupiedSpans.push({ start, end });
            const roleEvidence = findRoleAroundEntity(text, start, end);
            evidence.push({
                entity_name: entityName,
                role: roleEvidence.role,
                role_label: roleEvidence.label,
                source: 'contract_text_exact_whitelist',
                snippet: clipEvidence(text, start, end),
                start,
                end,
            });
        });
    });

    const distinctEntities = [...new Set(evidence.map((item) => item.entity_name))];
    const distinctRoles = [...new Set(evidence.map((item) => item.role).filter((role) => role !== 'unknown'))];
    const entityName = distinctEntities.length === 1 ? distinctEntities[0] : null;
    const role = distinctRoles.length === 1 ? distinctRoles[0] : 'unknown';
    const highConfidence = distinctEntities.length === 1 && distinctRoles.length === 1
        && !evidence.some((item) => item.role !== 'unknown' && item.role !== role);
    const ambiguous = distinctEntities.length > 1 || distinctRoles.length > 1;

    return {
        policy_version: THINKPARK_ENTITY_POLICY_VERSION,
        our_party: entityName,
        our_role: highConfidence ? role : 'unknown',
        role_label: highConfidence ? (role === 'party_a' ? '甲方' : '乙方') : null,
        confidence: highConfidence ? 'high' : (evidence.length ? 'medium' : 'low'),
        confidence_score: highConfidence ? 0.98 : (evidence.length ? 0.55 : 0),
        requires_confirmation: !highConfidence,
        confirmation_reason: ambiguous
            ? '检测到多个思库主体或相互冲突的甲乙方证据。'
            : (!entityName ? '未在合同中精确匹配思库主体白名单。' : '已识别思库主体，但无法确定甲乙方角色。'),
        evidence,
        candidates: distinctEntities,
    };
};

const scoreScenario = (scenario, text, contractType, ourRole) => {
    const haystack = `${contractType || ''}\n${text || ''}`.toLowerCase();
    const matches = scenario.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
    const typeMatches = scenario.keywords.filter((keyword) => String(contractType || '').toLowerCase().includes(keyword.toLowerCase()));
    let score = matches.length + typeMatches.length * 2;
    if (scenario.preferredRole && scenario.preferredRole === ourRole && matches.length) score += 1;
    return {
        id: scenario.id,
        name: scenario.name,
        score,
        template_ids: scenario.templateIds,
        evidence: matches.slice(0, 6).map((keyword) => ({
            type: 'keyword',
            keyword,
            snippet: clipEvidence(String(text || ''), Math.max(0, String(text || '').indexOf(keyword)), Math.max(0, String(text || '').indexOf(keyword)) + keyword.length),
        })),
    };
};

const classifyBusinessScenarios = (text, options = {}) => {
    const scored = SCENARIOS
        .map((scenario) => scoreScenario(scenario, text, options.contractType, options.ourRole))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const primary = scored[0] || {
        id: 'supplier_service',
        name: '通用供应商服务与采购',
        score: 0,
        template_ids: ['thinkpark_supplier_single_service', 'thinkpark_general'],
        evidence: [],
    };
    const secondary = scored
        .slice(1)
        .filter((item) => item.score >= Math.max(1, primary.score * 0.45))
        .slice(0, 2);
    const confidenceScore = primary.score >= 5 ? 0.95 : primary.score >= 3 ? 0.82 : primary.score >= 1 ? 0.62 : 0.25;
    return {
        taxonomy_version: 'thinkpark-six-scenarios-v1',
        primary,
        secondary,
        confidence: confidenceScore >= 0.8 ? 'high' : confidenceScore >= 0.6 ? 'medium' : 'low',
        confidence_score: confidenceScore,
        requires_confirmation: confidenceScore < 0.6,
        candidates: scored.slice(0, 4),
    };
};

const analyzePartyAndScenario = (text, options = {}) => {
    const partyIdentification = identifyThinkParkParty(text, options);
    return {
        party_identification: partyIdentification,
        scenario_detection: classifyBusinessScenarios(text, {
            contractType: options.contractType,
            ourRole: partyIdentification.our_role,
        }),
    };
};

module.exports = {
    THINKPARK_ENTITIES,
    THINKPARK_ENTITY_POLICY_VERSION,
    SCENARIOS,
    normalizeEntityText,
    identifyThinkParkParty,
    classifyBusinessScenarios,
    analyzePartyAndScenario,
};
