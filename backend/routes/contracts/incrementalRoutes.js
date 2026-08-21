/**
 * @file routes/contracts/incrementalRoutes.js
 * @brief 条款级增量审查与谈判博弈模拟路由
 *
 * 核心职责：
 * - review-incremental：对比上一版本仅重审变更条款
 * - simulate-negotiation：批量模拟相对方立场反向论证修改建议
 *
 * 关键实现：
 * - 基于 diffClauses 计算变更条款，无变更则跳过重审
 * - 增量结果追加到 analysis_result.incremental_reviews
 * - 谈判模拟支持按 suggestionIds 过滤目标建议
 *
 * 依赖关系：
 * - 上游：database、services/contractAnalysis（auth、fileExtraction、reportRendering）、services/incrementalReview、services/reviewTemplates、services/webSearch、services/negotiationSimulator
 * - 下游：被 routes/contracts/index.js 注册
 */
const db = require('../../database');
const crypto = require('crypto');
const { requireRequestUserId, findOwnedContract } = require('../../services/contractAnalysis/auth');
const { extractTextFromFile } = require('../../services/contractAnalysis/fileExtraction');
const {
    diffClauses,
    runIncrementalReview,
    reconcileRiskLedger,
    normalizeRiskStatus,
} = require('../../services/incrementalReview');
const { parseJsonField } = require('../../services/contractAnalysis/reportRendering');
const { getTemplateById, matchTemplate } = require('../../services/reviewTemplates');
const { extractCompanyNames } = require('../../services/webSearch');
const { inferCounterpartyPerspective, simulateNegotiationBatch } = require('../../services/negotiationSimulator');

const parseIssuePayload = (row) => {
    const payload = row?.payload && typeof row.payload === 'object'
        ? row.payload
        : parseJsonField(row?.payload, {});
    return {
        ...payload,
        issue_id: row.issue_key || payload.issue_id,
        risk_fingerprint: row.fingerprint || payload.risk_fingerprint,
        clause_id: row.clause_id || payload.clause_id,
        issue_status: row.status || payload.issue_status,
        resolved: row.status === 'resolved',
        review_pending: row.status === 'pending_review',
        accepted_risk: row.status === 'accepted_risk',
        resolved_at: row.resolved_at || payload.resolved_at,
    };
};

const enrichLegacyRiskStatuses = (points, suggestions) => (Array.isArray(points) ? points : []).map((point) => {
    const anchor = String(point.original_clause || '').trim();
    const title = String(point.title || point.type || '').trim();
    const suggestion = (Array.isArray(suggestions) ? suggestions : []).find((item) => {
        const suggestionAnchor = String(item.original_clause || item.original_text || item.current_clause || '').trim();
        const suggestionTitle = String(item.title || item.clause || '').trim();
        return (anchor && suggestionAnchor && (anchor.includes(suggestionAnchor) || suggestionAnchor.includes(anchor)))
            || (title && suggestionTitle && (title.includes(suggestionTitle) || suggestionTitle.includes(title)));
    });
    if (!suggestion) return point;
    return {
        ...point,
        application_status: suggestion.application_status,
        review_pending: suggestion.review_pending,
        rejected: suggestion.rejected,
        adopted: suggestion.adopted,
        issue_status: normalizeRiskStatus(suggestion),
    };
});

const persistRiskLedger = async ({ trx, contract, userId, lastVersion, incrementalResult, analysisResult }) => {
    const runKey = crypto.randomUUID();
    const diffSummary = {
        modified: incrementalResult.diff_clauses.filter((d) => d.change_type === 'modified').length,
        added: incrementalResult.diff_clauses.filter((d) => d.change_type === 'added').length,
        deleted: incrementalResult.diff_clauses.filter((d) => d.change_type === 'deleted').length,
    };
    const inserted = await trx('review_runs').insert({
        run_key: runKey,
        contract_id: contract.id,
        user_id: userId,
        from_version_no: lastVersion?.version_no || null,
        status: 'completed',
        diff_summary: diffSummary,
        reviewed_at: incrementalResult.reviewed_at,
    }).returning('id');
    const runId = Number(inserted[0]?.id ?? inserted[0]);

    for (const issue of incrementalResult.dispute_points) {
        const row = {
            issue_key: issue.issue_id,
            contract_id: contract.id,
            fingerprint: issue.risk_fingerprint,
            clause_id: issue.clause_id,
            status: issue.issue_status,
            title: String(issue.title || issue.type || '').slice(0, 512),
            original_clause: issue.original_clause || null,
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
    await trx('contracts').where({ id: contract.id }).update({
        analysis_result: JSON.stringify(analysisResult),
        updated_at: trx.fn.now(),
    });
    return { runId, runKey, diffSummary };
};

module.exports = function (router) {
    // 3.1 条款级增量审查:对比当前文本与上一审查版本,仅对变更条款重新审查
    router.post('/:id/review-incremental', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const newText = await extractTextFromFile(contract.storage_path);

            // 上一审查版本:取最近一次保存的合同版本快照
            const lastVersion = await db('contract_versions')
                .where({ contract_id: contract.id })
                .orderBy('version_no', 'desc')
                .first();
            const oldText = lastVersion?.plain_text || '';

            const diffs = diffClauses(oldText, newText);
            const needsReview = diffs.filter((d) => d.needs_review);
            if (needsReview.length === 0) {
                return res.json({ message: '无变更,无需重审', diff_clauses: [], new_risks: [], resolved_risks: [], reviewed_at: new Date().toISOString() });
            }

            // 历史风险点 + 模板
            const existing = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
            const persistedRows = await db('review_issues')
                .where({ contract_id: contract.id })
                .orderBy('id', 'asc');
            const persistedPoints = persistedRows.map(parseIssuePayload);
            const legacyPoints = enrichLegacyRiskStatuses(
                existing.dispute_points,
                existing.modification_suggestions,
            );
            // New ledger rows take precedence, while legacy JSON remains a backfill source.
            const origPoints = [...legacyPoints, ...persistedPoints];
            const templateId = req.body?.templateId || existing.template_id || contract.contract_type || null;
            let template = templateId ? await getTemplateById(templateId) : null;
            if (!template) {
                const matchResult = await matchTemplate(contract.contract_type || '', newText);
                template = Array.isArray(matchResult) ? (matchResult[0]?.template || null) : matchResult;
            }

            const rawIncrementalResult = await runIncrementalReview(contract.id, diffs, origPoints, { template });
            const ledger = reconcileRiskLedger({
                contractId: contract.id,
                existingPoints: origPoints,
                newPoints: rawIncrementalResult.new_risks,
                diffs,
                reviewedAt: rawIncrementalResult.reviewed_at,
            });
            const incrementalResult = {
                ...rawIncrementalResult,
                new_risks: ledger.newRisks,
                resolved_risks: ledger.resolvedRisks.map((point) => point.title),
                resolved_issues: ledger.resolvedRisks,
                dispute_points: ledger.issues,
            };

            // 保存到 analysis_result.incremental_reviews(数组,追加本次审查记录)
            const updatedAnalysisResult = { ...existing };
            const reviews = Array.isArray(updatedAnalysisResult.incremental_reviews) ? updatedAnalysisResult.incremental_reviews : [];
            reviews.push({
                reviewed_at: incrementalResult.reviewed_at,
                diff_summary: {
                    modified: incrementalResult.diff_clauses.filter((d) => d.change_type === 'modified').length,
                    added: incrementalResult.diff_clauses.filter((d) => d.change_type === 'added').length,
                    deleted: incrementalResult.diff_clauses.filter((d) => d.change_type === 'deleted').length,
                },
                new_risks: incrementalResult.new_risks,
                resolved_risks: incrementalResult.resolved_risks,
                from_version_no: lastVersion?.version_no || null,
            });
            updatedAnalysisResult.incremental_reviews = reviews;
            // The stable ledger is authoritative; keep the legacy JSON projection for old clients/exports.
            updatedAnalysisResult.dispute_points = ledger.issues;

            const persistedRun = await db.transaction((trx) => persistRiskLedger({
                trx,
                contract,
                userId,
                lastVersion,
                incrementalResult,
                analysisResult: updatedAnalysisResult,
            }));
            incrementalResult.run_id = persistedRun.runId;
            incrementalResult.run_key = persistedRun.runKey;

            res.json(incrementalResult);
        } catch (error) {
            console.error('[ERROR] Incremental review failed:', error);
            res.status(500).json({ error: `增量审查失败:${error.message}` });
        }
    });

    // 4.1 谈判博弈模拟:对修改建议批量模拟对方立场反向论证
    router.post('/:id/simulate-negotiation', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        try {
            const { suggestionIds, suggestion, counterpartyPerspective } = req.body || {};
            const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
            const allSuggestions = Array.isArray(reviewData.modification_suggestions) ? reviewData.modification_suggestions : [];

            // 筛选目标建议:若指定 suggestionIds 则按 id 过滤,否则取全部
            let targetSuggestions = allSuggestions;
            if (suggestion && typeof suggestion === 'object') {
                targetSuggestions = [suggestion];
            } else if (Array.isArray(suggestionIds) && suggestionIds.length) {
                targetSuggestions = allSuggestions.filter((s) => suggestionIds.includes(s.id) || suggestionIds.includes(String(s.id)));
                if (targetSuggestions.length === 0) {
                    return res.status(404).json({ error: '未找到指定的修改建议。' });
                }
            }
            if (targetSuggestions.length === 0) {
                return res.status(400).json({ error: '当前合同没有可推演的修改建议。' });
            }

            // 构造合同上下文
            let plainText = '';
            try {
                plainText = await extractTextFromFile(contract.storage_path);
            } catch (e) {
                console.warn('[Negotiation] extract text failed:', e.message);
            }
            const contractContext = {
                contract_type: contract.contract_type || '',
                summary: plainText.slice(0, 1500),
                user_perspective: contract.perspective || '',
                parties: extractCompanyNames(plainText),
            };
            const counterPerspective = counterpartyPerspective
                || inferCounterpartyPerspective(contractContext.user_perspective, contractContext);

            const results = await simulateNegotiationBatch(targetSuggestions, contractContext, counterPerspective);
            res.json({ counterparty_perspective: counterPerspective, results });
        } catch (error) {
            console.error('[ERROR] Negotiation simulation failed:', error);
            res.status(500).json({ error: `谈判推演失败:${error.message}` });
        }
    });
};
