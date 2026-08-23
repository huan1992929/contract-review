/**
 * @file services/contractAnalysis/holisticReview.js
 * @brief 全文合同审核的紧凑风险规划、知识依据核验与最终整体裁决。
 *
 * 全文正文只用于理解合同关系；正式风险仍必须同时具备合同锚点和本次
 * WeKnora 检索依据。模型只返回知识序号，服务端再回填权威来源，避免
 * 大段证据在 JSON 中重复生成并触发网关超时。
 */
const crypto = require('crypto');

const MAX_HOLISTIC_CANDIDATES = 12;
const MAX_GROUNDED_ISSUES = 12;

const asArray = (value) => (Array.isArray(value) ? value : []);
const compact = (value) => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const stableIssueId = (title, anchors = []) => {
    const payload = `${compact(title)}|${anchors.map(compact).filter(Boolean).sort().join('|')}`;
    return `tp-holistic-${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
};

const anchoredInContract = (text, plainText) => {
    const anchor = compact(text);
    return anchor.length >= 6 && compact(plainText).includes(anchor);
};

const normalizeSeverity = (value) => {
    const normalized = String(value || '').toLowerCase();
    if (['high', '高', '高风险'].includes(normalized)) return 'high';
    if (['low', '低', '低风险'].includes(normalized)) return 'low';
    return 'medium';
};

const normalizeIssueType = (value) => {
    const allowed = new Set(['范本差异', '合规瑕疵', '计算错误', '文本错误']);
    return allowed.has(value) ? value : '范本差异';
};

const normalizeHolisticPlan = (rawPlan, plainText) => {
    const source = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    const seen = new Set();
    const candidates = [];
    for (const item of asArray(source.candidate_issues)) {
        const title = String(item?.title || '').trim();
        if (!title) continue;
        const anchors = asArray(item.anchors || item.related_clauses)
            .map((entry) => String(entry?.text || entry || '').trim())
            .filter((entry) => anchoredInContract(entry, plainText))
            .slice(0, 6);
        const missingControl = Boolean(item.missing_control);
        if (!anchors.length && !missingControl) continue;
        const key = compact(`${title}|${anchors.join('|')}|${missingControl}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const issueId = stableIssueId(title, anchors.length ? anchors : ['合同未约定']);
        candidates.push({
            issue_id: issueId,
            title,
            issue_type: normalizeIssueType(item.issue_type),
            proposed_severity: normalizeSeverity(item.severity),
            clause_refs: asArray(item.clause_refs).map(String).filter(Boolean).slice(0, 8),
            anchors,
            missing_control: missingControl,
            reason: String(item.reason || '').trim(),
            knowledge_query: String(item.knowledge_query || title).trim().slice(0, 500),
        });
        if (candidates.length >= MAX_HOLISTIC_CANDIDATES) break;
    }
    return {
        contract_summary: String(source.contract_summary || '').trim().slice(0, 2000),
        party_alignment: source.party_alignment && typeof source.party_alignment === 'object'
            ? source.party_alignment
            : {},
        candidates,
    };
};

const selectBasis = (basisRefs, knowledge) => {
    const output = [];
    const seen = new Set();
    for (const rawRef of asArray(basisRefs)) {
        const index = Number(rawRef?.index ?? rawRef) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= knowledge.length || seen.has(index)) continue;
        seen.add(index);
        const item = knowledge[index];
        output.push({
            source_type: item.source_type || 'weknora',
            source_id: item.source_id || item.id || item.chunk_id || '',
            document_id: item.document_id || item.metadata?.document_id || '',
            title: item.law || item.title || item.source_name || '思库法务助手知识库',
            clause: item.clause || item.clause_id || '',
            content: item.content || '',
            metadata: item.metadata || {},
        });
        if (output.length >= 4) break;
    }
    return output;
};

const normalizeChange = (item, plainText) => {
    const operation = item?.operation === 'append' ? 'append' : 'replace';
    const currentClause = String(item?.current_clause || item?.original_text || '').trim();
    const suggestedText = String(item?.suggested_text || '').trim();
    if (!suggestedText) return null;
    if (operation === 'replace' && !anchoredInContract(currentClause, plainText)) return null;
    if (operation === 'append' && currentClause && currentClause !== '合同未约定'
        && !anchoredInContract(currentClause, plainText)) return null;
    if (compact(suggestedText).length >= 8 && compact(plainText).includes(compact(suggestedText))) return null;
    return {
        operation,
        clause_id: String(item?.clause_id || '').trim(),
        current_clause: currentClause || '合同未约定',
        original_text: currentClause || '合同未约定',
        suggested_text: suggestedText,
        anchor_hint: String(item?.anchor_hint || currentClause).trim().slice(0, 120),
    };
};

const materializeGroundedIssue = ({ rawIssue, candidate, knowledge, plainText }) => {
    if (!rawIssue || rawIssue.accepted !== true) return null;
    const basis = selectBasis(rawIssue.basis_refs, knowledge);
    if (!basis.length) return null;
    const changes = asArray(rawIssue.changes).map((item) => normalizeChange(item, plainText)).filter(Boolean);
    if (!changes.length) return null;
    const title = String(rawIssue.title || candidate.title).trim() || candidate.title;
    const primary = changes[0];
    const issueId = candidate.issue_id;
    const severity = normalizeSeverity(rawIssue.severity || candidate.proposed_severity);
    const description = String(rawIssue.description || rawIssue.reason || candidate.reason).trim();
    const finding = {
        issue_id: issueId,
        risk_id: issueId,
        issue_type: normalizeIssueType(rawIssue.issue_type || candidate.issue_type),
        title,
        severity,
        original_clause: primary.current_clause,
        related_clauses: changes.map((item) => ({
            clause_id: item.clause_id,
            text: item.current_clause,
        })),
        cross_clause: changes.length > 1,
        basis,
        description,
        plain_language: String(rawIssue.plain_language || description).trim(),
        source_bucket: 'holistic_grounded_review',
    };
    const suggestion = {
        issue_id: issueId,
        risk_id: issueId,
        issue_type: finding.issue_type,
        title,
        severity,
        operation: primary.operation,
        current_clause: primary.current_clause,
        original_text: primary.original_text,
        suggested_text: primary.suggested_text,
        anchor_hint: primary.anchor_hint,
        basis,
        reason: description,
        linked_changes: changes,
        source_bucket: 'holistic_grounded_review',
    };
    return { issue_id: issueId, finding, suggestion };
};

const dedupeChanges = (changes) => {
    const seen = new Set();
    const output = [];
    for (const item of changes) {
        const key = compact(`${item.operation}|${item.current_clause}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }
    return output;
};

const mergeGroundedIssues = (target, source) => {
    const targetChanges = asArray(target.suggestion.linked_changes);
    const sourceChanges = asArray(source.suggestion.linked_changes);
    const linkedChanges = dedupeChanges([...targetChanges, ...sourceChanges]);
    const basisSeen = new Set();
    const basis = [...asArray(target.finding.basis), ...asArray(source.finding.basis)].filter((item) => {
        const key = String(item.source_id || `${item.title}|${item.content}`);
        if (!key || basisSeen.has(key)) return false;
        basisSeen.add(key);
        return true;
    }).slice(0, 6);
    return {
        ...target,
        finding: {
            ...target.finding,
            cross_clause: linkedChanges.length > 1,
            related_clauses: linkedChanges.map((item) => ({ clause_id: item.clause_id, text: item.current_clause })),
            basis,
        },
        suggestion: {
            ...target.suggestion,
            basis,
            linked_changes: linkedChanges,
        },
    };
};

const applyHolisticAdjudication = (issues, rawAdjudication) => {
    const decisions = new Map(asArray(rawAdjudication?.decisions).map((item) => [
        String(item?.issue_id || ''),
        item,
    ]));
    const output = new Map();
    for (const issue of issues) {
        const decision = decisions.get(issue.issue_id);
        if (!decision || decision.decision === 'reject') continue;
        if (decision.decision === 'merge') continue;
        const severity = normalizeSeverity(decision.severity || issue.finding.severity);
        output.set(issue.issue_id, {
            ...issue,
            finding: { ...issue.finding, severity, final_reason: String(decision.reason || '') },
            suggestion: { ...issue.suggestion, severity },
        });
    }
    for (const issue of issues) {
        const decision = decisions.get(issue.issue_id);
        if (!decision || decision.decision !== 'merge') continue;
        const targetId = String(decision.merge_into || '');
        const target = output.get(targetId);
        if (!target || targetId === issue.issue_id) continue;
        output.set(targetId, mergeGroundedIssues(target, issue));
    }
    return [...output.values()].slice(0, MAX_GROUNDED_ISSUES);
};

const buildHolisticAnalysisResult = ({ plan, issues, audit = {} }) => {
    const findings = issues.map((item) => item.finding);
    const suggestions = issues.map((item) => item.suggestion);
    return {
        review_mode: 'holistic',
        holistic_review: {
            version: 1,
            contract_summary: plan.contract_summary,
            party_alignment: plan.party_alignment,
            candidate_count: plan.candidates.length,
            grounded_count: issues.length,
            ...audit,
        },
        core_information: { cost_business: [], legal_compliance: [] },
        template_differences: [],
        compliance_findings: findings,
        dispute_points: findings,
        missing_clauses: [],
        party_review: [{
            title: '全文主体与交易方向确认',
            description: plan.contract_summary,
            plain_language: plan.contract_summary,
            ...plan.party_alignment,
        }],
        modification_suggestions: suggestions,
        breach_cost_analysis: [],
        text_errors: [],
        calculation_errors: [],
        seal_analysis: [],
        relevant_laws: [],
        company_review: [],
        grounding_audit: {
            version: 3,
            finding_counts: {
                input: plan.candidates.length,
                accepted: findings.length,
                rejected: Math.max(0, plan.candidates.length - findings.length),
            },
            suggestion_counts: {
                input: plan.candidates.length,
                accepted: suggestions.length,
                rejected: Math.max(0, plan.candidates.length - suggestions.length),
            },
            rejected: [],
        },
    };
};

module.exports = {
    MAX_HOLISTIC_CANDIDATES,
    normalizeHolisticPlan,
    materializeGroundedIssue,
    applyHolisticAdjudication,
    buildHolisticAnalysisResult,
    stableIssueId,
};
