const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    getOcrSidecarPath,
    readOcrSidecar,
} = require('../services/contractAnalysis/fileExtraction');

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
