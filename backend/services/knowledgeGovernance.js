const db = require('../database');
const { importKnowledgeEntries } = require('./vectorStore');
const { toMetadataObject } = require('./vectorStore/documentMapping');

const CANDIDATE_TYPES = ['external_law_candidate', 'external_case_candidate'];
const LEGAL_REVIEW_ROLES = new Set(['admin', 'knowledge_admin', 'legal_reviewer']);
const TARGET_JURISDICTIONS = [
    { code: 'HK', name: '中国香港' },
    { code: 'MO', name: '中国澳门' },
    { code: 'JP', name: '日本' },
    { code: 'KR', name: '韩国' },
    { code: 'SG', name: '新加坡' },
    { code: 'MY', name: '马来西亚' },
    { code: 'BN', name: '文莱' },
    { code: 'TH', name: '泰国' },
    { code: 'VN', name: '越南' },
    { code: 'ID', name: '印度尼西亚' },
    { code: 'PH', name: '菲律宾' },
    { code: 'KH', name: '柬埔寨' },
    { code: 'LA', name: '老挝' },
    { code: 'MM', name: '缅甸' },
];
const VERIFICATION_FIELDS = new Set([
    'translation_status',
    'translation_provenance',
    'currentness_verified',
    'official_version_date',
    'validity_note',
    'currentness_basis',
    'source_language',
]);

const firstValue = (object, keys) => keys.map((key) => object?.[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== '');

const sanitizeVerification = (verification = {}) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(verification || {})) {
        if (!VERIFICATION_FIELDS.has(key)) continue;
        if (key === 'currentness_verified') {
            sanitized[key] = value === true;
            continue;
        }
        const text = String(value ?? '').trim().slice(0, 1000);
        if (!text) continue;
        if (key === 'official_version_date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            throw new Error('官方版本日期必须为 YYYY-MM-DD。');
        }
        if (key === 'translation_status' && !['official_original_only', 'translated'].includes(text)) {
            throw new Error('翻译状态必须为 official_original_only 或 translated。');
        }
        sanitized[key] = text;
    }
    if (sanitized.translation_status === 'translated' && !sanitized.translation_provenance) {
        throw new Error('使用译文时必须填写翻译来源。');
    }
    return sanitized;
};

const candidateReadiness = (candidate) => {
    const metadata = candidate.metadata || {};
    const sourceUrl = candidate.source_url || firstValue(metadata, ['official_url', 'source_url', 'full_text_source_url']);
    const currentness = firstValue(metadata, ['currentness_verified', 'validity_verified']) === true;
    const currentnessBasis = firstValue(metadata, ['currentness_basis', 'validity_note']);
    const version = firstValue(metadata, ['official_version_date', 'effective_date', 'version_date', 'last_amended_at']);
    const language = firstValue(metadata, ['source_language', 'language']);
    const translationProvenance = firstValue(metadata, ['translation_provenance', 'translation_source', 'official_translation_url']);
    const translationStatus = firstValue(metadata, ['translation_status']);
    const originalOnly = translationStatus === 'official_original_only' || translationStatus === 'not_provided';
    const checks = {
        official_source: Boolean(sourceUrl && /^https?:\/\//i.test(String(sourceUrl))),
        full_text: metadata.full_text_verified === true && Number(metadata.content_chars || candidate.content_chars || 0) >= 200,
        content_hash: /^[a-f0-9]{64}$/i.test(String(metadata.content_sha256 || '')),
        jurisdiction: Boolean(firstValue(metadata, ['jurisdiction', 'country_code'])),
        validity: currentness,
        currentness_basis: Boolean(currentnessBasis),
        version: Boolean(version),
        source_language: Boolean(language),
        translation_provenance: Boolean(translationProvenance || originalOnly),
    };
    return {
        ready: Object.values(checks).every(Boolean),
        checks,
        note: translationProvenance
            ? '已记录翻译来源'
            : (originalOnly ? '仅提供官方原文，未提供译文' : '若使用译文，必须补充翻译来源；仅使用官方原文时请标记 official_original_only'),
    };
};

const normalizeCandidateGroup = (rows) => {
    const first = rows[0];
    const metadata = toMetadataObject(first.metadata);
    const originalSourceId = metadata.original_source_id || String(first.source_id || '').replace(/:chunk:\d+$/, '');
    const sorted = [...rows].sort((a, b) => Number(a.chunk_index || 0) - Number(b.chunk_index || 0));
    const candidate = {
        source_id: originalSourceId,
        source_type: first.source_type,
        title: first.title,
        category: first.category,
        source_name: first.source_name,
        source_url: first.source_url || metadata.official_url || metadata.full_text_source_url || '',
        law_status: first.law_status,
        metadata,
        content: sorted.map((row) => row.content).join('\n\n'),
        content_chars: sorted.reduce((sum, row) => sum + String(row.content || '').length, 0),
        chunks: sorted.length,
        updated_at: first.updated_at,
    };
    return { ...candidate, readiness: candidateReadiness(candidate) };
};

const listKnowledgeCandidates = async ({ page = 1, pageSize = 20, jurisdiction = '', status = '', sourceType = '' } = {}) => {
    const rows = await db('vector_documents')
        .whereIn('source_type', CANDIDATE_TYPES)
        .orderBy('updated_at', 'desc')
        .select('*');
    const groups = new Map();
    rows.forEach((row) => {
        const metadata = toMetadataObject(row.metadata);
        const key = metadata.original_source_id || String(row.source_id || '').replace(/:chunk:\d+$/, '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    });
    const allItems = [...groups.values()].map(normalizeCandidateGroup);
    const coverage = TARGET_JURISDICTIONS.map(({ code, name }) => {
        const matchingItems = allItems.filter((item) => String(item.metadata.jurisdiction || '') === code);
        const ready = matchingItems.filter((item) => item.readiness.ready).length;
        return {
            code,
            name,
            candidates: matchingItems.length,
            ready,
            status: matchingItems.length === 0 ? 'missing' : (matchingItems.length < 3 ? 'thin' : 'candidate'),
        };
    });
    let items = allItems;
    if (jurisdiction) items = items.filter((item) => String(item.metadata.jurisdiction || '') === jurisdiction);
    if (sourceType) items = items.filter((item) => item.source_type === sourceType);
    if (status) items = items.filter((item) => String(item.metadata.approval_status || 'official_candidate') === status);
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const start = (safePage - 1) * safePageSize;
    return {
        page: safePage,
        pageSize: safePageSize,
        total: items.length,
        coverage,
        summary: items.reduce((acc, item) => {
            const key = item.metadata.approval_status || 'official_candidate';
            acc[key] = (acc[key] || 0) + 1;
            if (item.readiness.ready) acc.ready = (acc.ready || 0) + 1;
            return acc;
        }, {}),
        items: items.slice(start, start + safePageSize).map(({ content, ...item }) => ({
            ...item,
            content_preview: content.slice(0, 500),
        })),
    };
};

const updateCandidateMetadata = async (sourceId, updates) => {
    const rows = await db('vector_documents').whereIn('source_type', CANDIDATE_TYPES).select('*');
    const matching = rows.filter((row) => {
        const metadata = toMetadataObject(row.metadata);
        return (metadata.original_source_id || String(row.source_id || '').replace(/:chunk:\d+$/, '')) === sourceId;
    });
    for (const row of matching) {
        const metadata = toMetadataObject(row.metadata);
        await db('vector_documents').where({ id: row.id }).update({
            metadata: JSON.stringify({ ...metadata, ...updates }),
            updated_at: db.fn.now(),
        });
    }
    return matching;
};

const decideKnowledgeCandidate = async ({ sourceId, decision, note, reviewer, verification = {} }) => {
    if (!LEGAL_REVIEW_ROLES.has(String(reviewer?.role || ''))) {
        const error = new Error('仅法务审核员或知识库管理员可以审批境外资料。');
        error.statusCode = 403;
        throw error;
    }
    if (!['approve', 'reject'].includes(decision)) throw new Error('decision 必须为 approve 或 reject。');
    if (!String(note || '').trim()) throw new Error('审批意见不能为空。');

    const rows = await db('vector_documents').whereIn('source_type', CANDIDATE_TYPES).select('*');
    const matching = rows.filter((row) => {
        const metadata = toMetadataObject(row.metadata);
        return (metadata.original_source_id || String(row.source_id || '').replace(/:chunk:\d+$/, '')) === sourceId;
    });
    if (matching.length === 0) {
        const error = new Error('候选资料不存在。');
        error.statusCode = 404;
        throw error;
    }
    const verificationUpdates = sanitizeVerification(verification);
    if (Object.keys(verificationUpdates).length > 0) {
        await updateCandidateMetadata(sourceId, verificationUpdates);
        matching.forEach((row) => {
            row.metadata = JSON.stringify({ ...toMetadataObject(row.metadata), ...verificationUpdates });
        });
    }
    const candidate = normalizeCandidateGroup(matching);
    if (decision === 'approve' && !candidate.readiness.ready) {
        const error = new Error('资料完整性校验未通过，不能转入正式知识库。');
        error.statusCode = 409;
        error.readiness = candidate.readiness;
        throw error;
    }

    const now = new Date().toISOString();
    const approvalStatus = decision === 'approve' ? 'legal_verified' : 'legal_rejected';
    let promotedSourceId = null;
    if (decision === 'approve') {
        const formalType = candidate.source_type === 'external_case_candidate' ? 'case' : 'law';
        promotedSourceId = `approved:${sourceId}`;
        await importKnowledgeEntries([{
            source_type: formalType,
            source_id: promotedSourceId,
            title: candidate.title,
            category: candidate.category,
            source_name: candidate.source_name,
            source_url: candidate.source_url,
            content: candidate.content,
            law_status: '现行',
            effective_date: firstValue(candidate.metadata, ['effective_date', 'official_version_date']),
            metadata: {
                ...candidate.metadata,
                approval_status: approvalStatus,
                approved_by: reviewer.username,
                approved_by_user_id: reviewer.id,
                approved_at: now,
                approval_note: String(note).trim(),
                candidate_source_id: sourceId,
            },
        }]);
    }
    await updateCandidateMetadata(sourceId, {
        approval_status: approvalStatus,
        legal_reviewed_by: reviewer.username,
        legal_reviewed_by_user_id: reviewer.id,
        legal_reviewed_at: now,
        legal_review_note: String(note).trim(),
        promoted_source_id: promotedSourceId,
    });
    await db('knowledge_approval_audit').insert({
        candidate_source_id: sourceId,
        candidate_source_type: candidate.source_type,
        decision,
        reviewer_user_id: reviewer.id || null,
        reviewer_username: reviewer.username || '',
        reviewer_role: reviewer.role || '',
        review_note: String(note).trim(),
        readiness_snapshot: JSON.stringify(candidate.readiness),
        promoted_source_id: promotedSourceId,
    });
    return { source_id: sourceId, decision, approval_status: approvalStatus, promoted_source_id: promotedSourceId };
};

module.exports = {
    CANDIDATE_TYPES,
    LEGAL_REVIEW_ROLES,
    TARGET_JURISDICTIONS,
    candidateReadiness,
    sanitizeVerification,
    listKnowledgeCandidates,
    decideKnowledgeCandidate,
};
