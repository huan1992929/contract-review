const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeRiskStatus,
    riskFingerprint,
    reconcileRiskLedger,
} = require('../services/incrementalReview');

const modifiedDiff = {
    clause_id: '5.1',
    change_type: 'modified',
    old_text: '甲方应在十个工作日内验收。',
    new_text: '甲方应依据验收报告在五个工作日内验收。',
    needs_review: true,
};

test('risk fingerprint is stable across anchor and formatting changes in one clause', () => {
    const first = riskFingerprint({
        clause_id: '5.1',
        issue_type: '范本差异',
        title: '验收期限偏离',
        original_clause: '甲方应在十个工作日内验收。',
    });
    const second = riskFingerprint({
        clause_id: ' 5.1 ',
        issue_type: '范本差异',
        title: '验收期限 偏离',
        original_clause: '甲方应依据验收报告验收。',
    });
    assert.equal(first, second);
});

test('legacy revision decisions map to explicit issue ledger states', () => {
    assert.equal(normalizeRiskStatus({ application_status: 'pending_review' }), 'pending_review');
    assert.equal(normalizeRiskStatus({ application_status: 'rejected' }), 'accepted_risk');
    assert.equal(normalizeRiskStatus({ application_status: 'accepted' }), 'resolved');
    assert.equal(normalizeRiskStatus({ resolved: true }), 'resolved');
});

test('server ledger deduplicates model output and updates an existing open issue', () => {
    const existing = [{
        clause_id: '5.1',
        issue_type: '范本差异',
        title: '验收期限偏离',
        original_clause: modifiedDiff.old_text,
    }];
    const repeated = {
        clause_id: '5.1',
        issue_type: '范本差异',
        title: '验收期限偏离',
        original_clause: modifiedDiff.new_text,
        basis: [{ title: '思库合同范本' }],
    };
    const result = reconcileRiskLedger({
        contractId: 2,
        existingPoints: existing,
        newPoints: [repeated, { ...repeated }],
        diffs: [modifiedDiff],
        reviewedAt: '2026-08-21T00:00:00.000Z',
    });

    assert.equal(result.issues.length, 1);
    assert.equal(result.newRisks.length, 0);
    assert.equal(result.issues[0].original_clause, modifiedDiff.new_text);
    assert.equal(result.issues[0].issue_status, 'open');
});

test('accepted, rejected and pending decisions are not resurrected by re-review', () => {
    const statuses = ['resolved', 'accepted_risk', 'pending_review'];
    for (const issueStatus of statuses) {
        const result = reconcileRiskLedger({
            contractId: 2,
            existingPoints: [{
                clause_id: '5.1',
                issue_type: '范本差异',
                title: '验收期限偏离',
                original_clause: modifiedDiff.old_text,
                issue_status: issueStatus,
            }],
            newPoints: [{
                clause_id: '5.1',
                issue_type: '范本差异',
                title: '验收期限偏离',
                original_clause: modifiedDiff.new_text,
            }],
            diffs: [modifiedDiff],
        });
        assert.equal(result.newRisks.length, 0);
        assert.equal(result.issues[0].issue_status, issueStatus);
    }
});

test('only affected open risks disappear as resolved while unrelated risks carry forward', () => {
    const result = reconcileRiskLedger({
        contractId: 2,
        existingPoints: [
            {
                clause_id: '5.1',
                title: '验收期限偏离',
                original_clause: modifiedDiff.old_text,
            },
            {
                clause_id: '8.1',
                title: '违约责任不足',
                original_clause: '乙方违约时不承担任何责任。',
            },
        ],
        newPoints: [],
        diffs: [modifiedDiff],
        reviewedAt: '2026-08-21T00:00:00.000Z',
    });

    assert.deepEqual(result.resolvedRisks.map((item) => item.title), ['验收期限偏离']);
    assert.equal(result.issues.find((item) => item.clause_id === '5.1').issue_status, 'resolved');
    assert.equal(result.issues.find((item) => item.clause_id === '8.1').issue_status, 'open');
});
