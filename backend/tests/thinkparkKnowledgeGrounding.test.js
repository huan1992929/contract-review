const test = require('node:test');
const assert = require('node:assert/strict');

const {
    enforceKnowledgeGrounding,
    normalizeAnalysisResult,
    aggregateClauseResults,
} = require('../services/contractAnalysis/analysisCore');
const { filterGroundedIncrementalPoints } = require('../services/incrementalReview');

const knowledge = [{
    source_type: 'weknora',
    source_id: 'chunk-acceptance-001',
    metadata: { document_id: 'doc-service-001' },
    law: '委托服务协议-单次.docx',
    source_name: '思库法务助手知识库',
    content: '服务完成后，甲方应当依据验收报告确认交付成果。',
}];

test('keeps only findings with both a contract anchor and WeKnora evidence', () => {
    const plainText = '第五条 乙方提交成果后，甲方在十个工作日内完成验收。';
    const filtered = enforceKnowledgeGrounding({
        compliance_findings: [
            {
                issue_type: '范本差异',
                title: '验收期限偏离',
                original_clause: '甲方在十个工作日内完成验收',
                basis: [{ title: '委托服务协议-单次.docx', content: knowledge[0].content }],
            },
            {
                issue_type: '合规瑕疵',
                title: '模型通用经验',
                original_clause: '甲方在十个工作日内完成验收',
                basis: [{ title: '未入库的通用经验' }],
            },
            {
                issue_type: '范本差异',
                title: '没有原文锚点',
                original_clause: '合同未出现的虚构条款',
                basis: [{ title: '委托服务协议-单次.docx' }],
            },
        ],
    }, plainText, knowledge);

    assert.deepEqual(filtered.compliance_findings.map((item) => item.title), ['验收期限偏离']);
    assert.deepEqual(filtered.grounding_audit.finding_counts, { input: 3, accepted: 1, rejected: 2 });
    assert.ok(filtered.grounding_audit.rejected.every((item) => !Object.hasOwn(item, 'original_clause')));
});

test('accepts stable source ids and tolerant document titles without copying the knowledge prefix', () => {
    const plainText = '第五条 甲方在十个工作日内完成验收。';
    const filtered = enforceKnowledgeGrounding({
        compliance_findings: [{
            title: '稳定 ID 依据',
            original_clause: '甲方在十个工作日内完成验收',
            basis: [{ source_id: 'chunk-acceptance-001' }],
        }, {
            title: '容错标题依据',
            original_clause: '甲方在十个工作日内完成验收',
            basis: [{ title: '委托服务协议单次' }],
        }],
    }, plainText, knowledge);

    assert.deepEqual(filtered.compliance_findings.map((item) => item.title), ['稳定 ID 依据', '容错标题依据']);
});

test('segmented review removes global missing clauses and already-applied revisions', () => {
    const plainText = '第五条 甲方依据验收报告确认交付成果。';
    const filtered = enforceKnowledgeGrounding({
        missing_clauses: [{
            title: '建议新增验收条款',
            basis: [{ title: '委托服务协议-单次.docx' }],
            suggested_clause: '甲方依据验收报告确认交付成果。',
        }],
        modification_suggestions: [{
            operation: 'replace',
            title: '重复建议',
            current_clause: '甲方依据验收报告确认交付成果',
            basis: [{ title: '委托服务协议-单次.docx' }],
            suggested_text: '甲方依据验收报告确认交付成果。',
        }],
    }, plainText, knowledge, { allowMissingClauses: false, maxSuggestions: 3 });

    assert.deepEqual(filtered.missing_clauses, []);
    assert.deepEqual(filtered.modification_suggestions, []);
});

test('aggregated clause suggestions are removed instead of merely marked as duplicates', () => {
    const result = normalizeAnalysisResult({
        modification_suggestions: [{
            issue_type: '范本差异',
            title: '统一验收依据',
            current_clause: '甲方在十个工作日内完成验收',
            suggested_text: '甲方依据验收报告确认交付成果。',
        }],
    }, '甲方在十个工作日内完成验收');
    const aggregate = aggregateClauseResults([
        { ...result, clause_id: '5.1' },
        { ...result, clause_id: '5.2' },
    ]);

    assert.equal(aggregate.modification_suggestions.length, 1);
    assert.equal(aggregate.modification_suggestions[0].cross_clause_duplicate, undefined);
});

test('incremental re-review does not resurrect ungrounded or already-applied risks', () => {
    const clauseText = '第五条 甲方依据验收报告确认交付成果。';
    const points = filterGroundedIncrementalPoints([
        {
            title: '有据修改项',
            original_clause: '甲方依据验收报告确认交付成果',
            basis: [{ title: '委托服务协议-单次.docx', content: knowledge[0].content }],
            suggestion: '验收报告应由双方盖章确认。',
        },
        {
            title: '无知识库依据',
            original_clause: '甲方依据验收报告确认交付成果',
            basis: [{ title: '模型通用经验' }],
            suggestion: '应当设置七日异议期。',
        },
        {
            title: '已经落实',
            original_clause: '甲方依据验收报告确认交付成果',
            basis: [{ title: '委托服务协议-单次.docx' }],
            suggestion: '甲方依据验收报告确认交付成果。',
        },
    ], clauseText, knowledge);

    assert.deepEqual(points.map((item) => item.title), ['有据修改项']);
});
