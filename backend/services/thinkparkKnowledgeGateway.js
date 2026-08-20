const axios = require('axios');

const QUERY_MAX_CHARS = 760;

const compactQuery = (options) => {
    const parts = [];
    if (typeof options === 'string') {
        parts.push(options);
    } else if (options && typeof options === 'object') {
        parts.push(
            options.contractType,
            options.perspective ? `我方立场：${options.perspective}` : '',
            ...(options.reviewPoints || []),
            ...(options.corePurposes || []),
            options.question,
        );
        if (options.byClause && Array.isArray(options.clauses)) {
            options.clauses.forEach((clause) => parts.push(clause.title, clause.text));
        } else {
            parts.push(options.text);
        }
    }
    const query = parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
    if (query.length <= QUERY_MAX_CHARS) return query;
    return `${query.slice(0, 500)} …（中间内容省略）… ${query.slice(-230)}`;
};

const isThinkParkKnowledgeGatewayEnabled = () => Boolean(
    String(process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL || '').trim(),
);

const searchThinkParkKnowledge = async (options, limit = 8) => {
    const url = String(process.env.THINKPARK_KNOWLEDGE_GATEWAY_URL || '').trim();
    const integrationKey = String(process.env.THINKPARK_INTEGRATION_KEY || '').trim();
    if (!url || !integrationKey) throw new Error('THINKPARK_KNOWLEDGE_GATEWAY_NOT_CONFIGURED');
    const query = compactQuery(options);
    if (!query) return [];

    const response = await axios.post(
        url,
        { query, limit: Math.max(1, Math.min(12, Number(limit) || 8)) },
        {
            headers: { 'X-Thinkpark-Contract-Review-Key': integrationKey },
            timeout: 30000,
        },
    );
    const releaseId = response.data?.legal_app_release_id;
    const releaseNo = response.data?.legal_app_release_no;
    return (response.data?.items || []).map((item) => ({
        source_type: 'weknora',
        law: item.title,
        clause: item.document_id,
        content: item.content,
        score: item.score,
        source_name: item.title,
        source_url: null,
        metadata: {
            verified_release_binding: true,
            legal_app_release_id: releaseId,
            legal_app_release_no: releaseNo,
            knowledge_base_id: item.knowledge_base_id,
            document_id: item.document_id,
        },
    }));
};

module.exports = {
    QUERY_MAX_CHARS,
    compactQuery,
    isThinkParkKnowledgeGatewayEnabled,
    searchThinkParkKnowledge,
};
