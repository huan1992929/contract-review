const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../database');
const {
    candidateReadiness,
    sanitizeVerification,
    TARGET_JURISDICTIONS,
} = require('../services/knowledgeGovernance');

const readyCandidate = () => ({
    source_url: 'https://official.example/law',
    content_chars: 1200,
    metadata: {
        official_url: 'https://official.example/law',
        full_text_verified: true,
        content_chars: 1200,
        content_sha256: 'a'.repeat(64),
        jurisdiction: 'HK',
        currentness_verified: true,
        currentness_basis: '官方现行版本页面已核对',
        official_version_date: '2026-08-19',
        source_language: 'zh-Hant',
        translation_status: 'official_original_only',
    },
});

test('candidate readiness requires source, full text, hash, jurisdiction, version and language governance', () => {
    assert.equal(candidateReadiness(readyCandidate()).ready, true);

    const missingCurrentness = readyCandidate();
    missingCurrentness.metadata.currentness_verified = false;
    const result = candidateReadiness(missingCurrentness);
    assert.equal(result.ready, false);
    assert.equal(result.checks.validity, false);

    const missingBasis = readyCandidate();
    delete missingBasis.metadata.currentness_basis;
    const missingBasisResult = candidateReadiness(missingBasis);
    assert.equal(missingBasisResult.ready, false);
    assert.equal(missingBasisResult.checks.currentness_basis, false);
});

test('translated materials require provenance and verification input is allowlisted', () => {
    assert.throws(
        () => sanitizeVerification({ translation_status: 'translated' }),
        /翻译来源/,
    );
    assert.deepEqual(sanitizeVerification({
        translation_status: 'translated',
        translation_provenance: 'Official bilingual gazette',
        currentness_verified: true,
        ignored_field: 'not persisted',
    }), {
        translation_status: 'translated',
        translation_provenance: 'Official bilingual gazette',
        currentness_verified: true,
    });
});

test('coverage target includes Hong Kong, Macau, Northeast Asia and Southeast Asia', () => {
    const codes = TARGET_JURISDICTIONS.map((entry) => entry.code);
    ['HK', 'MO', 'JP', 'KR', 'SG', 'MY', 'BN', 'TH', 'VN', 'ID', 'PH', 'KH', 'LA', 'MM']
        .forEach((code) => assert.ok(codes.includes(code), `missing ${code}`));
});

test.after(async () => {
    await db.destroy();
});
