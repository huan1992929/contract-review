/**
 * @file services/incrementalReview.js
 * @brief 条款级增量审查服务，仅对变更条款调 LLM 审查并标记已解决风险
 *
 * 核心职责：
 * - 对比新旧版本合同条款树，按 clause_id 产出条款级 diff
 * - 对 needs_review 的变更条款独立调 LLM 审查
 * - 与历史风险点对比，标记已解决风险
 *
 * 关键实现：
 * - 字符 bigram Jaccard 相似度判定 modified/added/deleted
 * - 相似度<=0.5 视为旧条删除+新条新增
 * - chunk 并发限流（每批 3 条），避免 LLM 并发过高
 * - 已解决风险判定：original_clause 曾在旧版且不再在新版
 *
 * 依赖关系：
 * - 上游：contractParser、llmClient、database
 * - 下游：合同修订审查接口调用 runIncrementalReview
 */

const { parseContractTree } = require('./contractParser');
const { createChatCompletion } = require('./llmClient');
const { getRelevantKnowledge } = require('./contractAnalysis/knowledge');
const crypto = require('crypto');

/**
 * 计算两段文本的字符级相似度（0-1）。
 * 采用字符 bigram 的 Jaccard 相似度：交集 bigram 数 / 并集 bigram 数。
 * 相比单字符集合，bigram 保留了部分顺序信息，更贴近"文本是否相近"的语义。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const textSimilarity = (a, b) => {
    const s1 = String(a || '');
    const s2 = String(b || '');
    if (s1 === s2) return 1;
    if (!s1.length || !s2.length) return 0;

    const toBigrams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i += 1) {
            set.add(s.slice(i, i + 2));
        }
        return set;
    };
    const bigrams1 = toBigrams(s1);
    const bigrams2 = toBigrams(s2);

    let inter = 0;
    for (const g of bigrams1) {
        if (bigrams2.has(g)) inter += 1;
    }
    const union = bigrams1.size + bigrams2.size - inter;
    return union === 0 ? 0 : inter / union;
};

/**
 * 对比两个版本合同的条款树，按 clause_id 匹配，产出条款级 diff。
 * - 文本完全相同：跳过（不产出 diff）。
 * - clause_id 匹配且相似度 > 0.5：modified。
 * - clause_id 匹配但相似度 <= 0.5：视为旧条删除 + 新条新增（两条记录）。
 * - 仅新版有：added。仅旧版有：deleted。
 * @param {string} oldText 旧版合同纯文本
 * @param {string} newText 新版合同纯文本
 * @returns {Array<{clause_id:string,change_type:'modified'|'added'|'deleted',old_text:string,new_text:string,needs_review:boolean}>}
 */
const diffClauses = (oldText, newText) => {
    const oldClauses = parseContractTree(oldText);
    const newClauses = parseContractTree(newText);

    const oldMap = new Map(oldClauses.map((c) => [c.clause_id, c]));
    const newMap = new Map(newClauses.map((c) => [c.clause_id, c]));

    const diffs = [];
    const seenIds = new Set();

    // 先遍历新版条款：判定 modified 或 added
    for (const newClause of newClauses) {
        seenIds.add(newClause.clause_id);
        const oldClause = oldMap.get(newClause.clause_id);
        if (!oldClause) {
            // 旧版无此条款 → 新增
            diffs.push({
                clause_id: newClause.clause_id,
                change_type: 'added',
                old_text: '',
                new_text: newClause.text,
                needs_review: true,
            });
            continue;
        }
        if (oldClause.text === newClause.text) {
            // 文本未变，无需 diff
            continue;
        }
        const sim = textSimilarity(oldClause.text, newClause.text);
        if (sim > 0.5) {
            // 相似度高 → 修改
            diffs.push({
                clause_id: newClause.clause_id,
                change_type: 'modified',
                old_text: oldClause.text,
                new_text: newClause.text,
                needs_review: true,
            });
        } else {
            // 相似度过低，视为内容整体替换：旧条删除 + 新条新增
            diffs.push({
                clause_id: newClause.clause_id,
                change_type: 'added',
                old_text: '',
                new_text: newClause.text,
                needs_review: true,
            });
            diffs.push({
                clause_id: oldClause.clause_id,
                change_type: 'deleted',
                old_text: oldClause.text,
                new_text: '',
                needs_review: false,
            });
        }
    }

    // 再遍历旧版条款：新版已无 → 删除
    for (const oldClause of oldClauses) {
        if (!seenIds.has(oldClause.clause_id)) {
            diffs.push({
                clause_id: oldClause.clause_id,
                change_type: 'deleted',
                old_text: oldClause.text,
                new_text: '',
                needs_review: false,
            });
        }
    }

    return diffs;
};

// 去除 LLM 返回中的 markdown / think 标记后解析 JSON
const cleanJsonResponse = (text) => {
    const clean = String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/```json|```/g, '')
        .trim();
    return JSON.parse(clean);
};

// 构造单条款增量审查 prompt（复用整篇审查风格，但只审查单个变更条款）
const buildClauseReviewPrompt = (diff, template, knowledge = []) => {
    const tmpl = template || {};
    const reviewPoints = (tmpl.review_points || []).join('；');
    const corePurposes = (tmpl.core_purposes || []).join('；');
    const promptRules = (tmpl.prompt_rules || []).join('；');
    const changeType = diff.change_type;

    const oldPart = changeType === 'modified'
        ? `变更前条款原文：\n---\n${diff.old_text}\n---\n`
        : '';
    const knowledgeContext = knowledge.map((item, index) => (
        `[${index + 1}] [${item.source_type}] ${item.law} ${item.clause || ''}：${item.content}`
    )).join('\n') || '未检索到直接依据。';

    return `你是一名资深法务专家，正在对合同进行条款级增量审查。当前只需审查以下发生变更的单个条款，识别本次变更引入或仍存在的法律风险，并只输出 JSON。

审查模板：
- 模板名称：${tmpl.name || '通用合同审查模板'}
- 审查点：${reviewPoints || '无'}
- 审查目的：${corePurposes || '无'}
- 模板规则：${promptRules || '无'}

变更类型：${changeType}
${oldPart}当前条款原文：
---
${diff.new_text}
---

思库法务助手知识库依据（只能引用以下内容）：
${knowledgeContext}

输出 JSON 结构（仅输出与该条款相关且有知识库直接依据的待优化项，无则空数组）：
{
  "dispute_points": [{"title":"待优化项标题","original_clause":"合同原文中的完整句子或段落","basis":[{"source_type":"weknora/law/case/template/review_rule","title":"知识库依据标题","content":"依据原文"}],"legal_reference":"知识库依据标题","suggestion":"修改建议"}]
}

硬性要求：
- original_clause 必须逐字摘录当前条款原文中的完整句子或段落，不得改写，用于后续定位与比对。
- 每一项 basis 必须逐字引用本次提供的知识库依据标题和原文；未检索到直接依据时 dispute_points 必须为空。
- 如果修改后的条款已经落实建议，不得再次报告原问题；不得把一般最佳实践、措辞偏好或模型记忆当作新风险。
- 同一实质问题只保留一项，当前条款最多输出 3 项。
- 仅审查给定条款，不要涉及合同其他条款。
- 不输出高、中、低风险等级或任何同义分级。
- 不输出自然语言解释，不输出 markdown，只输出 JSON。`;
};

const compactForMatch = (value) => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const ACTIVE_RISK_STATUSES = new Set(['open', 'proposed']);
const STICKY_RISK_STATUSES = new Set(['pending_review', 'resolved', 'accepted_risk']);

/**
 * Normalize legacy booleans and revision application states into the issue-ledger vocabulary.
 * Rejected revisions mean the user consciously retained the risk; they are not open findings.
 */
const normalizeRiskStatus = (point = {}) => {
    const raw = String(point.issue_status || point.status || point.application_status || '')
        .trim().toLowerCase().replace(/-/g, '_');
    if (['pending_review', 'review_pending', 'pending_confirmation'].includes(raw) || point.review_pending === true) {
        return 'pending_review';
    }
    if (['rejected', 'declined', 'accepted_risk'].includes(raw) || point.rejected === true) {
        return 'accepted_risk';
    }
    if (['accepted', 'approved', 'applied', 'effective', 'completed', 'resolved'].includes(raw)
        || point.resolved === true || point.adopted === true) {
        return 'resolved';
    }
    if (raw === 'superseded' || raw === 'obsolete') return raw;
    if (raw === 'proposed') return 'proposed';
    return 'open';
};

const inferClauseId = (point, diffs = []) => {
    if (String(point?.clause_id || '').trim()) return String(point.clause_id).trim();
    const anchor = String(point?.original_clause || point?.original_text || '').trim();
    if (!anchor) return 'contract';
    const matched = diffs.find((diff) => String(diff.old_text || '').includes(anchor)
        || String(diff.new_text || '').includes(anchor));
    return matched?.clause_id ? String(matched.clause_id) : 'contract';
};

const riskFingerprint = (point = {}, diffs = []) => {
    const clauseId = compactForMatch(inferClauseId(point, diffs)) || 'contract';
    // Prefer a governed code when available; otherwise title+structural clause is the stable legacy identity.
    // Do not include optional issue_type, evidence text or original wording: those legitimately drift on re-review.
    const semanticKey = compactForMatch(
        point.risk_code || point.title || point.review_point || point.type || point.original_clause || 'untitled',
    );
    return crypto.createHash('sha256')
        .update(`risk-ledger-v1|${clauseId}|${semanticKey}`)
        .digest('hex');
};

const attachRiskIdentity = (point = {}, contractId, diffs = []) => {
    const fingerprint = point.risk_fingerprint || riskFingerprint(point, diffs);
    const issueId = point.issue_id || `risk_${crypto.createHash('sha256')
        .update(`${contractId}|${fingerprint}`)
        .digest('hex').slice(0, 32)}`;
    const status = normalizeRiskStatus(point);
    return {
        ...point,
        issue_id: issueId,
        risk_fingerprint: fingerprint,
        clause_id: inferClauseId(point, diffs),
        issue_status: status,
        resolved: status === 'resolved',
        review_pending: status === 'pending_review',
        accepted_risk: status === 'accepted_risk',
    };
};

const affectedByDiff = (point, diffs) => {
    const anchor = String(point.original_clause || point.original_text || '').trim();
    const clauseId = String(point.clause_id || '').trim();
    return diffs.some((diff) => (clauseId && clauseId !== 'contract' && String(diff.clause_id) === clauseId)
        || (anchor && (String(diff.old_text || '').includes(anchor) || String(diff.new_text || '').includes(anchor))));
};

/**
 * Merge a re-review into a stable issue ledger. Existing accepted/rejected/pending decisions are sticky,
 * unchanged findings are carried forward, and model duplicates are collapsed server-side.
 */
const reconcileRiskLedger = ({ contractId, existingPoints = [], newPoints = [], diffs = [], reviewedAt }) => {
    const timestamp = reviewedAt || new Date().toISOString();
    const byFingerprint = new Map();

    for (const raw of existingPoints) {
        const point = attachRiskIdentity(raw, contractId, diffs);
        const previous = byFingerprint.get(point.risk_fingerprint);
        if (!previous || (STICKY_RISK_STATUSES.has(point.issue_status)
            && !STICKY_RISK_STATUSES.has(previous.issue_status))) {
            byFingerprint.set(point.risk_fingerprint, point);
        }
    }

    const seenThisRun = new Set();
    const insertedFingerprints = new Set();
    for (const raw of newPoints) {
        const candidate = attachRiskIdentity(raw, contractId, diffs);
        if (seenThisRun.has(candidate.risk_fingerprint)) continue;
        seenThisRun.add(candidate.risk_fingerprint);
        const existing = byFingerprint.get(candidate.risk_fingerprint);
        if (existing) {
            // A human decision remains authoritative. Refresh evidence/anchor, but never resurrect it.
            const status = STICKY_RISK_STATUSES.has(existing.issue_status)
                ? existing.issue_status
                : 'open';
            byFingerprint.set(candidate.risk_fingerprint, attachRiskIdentity({
                ...existing,
                ...candidate,
                issue_id: existing.issue_id,
                issue_status: status,
                first_seen_at: existing.first_seen_at,
                last_seen_at: timestamp,
            }, contractId, diffs));
            continue;
        }
        insertedFingerprints.add(candidate.risk_fingerprint);
        byFingerprint.set(candidate.risk_fingerprint, {
            ...candidate,
            issue_status: 'open',
            first_seen_at: timestamp,
            last_seen_at: timestamp,
            isNewIncremental: true,
        });
    }

    const resolved = [];
    for (const [fingerprint, point] of byFingerprint.entries()) {
        if (seenThisRun.has(fingerprint) || !ACTIVE_RISK_STATUSES.has(point.issue_status)) continue;
        if (!affectedByDiff(point, diffs)) continue;
        const anchor = String(point.original_clause || point.original_text || '').trim();
        const remains = anchor && diffs.some((diff) => String(diff.new_text || '').includes(anchor));
        if (!remains) {
            point.issue_status = 'resolved';
            point.resolved = true;
            point.review_pending = false;
            point.resolved_at = timestamp;
            point.last_seen_at = timestamp;
            resolved.push(point);
        }
    }

    const issues = Array.from(byFingerprint.values());
    return {
        issues,
        newRisks: issues.filter((point) => insertedFingerprints.has(point.risk_fingerprint)),
        resolvedRisks: resolved,
    };
};

const filterGroundedIncrementalPoints = (points, clauseText, knowledge) => {
    const text = compactForMatch(clauseText);
    const seen = new Set();
    return (Array.isArray(points) ? points : []).filter((point) => {
        const anchor = compactForMatch(point.original_clause);
        if (anchor.length < 6 || !text.includes(anchor)) return false;
        const basis = compactForMatch(JSON.stringify(point.basis || point.legal_reference || ''));
        const grounded = (knowledge || []).some((item) => {
            const title = compactForMatch(item.law || item.source_name);
            const content = compactForMatch(item.content);
            return (title.length >= 4 && basis.includes(title))
                || (content.length >= 12 && basis.includes(content.slice(0, 24)));
        });
        if (!grounded) return false;
        const suggestion = compactForMatch(point.suggestion);
        if (suggestion.length >= 8 && text.includes(suggestion)) return false;
        const key = compactForMatch((point.title || '') + '|' + (point.original_clause || ''));
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 3);
};

/**
 * 对 diffClauses 中 needs_review=true 的条款独立调 LLM 审查，
 * 并与历史风险点对比，标记已解决风险。
 * @param {number|string} contractId 合同 ID
 * @param {Array} diffClauses diffClauses() 的返回值
 * @param {Array} originalDisputePoints 历史审查的 dispute_points（含 original_clause、title）
 * @param {{template?:object, userId?:string}} options 审查模板与用户
 * @returns {Promise<{diff_clauses:Array, new_risks:Array, resolved_risks:Array, reviewed_at:string}>}
 */
const runIncrementalReview = async (contractId, diffClauses, originalDisputePoints, options = {}) => {
    const { template } = options;
    const reviewedAt = new Date().toISOString();
    const diffs = Array.isArray(diffClauses) ? diffClauses : [];
    const origPoints = Array.isArray(originalDisputePoints) ? originalDisputePoints : [];

    // 仅审查 needs_review 且有新文本的条款
    const toReview = diffs.filter((d) => d.needs_review && d.new_text);

    const newRisks = [];
    // 复用项目既有并发限流模式（chunk 并发 3，不引入新依赖）
    const CONCURRENCY = 3;

    const reviewOne = async (diff) => {
        try {
            const knowledge = await getRelevantKnowledge({
                byClause: true,
                clauses: [{
                    clause_id: diff.clause_id,
                    title: diff.clause_id,
                    text: diff.new_text,
                }],
            }, 8);
            if (!knowledge.length) return [];
            const prompt = buildClauseReviewPrompt(diff, template, knowledge);
            const completion = await createChatCompletion({
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
            });
            const parsed = cleanJsonResponse(completion.choices[0].message.content);
            const points = filterGroundedIncrementalPoints(parsed.dispute_points, diff.new_text, knowledge);
            for (const point of points) {
                point.clause_id = diff.clause_id;
            }
            return points;
        } catch (err) {
            console.warn(`[incrementalReview] clause ${diff.clause_id} LLM 审查失败:`, err.message);
            return [];
        }
    };

    for (let i = 0; i < toReview.length; i += CONCURRENCY) {
        const chunk = toReview.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(reviewOne));
        results.forEach((points) => newRisks.push(...points));
    }

    // 判定已解决风险：original_clause 曾存在于旧版变更条款中，
    // 且不再存在于新版变更条款中，视为已解决（"不再存在"语义）。
    const oldTextJoined = diffs
        .filter((d) => d.change_type === 'modified' || d.change_type === 'deleted')
        .map((d) => d.old_text)
        .join('\n');
    const newTextJoined = diffs
        .filter((d) => d.change_type === 'modified' || d.change_type === 'added')
        .map((d) => d.new_text)
        .join('\n');

    const resolvedRisks = [];
    for (const point of origPoints) {
        const oc = point && point.original_clause ? String(point.original_clause) : '';
        if (!oc) continue;
        if (oldTextJoined.includes(oc) && !newTextJoined.includes(oc)) {
            resolvedRisks.push(point.title);
        }
    }

    return {
        diff_clauses: diffs,
        new_risks: newRisks,
        resolved_risks: resolvedRisks,
        reviewed_at: reviewedAt,
    };
};

module.exports = {
    diffClauses,
    runIncrementalReview,
    textSimilarity,
    buildClauseReviewPrompt,
    filterGroundedIncrementalPoints,
    normalizeRiskStatus,
    riskFingerprint,
    attachRiskIdentity,
    reconcileRiskLedger,
};
