/**
 * @file services/caseJsonParser.js
 * @brief 裁判文书 JSON 解析器，将案例文档转换为知识库结构化条目
 *
 * 核心职责：
 * - 从案例 document 提取标题、案情、裁判理由、裁判结果
 * - 生成稳定 source_id 与分类（charge）信息
 * - 输出含 pid/charge/article 等字段的 metadata
 *
 * 关键实现：
 * - normalizeText 规范化空白字符
 * - stableId 基于 sourceFile+sourceKey+title 哈希生成
 * - charge 数组拼接为分类，article 数组映射为 clause_id
 * - 基本案情+裁判理由+裁判结果+全文拼接为 content
 *
 * 依赖关系：
 * - 上游：path、crypto
 * - 下游：案例同步入库调用 parseCaseJsonDocument
 */

const path = require('path');
const crypto = require('crypto');

const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const stableId = (parts) => crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('|'))
    .digest('hex')
    .slice(0, 24);

const parseCaseTitle = (document, fallbackTitle) => {
    const title = normalizeText(document.qw).slice(0, 120);
    return title || fallbackTitle;
};

const buildCaseContent = (document) => {
    const sections = [
        ['基本案情', document.fact],
        ['裁判理由', document.reason],
        ['裁判结果', document.result],
        ['全文', document.qw],
    ];
    return sections
        .map(([label, value]) => {
            const text = normalizeText(value);
            return text ? `${label}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
};

const parseCaseJsonDocument = (document, { sourceFile = '' } = {}) => {
    if (document && document.schema === 'official_case_v1') {
        const title = normalizeText(document.title);
        const sections = [
            ['基本案情', document.facts],
            ['争议焦点', document.issue],
            ['裁判理由', document.reasoning],
            ['裁判结果', document.result],
            ['合同审查启示', document.review_guidance],
        ];
        const content = sections
            .map(([label, value]) => normalizeText(value) ? `${label}: ${normalizeText(value)}` : '')
            .filter(Boolean)
            .join('\n\n');
        if (!title || !content || !document.official_url) return null;
        const stableSourceId = document.source_id || `official-case:${stableId([document.official_url, document.case_no, title])}`;
        return {
            source_type: 'case',
            source_id: stableSourceId,
            title,
            category: normalizeText(document.category) || '合同纠纷',
            clause_id: normalizeText(document.case_no || document.publication_form),
            source_name: normalizeText(document.official_source) || '最高人民法院',
            source_url: document.official_url,
            content,
            law_status: '现行参考',
            metadata: {
                schema: 'official_case_v1',
                court: document.court || '最高人民法院',
                case_no: document.case_no || null,
                publication_form: document.publication_form || '',
                published_at: document.published_at || '',
                verified_at: document.verified_at || '',
                jurisdiction: document.jurisdiction || 'CN',
                applicable_contract_types: document.applicable_contract_types || [],
                official_source: document.official_source || '最高人民法院',
                official_url: document.official_url,
                approval_status: 'official_verified',
                parser: 'official-case-v1',
                source_file: sourceFile,
            },
        };
    }
    const fallbackTitle = sourceFile
        ? path.basename(sourceFile, path.extname(sourceFile))
        : `case-${document.pid || stableId([document.qw, document.fact])}`;
    const title = parseCaseTitle(document, fallbackTitle);
    const charge = Array.isArray(document.charge) ? document.charge.map(normalizeText).filter(Boolean) : [];
    const articles = Array.isArray(document.article) ? document.article.filter((item) => item !== null && item !== undefined) : [];
    const category = charge.length ? charge.join(' / ') : '裁判文书';
    const content = buildCaseContent(document);
    if (!content) return null;

    const sourceKey = document.pid !== undefined && document.pid !== null
        ? `pid:${document.pid}`
        : stableId([title, content]);

    return {
        source_type: 'case',
        source_id: `case:${stableId([sourceFile, sourceKey, title])}`,
        title,
        category,
        clause_id: articles.length ? articles.map((item) => `第${item}条`).join(' / ') : '',
        source_name: sourceFile || title,
        content,
        metadata: {
            pid: document.pid ?? null,
            charge,
            article: articles,
            source_file: sourceFile,
            parser: 'case-json-template',
            fields: ['qw', 'fact', 'reason', 'result', 'charge', 'article'],
        },
    };
};

module.exports = {
    parseCaseJsonDocument,
};
