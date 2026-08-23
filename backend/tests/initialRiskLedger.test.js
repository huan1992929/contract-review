const test = require('node:test');
const assert = require('node:assert/strict');

const {
    collectInitialRiskCandidates,
    buildInitialLedgerProjection,
} = require('../services/initialRiskLedger');
const { scopeRiskIssueKey } = require('../services/incrementalReview');

test('scopes identical governed risk ids to each contract without losing idempotency', () => {
    const governedId = 'tp-risk-tp-supplier-acceptance-002-a3e5f70c6e08edbc';
    const firstContractKey = scopeRiskIssueKey(8, governedId);
    const secondContractKey = scopeRiskIssueKey(9, governedId);

    assert.notEqual(firstContractKey, secondContractKey);
    assert.equal(scopeRiskIssueKey(8, firstContractKey), firstContractKey);
    assert.ok(firstContractKey.length <= 64);
    assert.ok(secondContractKey.length <= 64);
});

test('initial ledger merges legacy aliases and attaches matching modification text', () => {
    const finding = {
        title: '验收后未保留尾款',
        original_clause: '合同签订后一次性支付全款。',
        severity: 'high',
    };
    const candidates = collectInitialRiskCandidates({
        dispute_points: [finding],
        compliance_findings: [{ ...finding }],
        modification_suggestions: [{
            title: '验收后未保留尾款修改',
            current_clause: finding.original_clause,
            suggested_text: '验收合格后支付剩余20%。',
        }],
    });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].suggested_text, '验收合格后支付剩余20%。');

    const projection = buildInitialLedgerProjection({
        contractId: 8,
        analysisResult: { dispute_points: [finding], compliance_findings: [{ ...finding }] },
        reviewedAt: '2026-08-23T00:00:00.000Z',
    });
    assert.equal(projection.issues.length, 1);
    assert.match(projection.issues[0].issue_id, /^risk_/);
    assert.equal(projection.issues[0].issue_status, 'open');
});

test('initial ledger includes internal rules and missing clauses without a model finding', () => {
    const projection = buildInitialLedgerProjection({
        contractId: 9,
        analysisResult: {
            hard_violations: [{
                rule_id: 'TP-SUPPLIER-PAYMENT-001',
                description: '首次合作供应商不得全额预付',
                matched_text: '甲方于签约当日支付100%。',
            }],
            missing_clauses: [{ title: '缺少书面验收标准' }],
        },
    });

    assert.equal(projection.issues.length, 2);
    assert.equal(projection.issues.find((item) => item.risk_code === 'TP-SUPPLIER-PAYMENT-001').severity, 'high');
    assert.equal(projection.issues.find((item) => item.source_bucket === 'missing_clause').issue_status, 'open');
});

test('human-decided ledger status is sticky during a full-review upsert', () => {
    const analysisResult = {
        dispute_points: [{
            title: '验收期限偏离',
            original_clause: '甲方在30日内验收。',
            clause_id: '5.1',
        }],
    };
    const first = buildInitialLedgerProjection({ contractId: 10, analysisResult });
    const existing = first.issues.map((issue) => ({
        issue_key: issue.issue_id,
        fingerprint: issue.risk_fingerprint,
        clause_id: issue.clause_id,
        status: 'accepted_risk',
        payload: { ...issue, issue_status: 'accepted_risk' },
    }));
    const rerun = buildInitialLedgerProjection({ contractId: 10, analysisResult, existingRows: existing });
    assert.equal(rerun.issues.length, 1);
    assert.equal(rerun.issues[0].issue_status, 'accepted_risk');
});
