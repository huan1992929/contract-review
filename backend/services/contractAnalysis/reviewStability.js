/**
 * @file services/contractAnalysis/reviewStability.js
 * @brief 全文审核的固定覆盖面、可复现指纹与脱敏结果缓存。
 *
 * 缓存只保存审核 JSON，不保存用户 ID、文件名、存储路径或 OnlyOffice key。
 * 因此相同文件在不同用户间可以复用法务审核结果，但不会暴露对方的文件与账号信息。
 */
const crypto = require('crypto');
const fs = require('fs');
const db = require('../../database');

const REVIEW_POLICY_VERSION = 'holistic-fixed-coverage-v4';

const CORE_REVIEW_TOPICS = Object.freeze([
    { id: 'payment', label: '付款与预付保障', query: '付款节点 预付款 履约保障 账期 发票' },
    { id: 'delivery', label: '交付范围与时间', query: '服务范围 交付物 交付时间 里程碑 附件缺失' },
    { id: 'acceptance', label: '验收标准与程序', query: '验收标准 验收程序 异议期 默认验收 整改' },
    { id: 'refund', label: '退费与未履行返还', query: '退费 未履行部分 合同解除 预付款返还 计算方式' },
    { id: 'metering', label: '计量对账与异议', query: '计量 积分 用量记录 对账 异议机制 举证' },
    { id: 'data_privacy', label: '数据与个人信息', query: '数据安全 个人信息 数据处理 泄露 删除 跨境' },
    { id: 'ip', label: '知识产权与成果权属', query: '知识产权 服务成果 著作权 第三方权利 侵权责任' },
    { id: 'ai_liability', label: 'AI输出与合规责任', query: 'AI输出 准确性 合规 免责 人工智能生成内容 责任分配' },
    { id: 'third_party', label: '第三方服务与中断', query: '第三方服务 中断 故障 不可用 服务等级 赔偿' },
    { id: 'breach_termination', label: '违约、解除与责任上限', query: '违约责任 合同解除 责任上限 损失赔偿 单方解除' },
    { id: 'renewal_change', label: '续约、变更与价格调整', query: '自动续约 价格调整 服务变更 通知 退出机制' },
    { id: 'dispute', label: '争议解决与管辖', query: '争议解决 诉讼管辖 仲裁 履行地 被告所在地' },
]);

const sha256 = (value) => crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value || ''))
    .digest('hex');

const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const normalizeReviewText = (value) => String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0 ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const fileSha256 = (filePath) => sha256(fs.readFileSync(filePath));

const getModelSettingsDescriptor = (requestOptions = {}, env = process.env) => ({
    provider: String(env.LLM_BASE_URL || '').trim(),
    model: String(env.LLM_MODEL || '').trim(),
    response_format: 'json_object',
    temperature: Number(env.REVIEW_LLM_TEMPERATURE ?? 0),
    seed: String(env.REVIEW_LLM_SEED || ''),
    timeout: Number(requestOptions.timeout || 0),
    max_retries: Number(requestOptions.maxRetries || 0),
});

const knowledgeReleaseFromItems = (items = []) => {
    const releases = items
        .map((item) => item?.metadata?.legal_app_release_id)
        .filter(Boolean)
        .map(String);
    return [...new Set(releases)].sort().join(',') || 'local-vector-store';
};

const buildReviewFingerprint = ({
    storagePath,
    plainText,
    template,
    contractType,
    perspective,
    knowledgeReleaseId,
    requestOptions,
    env = process.env,
}) => {
    const descriptor = {
        policy_version: REVIEW_POLICY_VERSION,
        document_sha256: fileSha256(storagePath),
        logical_text_sha256: sha256(normalizeReviewText(plainText)),
        template: {
            id: String(template?.id || ''),
            updated_at: template?.updated_at ? new Date(template.updated_at).toISOString() : '',
            review_points: template?.review_points || [],
            core_purposes: template?.core_purposes || [],
        },
        contract_type: String(contractType || ''),
        perspective: String(perspective || ''),
        knowledge_release_id: String(knowledgeReleaseId || ''),
        model_settings: getModelSettingsDescriptor(requestOptions, env),
    };
    // 逻辑审核文本是主键；OOXML zip 打包时间或无关系元数据不应造成缓存未命中。
    // document_sha256 仅用于审计。已有修订的双视图内容会进入 plainText，因而仍会产生不同逻辑指纹。
    const { document_sha256: auditDocumentSha256, ...fingerprintDescriptor } = descriptor;
    void auditDocumentSha256;
    return {
        fingerprint: sha256(stableJson(fingerprintDescriptor)),
        descriptor,
    };
};

const mergeCoverageCandidates = (rawPlan) => {
    const source = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    const coreCandidates = (Array.isArray(source.topic_coverage) ? source.topic_coverage : [])
        .filter((item) => item?.status === 'risk' && item?.candidate && typeof item.candidate === 'object')
        .map((item) => ({
            ...item.candidate,
            coverage_topic: String(item.topic_id || ''),
            knowledge_query: [
                CORE_REVIEW_TOPICS.find((topic) => topic.id === item.topic_id)?.query,
                item.candidate.knowledge_query,
            ].filter(Boolean).join(' '),
        }));
    return {
        ...source,
        candidate_issues: [...coreCandidates, ...(Array.isArray(source.candidate_issues) ? source.candidate_issues : [])],
    };
};

const validateFixedTopicCoverage = (rawPlan) => {
    const coverage = Array.isArray(rawPlan?.topic_coverage) ? rawPlan.topic_coverage : [];
    const byId = new Map(coverage.map((item) => [String(item?.topic_id || ''), item]));
    const missing = [];
    const invalid = [];
    for (const topic of CORE_REVIEW_TOPICS) {
        const item = byId.get(topic.id);
        if (!item) {
            missing.push(topic.id);
            continue;
        }
        if (!['risk', 'covered', 'not_applicable'].includes(item.status)
            || (item.status === 'risk' && (!item.candidate || typeof item.candidate !== 'object'))) {
            invalid.push(topic.id);
        }
    }
    if (missing.length || invalid.length) {
        const error = new Error(`HOLISTIC_TOPIC_COVERAGE_INCOMPLETE: missing=${missing.join(',') || '-'} invalid=${invalid.join(',') || '-'}`);
        error.code = 'HOLISTIC_TOPIC_COVERAGE_INCOMPLETE';
        error.missing_topics = missing;
        error.invalid_topics = invalid;
        throw error;
    }
    return coverage;
};

const cloneResultForCache = (result) => JSON.parse(JSON.stringify(result || {}));

const findCachedReviewResult = async (fingerprint) => {
    const row = await db('review_result_cache').where({ fingerprint }).first('result_json');
    if (!row) return null;
    const parsed = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    return cloneResultForCache(parsed);
};

const storeCachedReviewResult = async ({ fingerprint, descriptor, result }) => {
    await db('review_result_cache').insert({
        fingerprint,
        document_sha256: descriptor.document_sha256,
        logical_text_sha256: descriptor.logical_text_sha256,
        template_id: descriptor.template.id,
        perspective: descriptor.perspective,
        contract_type: descriptor.contract_type,
        knowledge_release_id: descriptor.knowledge_release_id,
        policy_version: descriptor.policy_version,
        model_settings_hash: sha256(stableJson(descriptor.model_settings)),
        result_json: JSON.stringify(cloneResultForCache(result)),
        updated_at: db.fn.now(),
    }).onConflict('fingerprint').merge({
        result_json: JSON.stringify(cloneResultForCache(result)),
        updated_at: db.fn.now(),
    });
};

module.exports = {
    REVIEW_POLICY_VERSION,
    CORE_REVIEW_TOPICS,
    normalizeReviewText,
    stableJson,
    knowledgeReleaseFromItems,
    getModelSettingsDescriptor,
    buildReviewFingerprint,
    validateFixedTopicCoverage,
    mergeCoverageCandidates,
    findCachedReviewResult,
    storeCachedReviewResult,
};
