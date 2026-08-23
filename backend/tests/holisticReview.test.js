const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeHolisticPlan,
    materializeGroundedIssue,
    applyHolisticAdjudication,
    buildHolisticAnalysisResult,
} = require('../services/contractAnalysis/holisticReview');

const contract = '2.1 合同价款为五万元。2.2 签约后支付全部款项。3.1 乙方收到款项后十五个工作日部署。4.1 部署完成后由甲方验收。';

test('全文规划保留跨条款根风险并过滤不存在的锚点', () => {
    const plan = normalizeHolisticPlan({
        contract_summary: '思库为付款方。',
        party_alignment: { thinkpark_role: '甲方' },
        candidate_issues: [{
            title: '付款与验收未联动',
            severity: 'high',
            anchors: ['2.2 签约后支付全部款项。', '4.1 部署完成后由甲方验收。', '不存在的原文'],
            knowledge_query: '服务合同分期付款验收',
        }],
    }, contract);
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.candidates[0].anchors, [
        '2.2 签约后支付全部款项。',
        '4.1 部署完成后由甲方验收。',
    ]);
});

test('全文锚点校验不将相邻表格单元格拼成伪原文', () => {
    const plainText = [
        '方案生成套数以乙方系统后台的生成记录为准,甲方可随时查询。',
        '',
        '计量依据',
        '',
        '以乙方系统后台的方案生成记录为准(「一套方案」计量口径见本协议第 2.3.5 条)',
    ].join('\n');
    const plan = normalizeHolisticPlan({
        candidate_issues: [{
            title: '计量与查询约定',
            anchors: [
                '方案生成套数以乙方系统后台的生成记录为准,甲方可随时查询。',
                '计量依据:以乙方系统后台的方案生成记录为准',
            ],
        }],
    }, plainText);
    assert.deepEqual(plan.candidates[0].anchors, [
        '方案生成套数以乙方系统后台的生成记录为准,甲方可随时查询。',
    ]);

    const issue = materializeGroundedIssue({
        candidate: plan.candidates[0],
        plainText,
        knowledge: [{ source_type: 'weknora', source_id: 'k-table', law: '思库服务合同模板', content: '计量记录应可核对' }],
        rawIssue: {
            accepted: true,
            basis_refs: [1],
            changes: [
                {
                    operation: 'replace',
                    current_clause: '方案生成套数以乙方系统后台的生成记录为准,甲方可随时查询。',
                    suggested_text: '方案生成套数应于每月核对。',
                },
                {
                    operation: 'replace',
                    current_clause: '计量依据:以乙方系统后台的方案生成记录为准',
                    suggested_text: '计量依据:以双方核对记录为准',
                },
            ],
        },
    });
    assert.ok(issue);
    assert.equal(issue.suggestion.linked_changes.length, 1);
});

test('风险级取证形成一个根风险和多个联动修改', () => {
    const plan = normalizeHolisticPlan({
        candidate_issues: [{ title: '付款与验收未联动', anchors: ['2.2 签约后支付全部款项。'] }],
    }, contract);
    const issue = materializeGroundedIssue({
        candidate: plan.candidates[0],
        plainText: contract,
        knowledge: [{ source_type: 'weknora', source_id: 'k1', law: '思库服务合同模板', content: '付款应与验收挂钩' }],
        rawIssue: {
            accepted: true,
            severity: 'high',
            basis_refs: [1],
            changes: [
                { operation: 'replace', current_clause: '2.2 签约后支付全部款项。', suggested_text: '2.2 首付款及尾款按验收节点支付。' },
                { operation: 'replace', current_clause: '4.1 部署完成后由甲方验收。', suggested_text: '4.1 部署完成并验收合格后支付尾款。' },
            ],
        },
    });
    assert.ok(issue);
    assert.equal(issue.finding.cross_clause, true);
    assert.equal(issue.suggestion.linked_changes.length, 2);
    assert.equal(issue.finding.basis[0].source_id, 'k1');
});

test('终审合并重复根风险并拒绝不成立风险', () => {
    const makeIssue = (id, clause) => ({
        issue_id: id,
        finding: { issue_id: id, title: id, severity: 'medium', basis: [], related_clauses: [{ text: clause }] },
        suggestion: { issue_id: id, severity: 'medium', basis: [], linked_changes: [{ operation: 'replace', current_clause: clause }] },
    });
    const output = applyHolisticAdjudication([
        makeIssue('payment', '2.2 签约后支付全部款项。'),
        makeIssue('acceptance', '4.1 部署完成后由甲方验收。'),
        makeIssue('wording', '2.1 合同价款为五万元。'),
    ], {
        decisions: [
            { issue_id: 'payment', decision: 'keep', severity: 'high' },
            { issue_id: 'acceptance', decision: 'merge', merge_into: 'payment' },
            { issue_id: 'wording', decision: 'reject' },
        ],
    });
    assert.equal(output.length, 1);
    assert.equal(output[0].issue_id, 'payment');
    assert.equal(output[0].suggestion.linked_changes.length, 2);
    assert.equal(output[0].finding.severity, 'high');
    const result = buildHolisticAnalysisResult({ plan: { contract_summary: '', party_alignment: {}, candidates: [1, 2, 3] }, issues: output });
    assert.equal(result.review_mode, 'holistic');
    assert.equal(result.modification_suggestions.length, 1);
});
