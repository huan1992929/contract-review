/**
 * 思库业务部门内部风控规则。
 *
 * 这些规则是经确认的内部审查依据，不伪装成法律或 WeKnora 范本。
 * 模型结果仍经过知识库依据校验；内部规则命中则以稳定 rule_id 独立入账。
 */
const crypto = require('crypto');
const policy = require('../../data/thinkparkBusinessRules.json');

const compact = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();

const includesAny = (text, values = []) => values.some((value) => text.includes(compact(value)));

const perspectiveMatches = (scenario, perspective) => {
    if (!scenario.perspectives?.length) return true;
    const normalized = compact(perspective);
    return scenario.perspectives.some((candidate) => normalized.includes(compact(candidate)));
};

const templateScenarioHints = {
    thinkpark_supplier_single_service: ['supplier_service'],
    thinkpark_supplier_framework: ['supplier_service'],
    thinkpark_event_service: ['supplier_service', 'venue', 'client_service'],
    thinkpark_design_production: ['custom_procurement', 'client_service'],
    thinkpark_technology_service: ['supplier_service', 'client_service'],
    thinkpark_client_creative_service: ['client_service'],
};

const detectBusinessScenarios = ({ text = '', perspective = '', contractType = '', templateId = '' } = {}) => {
    const haystack = compact(`${contractType}\n${text}`);
    const hinted = new Set(templateScenarioHints[templateId] || []);
    return policy.scenarios.map((scenario) => {
        const keywordHits = (scenario.keywords || []).filter((keyword) => haystack.includes(compact(keyword)));
        const perspectiveMatched = perspectiveMatches(scenario, perspective);
        const score = keywordHits.length * 2 + (hinted.has(scenario.id) ? 2 : 0) + (perspectiveMatched ? 1 : 0);
        return {
            id: scenario.id,
            name: scenario.name,
            score,
            keyword_hits: keywordHits.slice(0, 6),
            perspective_matched: perspectiveMatched,
            applicable: perspectiveMatched && (keywordHits.length > 0 || hinted.has(scenario.id)),
        };
    }).filter((item) => item.applicable).sort((left, right) => right.score - left.score);
};

const splitClauses = (text) => String(text || '')
    .split(/(?<=[。；;\n])/u)
    .map((item) => item.trim())
    .filter(Boolean);

const findMatchedClause = (text, rule) => {
    const clauses = splitClauses(text);
    return clauses.find((clause) => {
        const normalized = compact(clause);
        if (!includesAny(normalized, rule.match_any)) return false;
        if (rule.near_any?.length && !includesAny(normalized, rule.near_any)) return false;
        if (rule.exclude_any?.length && includesAny(normalized, rule.exclude_any)) return false;
        return true;
    }) || '';
};

const makeIssueId = (ruleId, anchor) => {
    const fingerprint = crypto.createHash('sha256').update(`${ruleId}|${compact(anchor)}`).digest('hex').slice(0, 16);
    return `tp-risk-${ruleId.toLowerCase()}-${fingerprint}`;
};

const makeBasis = (rule) => [{
    source_type: 'thinkpark_internal_policy',
    source_id: rule.id,
    title: `${policy.policy_name}·${rule.title}`,
    clause: rule.id,
    content: rule.description,
}];

const materializeRule = (rule, anchor) => {
    const issueId = makeIssueId(rule.id, anchor || '合同未约定');
    const basis = makeBasis(rule);
    const finding = {
        issue_id: issueId,
        risk_id: issueId,
        rule_id: rule.id,
        scenario_id: rule.scenario_id,
        severity: rule.severity,
        source_type: 'thinkpark_internal_policy',
        issue_type: '合规瑕疵',
        title: rule.title,
        original_clause: anchor || '合同未约定',
        basis,
        description: rule.description,
        evidence: {
            evidence_type: 'internal_policy',
            rule_id: rule.id,
            contract_anchor_status: anchor ? 'matched' : 'missing_control',
        },
    };
    const suggestion = {
        issue_id: issueId,
        risk_id: issueId,
        rule_id: rule.id,
        scenario_id: rule.scenario_id,
        severity: rule.severity,
        source_type: 'thinkpark_internal_policy',
        issue_type: '合规瑕疵',
        operation: anchor ? 'replace' : 'append',
        title: rule.title,
        current_clause: anchor || '合同未约定',
        original_text: anchor || '合同未约定',
        basis,
        reason: rule.description,
        suggested_text: rule.suggested_text,
        anchor_hint: anchor ? anchor.slice(0, 48) : '',
    };
    return { finding, suggestion };
};

const evaluateBusinessRules = ({ text = '', perspective = '', contractType = '', templateId = '' } = {}) => {
    const normalizedText = compact(text);
    const scenarios = detectBusinessScenarios({ text, perspective, contractType, templateId });
    const applicableScenarioIds = new Set(scenarios.map((item) => item.id));
    const findings = [];
    const suggestions = [];
    const evaluated = [];

    for (const rule of policy.rules) {
        if (!applicableScenarioIds.has(rule.scenario_id)) continue;
        let anchor = '';
        let matched = false;
        if (rule.kind === 'clause_match') {
            anchor = findMatchedClause(text, rule);
            matched = Boolean(anchor);
        } else if (rule.kind === 'missing_control') {
            const triggered = includesAny(normalizedText, rule.trigger_any);
            const controlPresent = includesAny(normalizedText, rule.required_any);
            matched = triggered && !controlPresent;
        }
        evaluated.push({ rule_id: rule.id, matched });
        if (!matched) continue;
        const materialized = materializeRule(rule, anchor);
        findings.push(materialized.finding);
        suggestions.push(materialized.suggestion);
    }

    return {
        policy_version: policy.version,
        scenarios,
        compliance_findings: findings,
        modification_suggestions: suggestions,
        audit: {
            evaluated_count: evaluated.length,
            matched_count: findings.length,
            matched_rule_ids: findings.map((item) => item.rule_id),
        },
    };
};

const riskKey = (item) => item.issue_id || item.risk_id || item.rule_id
    || compact(`${item.issue_type || ''}|${item.title || ''}|${item.original_clause || item.current_clause || ''}`);

const isSemanticDuplicate = (left, right) => {
    const leftTitle = compact(left?.title);
    const rightTitle = compact(right?.title);
    const leftAnchor = compact(left?.original_clause || left?.current_clause);
    const rightAnchor = compact(right?.original_clause || right?.current_clause);
    const sameTitle = Math.min(leftTitle.length, rightTitle.length) >= 4
        && (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle));
    const sameAnchor = leftAnchor === rightAnchor
        || leftAnchor === compact('合同未约定')
        || rightAnchor === compact('合同未约定');
    return sameTitle && sameAnchor;
};

const mergeBusinessRuleResults = (analysisResult, businessResult, maxItems = 24) => {
    const result = analysisResult && typeof analysisResult === 'object' ? analysisResult : {};
    const businessFindings = businessResult?.compliance_findings || [];
    const businessSuggestions = businessResult?.modification_suggestions || [];
    const merge = (base, additions) => {
        const seen = new Set();
        const output = [];
        for (const item of [...additions, ...(Array.isArray(base) ? base : [])]) {
            const key = riskKey(item);
            if (!key || seen.has(key) || output.some((existing) => isSemanticDuplicate(existing, item))) continue;
            seen.add(key);
            output.push(item);
            if (output.length >= maxItems) break;
        }
        return output;
    };
    const complianceFindings = merge(result.compliance_findings || result.dispute_points, businessFindings);
    return {
        ...result,
        compliance_findings: complianceFindings,
        dispute_points: complianceFindings,
        modification_suggestions: merge(result.modification_suggestions, businessSuggestions),
        business_rule_review: {
            policy_version: businessResult?.policy_version || policy.version,
            scenarios: businessResult?.scenarios || [],
            audit: businessResult?.audit || { evaluated_count: 0, matched_count: 0, matched_rule_ids: [] },
        },
    };
};

module.exports = {
    detectBusinessScenarios,
    evaluateBusinessRules,
    mergeBusinessRuleResults,
};
