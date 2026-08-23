const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    getOcrSidecarPath,
    readOcrSidecar,
    rejectTrackedChangesInXml,
    materializeTrackedReviewParagraphsInXml,
} = require('../services/contractAnalysis/fileExtraction');

test('review baseline rejects pending Word revisions without treating advice as contract text', () => {
    const xml = '<w:p><w:r><w:t>原付款条款</w:t></w:r>'
        + '<w:del w:id="1"><w:r><w:delText>原验收约定</w:delText></w:r></w:del>'
        + '<w:ins w:id="2"><w:r><w:t>AI 建议验收约定</w:t></w:r></w:ins></w:p>';
    const baseline = rejectTrackedChangesInXml(xml);
    assert.match(baseline, /原付款条款/);
    assert.match(baseline, /原验收约定/);
    assert.doesNotMatch(baseline, /AI 建议验收约定/);
    assert.doesNotMatch(baseline, /w:(?:ins|del)\b/);
});

test('full review text materializes both original and existing revision as one annotated clause', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + '<w:p><w:del w:id="1" w:author="系统管理员"><w:r><w:delText>原付款条款</w:delText></w:r></w:del>'
        + '<w:ins w:id="2" w:author="系统管理员"><w:r><w:t>已有分期付款意见</w:t></w:r></w:ins></w:p>'
        + '</w:body></w:document>';
    const reviewXml = materializeTrackedReviewParagraphsInXml(xml);
    assert.match(reviewXml, /【修订前原文】原付款条款/);
    assert.match(reviewXml, /【已有修订意见（系统管理员）】已有分期付款意见/);
    assert.doesNotMatch(reviewXml, /<w:(?:ins|del)\b/);
});

test('OCR sidecar uses a deterministic adjacent path', () => {
    assert.equal(getOcrSidecarPath('/app/uploads/contract.pdf'), '/app/uploads/contract.pdf.ocr.txt');
});

test('OCR sidecar is returned only when it contains meaningful text', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-ocr-sidecar-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const pdfPath = path.join(tempDir, 'scan.pdf');
    const sidecarPath = getOcrSidecarPath(pdfPath);

    assert.equal(readOcrSidecar(pdfPath), null);
    fs.writeFileSync(sidecarPath, '少量文本', 'utf8');
    assert.equal(readOcrSidecar(pdfPath), null);

    const ocrText = '第一条 合同主体与采购范围。'.repeat(8);
    fs.writeFileSync(sidecarPath, ocrText, 'utf8');
    assert.equal(readOcrSidecar(pdfPath), ocrText);
});
