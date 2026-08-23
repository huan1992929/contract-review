/**
 * @file services/initialRiskLedger.js
 * @brief 首次/全量合同审查的稳定风险台账投影与持久化。
 *
 * 本服务不参与风险判断，只把已完成归一化的 analysis_result 投影到
 * review_runs / review_issues。旧客户端仍以 analysis_result.dispute_points 为准，
 * 因此这是可回滚的兼容性扩展，不改写历史 JSON 结构。
 */

const crypto = require('crypto');
const {
    attachRiskIdentity,
    reconcileRiskLedger,
    scopeRiskIssueKey,
} = require('./incrementalReview');

const asArray = (value) => (Array.isArray(value) ? value : []);

const parsePayload = (value) => {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '{}');
    } catch (_error) {
        return {};
    }
};

const anchorOf = (item = {}) => String(
    item.original_clause || item.current_clause || item.original_text || item.contract_clause || '',
).trim();

const titleOf = (item = {}, fallback = '合同待优化项') => String(
    item.title || item.review_point || item.description || item.type || fallback,
).trim();

const suggestionMatches = (risk, suggestion) => {
    const riskAnchor = anchorOf(risk);
    const suggestionAnchor = anchorOf(suggestion);
    if (riskAnchor && suggestionAnchor
        && (riskAnchor.includes(suggestionAnchor) || suggestionAnchor.includes(riskAnchor))) return true;
    const riskTitle = titleOf(risk, '');
    const suggestionTitle = titleOf(suggestion, '');
    return Boolean(riskTitle && suggestionTitle
        && (riskTitle.includes(suggestionTitle) || suggestionTitle.includes(riskTitle)));
};

/**
 * 将现有全量审查输出归一化为台账候选项。
 * compliance_findings/dispute_points 是同一组数据的新旧别名，先合并再由
 * reconcileRiskLedger 用指纹去重。硬性规则与缺失条款也是真实风险，必须入账。
 */
const collectInitialRiskCandidates = (analysisResult = {}) => {
    const result = parsePayload(analysisResult);
    const suggestions = asArray(result.modification_suggestions);
    const candidates = [
        ...asArray(result.dispute_points).map((item) => ({ ...item, source_bucket: item.source_bucket || 'compliance_finding' })),
        ...asArray(result.compliance_findings).map((item) => ({ ...item, source_bucket: item.source_bucket || 'compliance_finding' })),
        ...asArray(result.missing_clauses).map((item) => ({
            ...item,
            title: titleOf(item, '缺失必要条款'),
            original_clause: anchorOf(item) || '合同未约定',
            issue_type: item.issue_type || '缺失条款',
            severity: item.severity || 'medium',
            source_bucket: item.source_bucket || 'missing_clause',
        })),
        ...asArray(result.hard_violations).map((item) => ({
            ...item,
            title: titleOf(item, '思库内部风控规则'),
            original_clause: anchorOf(item) || String(item.matched_text || '合同整体').trim(),
            issue_type: item.issue_type || '内部风控规则',
            risk_code: item.risk_code || item.rule_id || item.id,
            severity: item.severity || 'high',
            source_bucket: item.source_bucket || 'internal_policy',
        })),
    ];

    return candidates.map((risk) => {
        const suggestion = suggestions.find((item) => suggestionMatches(risk, item));
        return {
            ...risk,
            title: titleOf(risk),
            original_clause: anchorOf(risk) || '合同整体',
            severity: risk.severity || risk.risk_level || 'medium',
            suggested_text: risk.suggested_text || suggestion?.suggested_text || suggestion?.suggestion || '',
            modification_suggestion: suggestion || risk.modification_suggestion || null,
        };
    });
};

const rowToIssue = (row = {}) => {
    const payload = parsePayload(row.payload);
    return {
        ...payload,
        issue_id: row.issue_key || payload.issue_id,
        risk_fingerprint: row.fingerprint || payload.risk_fingerprint,
        clause_id: row.clause_id || payload.clause_id,
        issue_status: row.status || payload.issue_status || 'open',
        resolved_at: row.resolved_at || payload.resolved_at || null,
    };
};

const buildInitialLedgerProjection = ({ contractId, analysisResult, existingRows = [], reviewedAt }) => {
    const existingPoints = asArray(existingRows).map(rowToIssue);
    const candidates = collectInitialRiskCandidates(analysisResult);
    const ledger = reconcileRiskLedger({
        contractId,
        existingPoints,
        newPoints: candidates,
        diffs: [],
        reviewedAt,
    });
    return {
        ...ledger,
        candidates,
        issues: ledger.issues.map((issue) => attachRiskIdentity(issue, contractId, [])),
    };
};

/**
 * 持久化一次全量审查。调用方可传入现有 trx，与 contracts 结果保存保持原子性。
 * 未传 trx 时使用 db.transaction，便于后台补录和测试工具调用。
 */
const persistInitialRiskLedger = async ({
    db,
    trx: suppliedTrx,
    contractId,
    userId,
    analysisResult,
    reviewedAt = new Date().toISOString(),
}) => {
    if (!db && !suppliedTrx) throw new Error('db or trx is required');
    if (!contractId) throw new Error('contractId is required');

    const execute = async (trx) => {
        const existingRows = await trx('review_issues').where({ contract_id: contractId }).orderBy('id', 'asc');
        const projection = buildInitialLedgerProjection({ contractId, analysisResult, existingRows, reviewedAt });
        const runKey = crypto.randomUUID();
        const inserted = await trx('review_runs').insert({
            run_key: runKey,
            contract_id: contractId,
            user_id: Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : null,
            from_version_no: null,
            status: 'completed',
            diff_summary: {
                mode: 'full_review',
                detected: projection.candidates.length,
                persisted: projection.issues.length,
            },
            reviewed_at: reviewedAt,
        }).returning('id');
        const runId = Number(inserted[0]?.id ?? inserted[0]);

        for (const issue of projection.issues) {
            const row = {
                issue_key: scopeRiskIssueKey(contractId, issue.issue_id),
                contract_id: contractId,
                fingerprint: issue.risk_fingerprint,
                clause_id: issue.clause_id,
                status: issue.issue_status,
                title: titleOf(issue).slice(0, 512),
                original_clause: anchorOf(issue) || null,
                payload: issue,
                first_seen_run_id: runId,
                last_seen_run_id: runId,
                resolved_at: issue.resolved_at || null,
                updated_at: trx.fn.now(),
            };
            await trx('review_issues').insert(row)
                .onConflict(['contract_id', 'fingerprint'])
                .merge({
                    issue_key: row.issue_key,
                    clause_id: row.clause_id,
                    status: row.status,
                    title: row.title,
                    original_clause: row.original_clause,
                    payload: row.payload,
                    last_seen_run_id: runId,
                    resolved_at: row.resolved_at,
                    updated_at: trx.fn.now(),
                });
        }
        return { runId, runKey, ...projection };
    };

    return suppliedTrx ? execute(suppliedTrx) : db.transaction(execute);
};

module.exports = {
    collectInitialRiskCandidates,
    buildInitialLedgerProjection,
    persistInitialRiskLedger,
};
