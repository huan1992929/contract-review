/**
 * @file services/reviewTemplates.js
 * @brief 审查模板管理服务，提供模板加载、匹配与数据库种子能力
 *
 * 核心职责：
 * - 从数据库或品牌 JSON 文件加载审查模板（DB 优先，失败回退 JSON）
 * - 按关键词命中数与语义相似度加权匹配合同模板
 * - 启动时为空表注入模板并生成 typical_description 与 embedding
 *
 * 关键实现：
 * - 混合匹配：关键词命中数 + 余弦相似度×5 加权
 * - 混合合同（双模板得分均>0.7）返回数组，审查点取并集
 * - embedding 失败时相似度降级为 0，不影响关键词匹配
 * - 得分全为 0 时回退到 general 通用模板
 *
 * 依赖关系：
 * - 上游：database（review_templates 表）、embeddingClient、data/reviewTemplates.json
 * - 下游：合同审查服务调用 matchTemplate 选择模板
 */

const path = require('path');
const fs = require('fs');
const db = require('../database');
const { embedText } = require('./embeddingClient');

const TEMPLATE_PROFILES = {
    default: 'reviewTemplates.json',
    thinkpark: 'thinkparkReviewTemplates.json',
};

// 思库部署默认使用法务助手知识库对应的业务模板。
const getConfiguredTemplateProfile = () => {
    const requested = String(process.env.REVIEW_TEMPLATE_PROFILE || 'thinkpark').trim().toLowerCase();
    return TEMPLATE_PROFILES[requested] ? requested : 'default';
};

const getTemplatesPath = () => path.join(
    __dirname,
    '..',
    'data',
    TEMPLATE_PROFILES[getConfiguredTemplateProfile()],
);

// 从 JSON 文件加载模板(数据库不可用时的回退路径)
const loadTemplatesFromJson = () => {
    const templatesPath = getTemplatesPath();
    if (!fs.existsSync(templatesPath)) return [];
    return JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
};

// 生成模板的典型描述(无 LLM 依赖),用于语义匹配
const generateTypicalDescription = (template) => {
    const name = template.name || template.id || '合同';
    const reviewPoints = (template.review_points || []).slice(0, 5).join('、');
    const corePurposes = (template.core_purposes || []).slice(0, 2).join('、');
    return `该模板用于审查${name}。审查要点:${reviewPoints}。核心目的:${corePurposes}`;
};

// 将数据库行转换为模板对象(jsonb 字段由 knex+pg 自动解析为对象)
const rowToTemplate = (row) => {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        contract_type_keywords: row.contract_type_keywords || [],
        review_points: row.review_points || [],
        core_purposes: row.core_purposes || [],
        report_sections: row.report_sections || [],
        prompt_rules: row.prompt_rules || [],
        typical_description: row.typical_description || '',
        typical_description_embedding: row.typical_description_embedding || null,
        is_active: row.is_active,
        is_system: row.is_system,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
};

// 获取全部模板:优先查数据库,失败回退 JSON 文件
const getAllTemplates = async () => {
    try {
        const rows = await db('review_templates')
            .where({ is_active: true })
            .orderBy('created_at', 'asc');
        return (rows || []).map(rowToTemplate);
    } catch (error) {
        console.warn('[reviewTemplates] DB query failed, falling back to JSON:', error.message);
    }
    return loadTemplatesFromJson().filter((template) => template.is_active !== false);
};

// 按 id 获取模板:优先查数据库,失败回退 JSON
const getTemplateById = async (id) => {
    if (!id) return null;
    try {
        const row = await db('review_templates').where({ id }).first();
        if (row) return rowToTemplate(row);
    } catch (error) {
        console.warn('[reviewTemplates] DB query failed, falling back to JSON:', error.message);
    }
    return loadTemplatesFromJson().find((template) => template.id === id) || null;
};

const buildSeedRow = async (template) => {
    const typicalDescription = template.typical_description || generateTypicalDescription(template);
    let embedding = null;
    try {
        const vector = await embedText(typicalDescription);
        embedding = Array.isArray(vector) ? JSON.stringify(vector) : null;
    } catch (error) {
        console.warn(`[reviewTemplates] Embedding failed for ${template.id}: ${error.message}`);
    }
    return {
        id: template.id,
        name: template.name,
        contract_type_keywords: JSON.stringify(template.contract_type_keywords || []),
        review_points: JSON.stringify(template.review_points || []),
        core_purposes: JSON.stringify(template.core_purposes || []),
        report_sections: JSON.stringify(template.report_sections || []),
        prompt_rules: JSON.stringify(template.prompt_rules || []),
        typical_description: typicalDescription,
        typical_description_embedding: embedding,
        is_active: template.is_active !== false,
        is_system: true,
    };
};

// 每次启动对配置的系统模板做幂等同步，确保知识库模板更新能进入现网。
// 非当前 profile 的系统模板仅停用；生产物理删除由发布脚本在备份后执行。
const activateConfiguredTemplateProfile = async (templates) => {
    if (getConfiguredTemplateProfile() === 'default' || templates.length === 0) {
        return { activated: false };
    }
    const ids = templates.map((template) => template.id);
    const seedRows = [];
    for (const template of templates) {
        seedRows.push(await buildSeedRow(template));
    }

    await db.transaction(async (trx) => {
        await trx('review_templates')
            .where({ is_system: true })
            .whereNotIn('id', ids)
            .update({ is_active: false, updated_at: trx.fn.now() });
        for (const row of seedRows) {
            await trx('review_templates')
                .insert(row)
                .onConflict('id')
                .merge({
                    name: row.name,
                    contract_type_keywords: row.contract_type_keywords,
                    review_points: row.review_points,
                    core_purposes: row.core_purposes,
                    report_sections: row.report_sections,
                    prompt_rules: row.prompt_rules,
                    typical_description: row.typical_description,
                    typical_description_embedding: row.typical_description_embedding,
                    is_active: row.is_active,
                    is_system: true,
                    updated_at: trx.fn.now(),
                });
        }
    });
    console.log(`[reviewTemplates] Synchronized ${getConfiguredTemplateProfile()} profile with ${ids.length} templates.`);
    return { activated: true, total: ids.length };
};

// 启动时调用:空表从当前品牌 JSON 导入；已有通用数据时仅首次激活品牌模板。
const seedTemplatesIfEmpty = async () => {
    try {
        const templates = loadTemplatesFromJson();
        const countRow = await db('review_templates').count({ count: '*' }).first();
        const count = Number(countRow?.count || 0);
        if (count > 0) {
            const activation = await activateConfiguredTemplateProfile(templates);
            if (!activation.activated) {
                console.log(`[reviewTemplates] Table already has ${count} templates, skipping seed.`);
            }
            const finalCountRow = activation.activated
                ? await db('review_templates').count({ count: '*' }).first()
                : countRow;
            return {
                seeded: activation.activated ? activation.total : 0,
                total: Number(finalCountRow?.count || count),
                profile: getConfiguredTemplateProfile(),
            };
        }
        let seeded = 0;
        for (const template of templates) {
            await db('review_templates').insert(await buildSeedRow(template));
            seeded += 1;
        }
        console.log(`[reviewTemplates] Seeded ${seeded} templates from ${getConfiguredTemplateProfile()} profile (is_system=true).`);
        return { seeded, total: seeded, profile: getConfiguredTemplateProfile() };
    } catch (error) {
        console.error('[reviewTemplates] seedTemplatesIfEmpty failed:', error.message);
        return { seeded: 0, total: 0, error: error.message };
    }
};

// 余弦相似度
const cosineSimilarity = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const parseEmbedding = (value) => {
    if (!value) return null;
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

// 关键词命中得分(保留原逻辑)
const keywordScore = (template, haystack) => (template.contract_type_keywords || []).reduce(
    (sum, keyword) => (haystack.includes(String(keyword).toLowerCase()) ? sum + 1 : sum),
    0,
);

const scoreTemplateCandidates = (templates, {
    contractType = '',
    text = '',
    scenarioDetection = null,
    textEmbedding = null,
} = {}) => {
    const haystack = `${contractType}\n${text}`.toLowerCase();
    const scenarioTemplateIds = [
        ...(scenarioDetection?.primary?.template_ids || []),
        ...(scenarioDetection?.secondary || []).flatMap((scenario) => scenario.template_ids || []),
    ];

    return (templates || []).map((template) => {
        const keywordHits = (template.contract_type_keywords || [])
            .filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
        const typeHits = (template.contract_type_keywords || [])
            .filter((keyword) => String(contractType).toLowerCase().includes(String(keyword).toLowerCase()));
        const scenarioIndex = scenarioTemplateIds.indexOf(template.id);
        const scenarioScore = scenarioIndex < 0 ? 0 : Math.max(0.5, 2.5 - scenarioIndex * 0.5);
        const templateEmbedding = parseEmbedding(template.typical_description_embedding);
        const semanticScore = textEmbedding && templateEmbedding
            ? cosineSimilarity(textEmbedding, templateEmbedding)
            : 0;
        const score = keywordHits.length + typeHits.length * 2 + scenarioScore + semanticScore * 5;
        const reasons = [];
        if (typeHits.length) reasons.push(`合同类型命中：${typeHits.join('、')}`);
        if (keywordHits.length) reasons.push(`合同内容命中：${keywordHits.slice(0, 5).join('、')}`);
        if (scenarioScore) reasons.push(`业务场景推荐：${scenarioDetection?.primary?.name || '次场景'}`);
        if (semanticScore > 0) reasons.push(`语义相似度：${semanticScore.toFixed(3)}`);
        return {
            template,
            template_id: template.id,
            template_name: template.name,
            score: Number(score.toFixed(4)),
            confidence: score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low',
            reasons,
            keyword_hits: keywordHits,
            semantic_similarity: Number(semanticScore.toFixed(4)),
        };
    }).sort((left, right) => right.score - left.score || left.template_id.localeCompare(right.template_id));
};

// 返回可追溯的模板候选，不改变 matchTemplate 的历史返回结构。
const getTemplateCandidates = async (contractType = '', text = '', context = {}, limit = 3) => {
    const templates = await getAllTemplates();
    let textEmbedding = null;
    try {
        textEmbedding = await embedText(`${contractType}\n${text}`.slice(0, 4000));
    } catch (error) {
        console.warn('[reviewTemplates] Candidate embedding failed, using deterministic matching:', error.message);
    }
    const ranked = scoreTemplateCandidates(templates, {
        contractType,
        text,
        scenarioDetection: context.scenarioDetection,
        textEmbedding,
    });
    const meaningful = ranked.filter((candidate) => candidate.score > 0).slice(0, Math.max(1, limit));
    const fallback = ranked.find((candidate) => candidate.template_id === 'thinkpark_general'
        || candidate.template_id === 'general'
        || candidate.template_id.endsWith('_general'));
    const selected = meaningful.length ? meaningful : (fallback ? [{ ...fallback, reasons: ['未命中专项模板，使用通用模板'] }] : ranked.slice(0, 1));
    return selected.map(({ template, ...candidate }, index) => ({
        ...candidate,
        rank: index + 1,
        profile: getConfiguredTemplateProfile(),
        trace_version: 'template-candidates-v1',
    }));
};

const KNOWLEDGE_TEMPLATE_SCENE_KEYWORDS = {
    venue: ['场地', '会场', '酒店', '宴会厅', '场馆'],
    supplier_service: ['采购', '供应商', '委托服务', '框架', '服务协议'],
    custom_procurement: ['设计', '制作', '搭建', '印刷', '物料'],
    client_service: ['创意', '活动承办', '品牌', '营销', '客户'],
    legal_consultation: ['法律', '法务', '咨询', '顾问'],
    contract_drafting: ['起草', '模板', '协议', '合同'],
};

/**
 * 对 WeKnora 召回文档做业务确定性重排。
 *
 * 向量分只负责召回，不允许微小相似度差异覆盖甲乙方方向和业务场景。
 * 保留原始 score 便于审计，新增 ranking_score / ranking_reasons 记录重排依据。
 */
const rankKnowledgeTemplateDocuments = (items = [], context = {}, limit = 3) => {
    const ourRole = context.ourRole || 'unknown';
    const sceneIds = [
        context.scenarioDetection?.primary?.id,
        ...(context.scenarioDetection?.secondary || []).map((scene) => scene.id),
    ].filter(Boolean);

    return items
        .map((item, originalIndex) => {
            const title = String(item.title || '');
            const reasons = [];
            let businessScore = 0;

            const isSupplierDirection = /供应商相关合同文件|思库是甲方/.test(title);
            const isClientDirection = /客户相关合同文件|思库是乙方/.test(title);
            if (ourRole === 'party_a') {
                if (isSupplierDirection) {
                    businessScore += 40;
                    reasons.push('甲方方向匹配：供应商相关合同');
                }
                if (isClientDirection) {
                    businessScore -= 20;
                    reasons.push('甲方方向冲突：客户相关合同');
                }
            } else if (ourRole === 'party_b') {
                if (isClientDirection) {
                    businessScore += 40;
                    reasons.push('乙方方向匹配：客户相关合同');
                }
                if (isSupplierDirection) {
                    businessScore -= 20;
                    reasons.push('乙方方向冲突：供应商相关合同');
                }
            }

            sceneIds.forEach((sceneId, sceneIndex) => {
                const hits = (KNOWLEDGE_TEMPLATE_SCENE_KEYWORDS[sceneId] || [])
                    .filter((keyword) => title.includes(keyword));
                if (!hits.length) return;
                const weight = sceneIndex === 0 ? 30 : 12;
                businessScore += weight;
                reasons.push(`${sceneIndex === 0 ? '主' : '次'}场景匹配：${hits.slice(0, 3).join('、')}`);
            });

            return {
                ...item,
                ranking_score: Number((businessScore + Number(item.score || 0)).toFixed(6)),
                ranking_reasons: reasons.length ? reasons : ['按知识库原始相似度排序'],
                _original_index: originalIndex,
            };
        })
        .sort((left, right) => (
            right.ranking_score - left.ranking_score
            || Number(right.score || 0) - Number(left.score || 0)
            || left._original_index - right._original_index
        ))
        .slice(0, Math.max(1, limit))
        .map(({ _original_index: ignored, ...item }, index) => ({
            ...item,
            rank: index + 1,
        }));
};

// 模板匹配:LLM 类型识别强匹配优先 → 关键词命中数 + 语义相似度 × 5 加权
// 混合合同(两个模板得分均 > 0.7)返回数组,审查点取并集;否则返回单模板对象(向后兼容)
const matchTemplate = async (contractType = '', text = '') => {
    const templates = await getAllTemplates();
    const haystack = `${contractType}\n${text}`.toLowerCase();

    // 强匹配优先:LLM 已识别的 contract_type 直接命中某模板的核心类型词且唯一时,直接返回该模板
    // 避免 embedding 相似度不稳定导致"劳动合同"被误判为"服务合同"等问题
    if (contractType) {
        const ctLower = contractType.toLowerCase();
        const strongMatches = templates
            .map((t) => ({
                t,
                kwHits: (t.contract_type_keywords || []).filter((k) => ctLower.includes(String(k).toLowerCase())).length,
            }))
            .filter((x) => x.kwHits > 0)
            .sort((a, b) => b.kwHits - a.kwHits);
        // 只有一个模板命中,或第一名命中数严格大于第二名,直接返回(多模板并列时走原逻辑保留混合合同检测)
        if (strongMatches.length > 0 && (strongMatches.length === 1 || strongMatches[0].kwHits > strongMatches[1].kwHits)) {
            return strongMatches[0].t;
        }
    }

    // 语义相似度:对合同文本生成 embedding,与每个模板的 typical_description_embedding 计算余弦相似度
    let textEmbedding = null;
    try {
        // 截断合同文本,避免超出 embedding 模型上下文限制
        textEmbedding = await embedText(`${contractType}\n${text}`.slice(0, 4000));
    } catch (error) {
        console.warn('[reviewTemplates] Contract text embedding failed, semantic matching disabled:', error.message);
    }

    const scored = templates.map((template) => {
        const kw = keywordScore(template, haystack);
        let semantic = 0;
        const templateEmbedding = parseEmbedding(template.typical_description_embedding);
        if (textEmbedding && templateEmbedding) {
            semantic = cosineSimilarity(textEmbedding, templateEmbedding);
        }
        const score = kw + semantic * 5;
        return { template, score };
    }).sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    // 混合合同:两个模板得分均 > 0.7,返回数组,审查点取并集
    if (scored.length >= 2 && scored[0].score > 0.7 && scored[1].score > 0.7) {
        const unionPoints = Array.from(new Set([
            ...(scored[0].template.review_points || []),
            ...(scored[1].template.review_points || []),
        ]));
        const unionPurposes = Array.from(new Set([
            ...(scored[0].template.core_purposes || []),
            ...(scored[1].template.core_purposes || []),
        ]));
        return [
            { template: { ...scored[0].template, review_points: unionPoints, core_purposes: unionPurposes }, score: scored[0].score },
            { template: { ...scored[1].template, review_points: unionPoints, core_purposes: unionPurposes }, score: scored[1].score },
        ];
    }

    // 单模板:向后兼容返回对象;得分全为 0 时回退到 general
    const best = scored[0];
    if (best.score <= 0) {
        return templates.find((t) => t.id === 'general' || t.id.endsWith('_general')) || templates[0] || null;
    }
    return best.template;
};

module.exports = {
    getAllTemplates,
    getTemplateById,
    matchTemplate,
    getTemplateCandidates,
    rankKnowledgeTemplateDocuments,
    scoreTemplateCandidates,
    seedTemplatesIfEmpty,
    generateTypicalDescription,
    loadTemplatesFromJson,
    getConfiguredTemplateProfile,
};
