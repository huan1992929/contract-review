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
const candidateEvidenceAudit = Symbol('candidateEvidenceAudit');
const adjudicationAudit = Symbol('adjudicationAudit');

const asArray = (value) => (Array.isArray(value) ? value : []);
const compact = (value) => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const contractTextBlocks = (plainText) => String(plainText || '')
    .split(/[\r\n\t]+/u)
    .map(compact)
    .filter(Boolean);

const stableIssueId = (title, anchors = []) => {
    const payload = `${compact(title)}|${anchors.map(compact).filter(Boolean).sort().join('|')}`;
    return `tp-holistic-${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
};

const anchoredInContract = (text, plainText) => {
    const anchor = compact(text);
    if (anchor.length < 6) return false;
    // Mammoth separates DOCX paragraphs and table cells with line breaks. Do
    // not remove those structural boundaries before validating an AI anchor:
    // otherwise a fabricated "label:value" can match two adjacent cells and
    // survive until the paragraph-level writer correctly rejects it.
    return contractTextBlocks(plainText).some((block) => block.includes(anchor));
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
    const existingRevisionText = String(item?.existing_revision_text || '').trim();
    const reviewBaseline = String(item?.review_baseline || '').trim();
    const suggestedText = String(item?.suggested_text || '').trim();
    if (!suggestedText) return { change: null, reason_code: 'SUGGESTED_TEXT_MISSING' };
    if (operation === 'replace' && !anchoredInContract(currentClause, plainText)) {
        return { change: null, reason_code: 'CURRENT_CLAUSE_NOT_FOUND' };
    }
    if (existingRevisionText && !anchoredInContract(existingRevisionText, plainText)) {
        return { change: null, reason_code: 'EXISTING_REVISION_NOT_FOUND' };
    }
    if (reviewBaseline && !anchoredInContract(reviewBaseline, plainText)) {
        return { change: null, reason_code: 'REVIEW_BASELINE_NOT_FOUND' };
    }
    if (operation === 'append' && currentClause && currentClause !== '合同未约定'
        && !anchoredInContract(currentClause, plainText)) {
        return { change: null, reason_code: 'APPEND_ANCHOR_NOT_FOUND' };
    }
    if (compact(suggestedText).length >= 8 && compact(plainText).includes(compact(suggestedText))) {
        return { change: null, reason_code: 'SUGGESTION_ALREADY_PRESENT' };
    }
    return {
        change: {
            operation,
            clause_id: String(item?.clause_id || '').trim(),
            current_clause: currentClause || '合同未约定',
            original_text: currentClause || '合同未约定',
            ...(existingRevisionText ? { existing_revision_text: existingRevisionText } : {}),
            ...(reviewBaseline ? { review_baseline: reviewBaseline } : {}),
            suggested_text: suggestedText,
            anchor_hint: String(item?.anchor_hint || currentClause).trim().slice(0, 120),
        },
        reason_code: '',
    };
};

const recordCandidateEvidenceAudit = (candidate, details) => {
    if (!candidate || typeof candidate !== 'object') return;
    Object.defineProperty(candidate, candidateEvidenceAudit, {
        value: {
            source_stage: 'evidence',
            issue_id: candidate.issue_id || '',
            title: candidate.title || '',
            ...details,
        },
        configurable: true,
    });
};

const materializeGroundedIssue = ({ rawIssue, candidate, knowledge, plainText }) => {
    if (!rawIssue || rawIssue.accepted !== true) {
        recordCandidateEvidenceAudit(candidate, {
            outcome: 'rejected',
            reason_code: rawIssue ? 'EVIDENCE_REJECTED' : 'EVIDENCE_RESPONSE_EMPTY',
            reason: String(rawIssue?.reason || rawIssue?.description
                || (rawIssue ? '知识依据不直接支持该候选风险。' : '证据核验未返回可用结果。')).trim(),
        });
        return null;
    }
    const basis = selectBasis(rawIssue.basis_refs, knowledge);
    if (!basis.length) {
        recordCandidateEvidenceAudit(candidate, {
            outcome: 'rejected',
            reason_code: 'EVIDENCE_BASIS_MISSING',
            reason: '证据核验未引用任何有效知识库依据。',
        });
        return null;
    }
    const normalizedChanges = asArray(rawIssue.changes).map((item) => normalizeChange(item, plainText));
    const changes = normalizedChanges.map((item) => item.change).filter(Boolean);
    if (!changes.length) {
        const changeReasonCodes = [...new Set(normalizedChanges.map((item) => item.reason_code).filter(Boolean))];
        recordCandidateEvidenceAudit(candidate, {
            outcome: 'rejected',
            reason_code: 'EVIDENCE_CHANGE_INVALID',
            reason: '证据核验未生成可安全定位的修订。',
            change_reason_codes: changeReasonCodes,
        });
        return null;
    }
    recordCandidateEvidenceAudit(candidate, {
        outcome: 'accepted',
        reason_code: 'EVIDENCE_ACCEPTED',
        reason: '候选风险已通过知识依据和合同锚点核验。',
    });
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
            ...(item.existing_revision_text ? { existing_revision_text: item.existing_revision_text } : {}),
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
        ...(primary.existing_revision_text ? { existing_revision_text: primary.existing_revision_text } : {}),
        ...(primary.review_baseline ? { review_baseline: primary.review_baseline } : {}),
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
        const key = compact(`${item.operation}|${item.current_clause}|${item.existing_revision_text || ''}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (item.operation === 'append' && changes.some((candidate) => candidate?.operation !== 'append')) {
            // A merged root issue must remain one atomic review operation. When
            // the same protection can already be expressed through located
            // replacements, do not mix an unanchored append lifecycle into it.
            continue;
        }
        const clauseId = compact(item.clause_id || '');
        const currentClause = compact(item.current_clause || item.original_text || '');
        const overlappingIndex = output.findIndex((candidate) => {
            if (candidate.operation !== item.operation) return false;
            if (clauseId && compact(candidate.clause_id || '') !== clauseId) return false;
            const existingClause = compact(candidate.current_clause || candidate.original_text || '');
            return currentClause && existingClause
                && (currentClause.includes(existingClause) || existingClause.includes(currentClause));
        });
        if (overlappingIndex >= 0) {
            const existingClause = compact(output[overlappingIndex].current_clause || output[overlappingIndex].original_text || '');
            if (currentClause.length > existingClause.length) output[overlappingIndex] = item;
            continue;
        }
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
    const audit = [];
    for (const issue of issues) {
        const decision = decisions.get(issue.issue_id);
        if (!decision) {
            audit.push({
                source_stage: 'adjudication',
                outcome: 'rejected',
                reason_code: 'ADJUDICATION_DECISION_MISSING',
                reason: '终审结果缺少该风险的处置决定。',
                issue_id: issue.issue_id,
                title: issue.finding.title,
            });
            continue;
        }
        if (decision.decision === 'reject') {
            audit.push({
                source_stage: 'adjudication',
                outcome: 'rejected',
                reason_code: 'ADJUDICATION_REJECTED',
                reason: String(decision.reason || '终审判定该风险不应保留。'),
                issue_id: issue.issue_id,
                title: issue.finding.title,
            });
            continue;
        }
        if (decision.decision === 'merge') continue;
        const severity = normalizeSeverity(decision.severity || issue.finding.severity);
        output.set(issue.issue_id, {
            ...issue,
            finding: { ...issue.finding, severity, final_reason: String(decision.reason || '') },
            suggestion: { ...issue.suggestion, severity },
        });
        audit.push({
            source_stage: 'adjudication',
            outcome: 'kept',
            reason_code: 'ADJUDICATION_KEPT',
            reason: String(decision.reason || '终审保留该风险。'),
            issue_id: issue.issue_id,
            title: issue.finding.title,
        });
    }
    for (const issue of issues) {
        const decision = decisions.get(issue.issue_id);
        if (!decision || decision.decision !== 'merge') continue;
        const targetId = String(decision.merge_into || '');
        const target = output.get(targetId);
        if (!target || targetId === issue.issue_id) {
            audit.push({
                source_stage: 'adjudication',
                outcome: 'rejected',
                reason_code: 'ADJUDICATION_MERGE_TARGET_INVALID',
                reason: String(decision.reason || '终审合并目标无效，该风险未进入最终结果。'),
                issue_id: issue.issue_id,
                title: issue.finding.title,
                merge_into: targetId,
            });
            continue;
        }
        output.set(targetId, mergeGroundedIssues(target, issue));
        audit.push({
            source_stage: 'adjudication',
            outcome: 'merged',
            reason_code: 'ADJUDICATION_MERGED',
            reason: String(decision.reason || '终审判定与目标风险属于同一根因。'),
            issue_id: issue.issue_id,
            title: issue.finding.title,
            merge_into: targetId,
        });
    }
    const result = [...output.values()].slice(0, MAX_GROUNDED_ISSUES);
    Object.defineProperty(result, adjudicationAudit, { value: audit });
    return result;
};

const buildHolisticAnalysisResult = ({ plan, issues, audit = {} }) => {
    const findings = issues.map((item) => item.finding);
    const suggestions = issues.map((item) => item.suggestion);
    const evidenceAudit = asArray(plan.candidates)
        .map((candidate) => candidate && candidate[candidateEvidenceAudit])
        .filter(Boolean);
    const finalAdjudicationAudit = issues[adjudicationAudit] || [];
    const rejected = [
        ...evidenceAudit.filter((item) => item.outcome === 'rejected'),
        ...finalAdjudicationAudit.filter((item) => item.outcome !== 'kept'),
    ].slice(0, 50);
    const evidenceRejectedCount = evidenceAudit.filter((item) => item.outcome === 'rejected').length;
    const adjudicationRejectedCount = finalAdjudicationAudit.filter((item) => item.outcome === 'rejected').length;
    const mergedCount = finalAdjudicationAudit.filter((item) => item.outcome === 'merged').length;
    return {
        review_mode: 'holistic',
        holistic_review: {
            version: 1,
            contract_summary: plan.contract_summary,
            party_alignment: plan.party_alignment,
            candidate_count: plan.candidates.length,
            grounded_count: issues.length,
            evidence_rejected_count: evidenceRejectedCount,
            adjudication_rejected_count: adjudicationRejectedCount,
            merged_count: mergedCount,
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
            rejected,
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
