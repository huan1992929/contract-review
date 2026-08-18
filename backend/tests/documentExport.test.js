const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const {
    acceptTrackedChangesInXml,
    acceptAllTrackedChanges,
    buildExportFilename,
    buildContentDisposition,
    createDocumentExport,
    findLibreOfficeBinary,
} = require('../services/contractAnalysis/documentExport');

const makeTrackedDocx = (filePath) => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
    zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>1.1 </w:t></w:r><w:del w:id="1"><w:r><w:delText>旧条款</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>新条款</w:t></w:r></w:ins></w:p><w:sectPr/></w:body></w:document>'));
    zip.addFile('word/styles.xml', Buffer.from('<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>'));
    zip.addFile('word/numbering.xml', Buffer.from('<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>'));
    zip.addFile('word/settings.xml', Buffer.from('<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>'));
    zip.writeZip(filePath);
};

test('acceptTrackedChangesInXml keeps insertions and removes deletions and revision metadata', () => {
    const xml = '<w:p><w:del w:id="1"><w:r><w:delText>旧</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>新</w:t></w:r></w:ins><w:rPrChange w:id="3"><w:rPr/></w:rPrChange></w:p>';
    const accepted = acceptTrackedChangesInXml(xml);
    assert.match(accepted, /<w:t>新<\/w:t>/);
    assert.doesNotMatch(accepted, /旧|w:ins|w:del|w:rPrChange/);
});

test('final DOCX accepts revisions without modifying source, styles, or numbering', async (t) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-export-test-'));
    t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
    const source = path.join(tempDir, 'source.docx');
    const target = path.join(tempDir, 'final.docx');
    makeTrackedDocx(source);
    const sourceBefore = await fs.promises.readFile(source);
    const sourceZip = new AdmZip(source);
    const sourceStyles = sourceZip.readFile('word/styles.xml');
    const sourceNumbering = sourceZip.readFile('word/numbering.xml');

    acceptAllTrackedChanges(source, target);
    assert.deepEqual(await fs.promises.readFile(source), sourceBefore);
    const targetZip = new AdmZip(target);
    const documentXml = targetZip.readAsText('word/document.xml');
    const settingsXml = targetZip.readAsText('word/settings.xml');
    assert.match(documentXml, /1\.1/);
    assert.match(documentXml, /新条款/);
    assert.doesNotMatch(documentXml, /旧条款|<w:ins\b|<w:del\b/);
    assert.doesNotMatch(settingsXml, /w:trackRevisions/);
    assert.deepEqual(targetZip.readFile('word/styles.xml'), sourceStyles);
    assert.deepEqual(targetZip.readFile('word/numbering.xml'), sourceNumbering);
});

test('review DOCX is byte-identical while final DOCX has accepted revisions', async (t) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-export-service-test-'));
    t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
    const source = path.join(tempDir, 'source.docx');
    makeTrackedDocx(source);
    const review = await createDocumentExport({ sourcePath: source, originalFilename: '测试合同.docx', variant: 'review', format: 'docx' });
    const final = await createDocumentExport({ sourcePath: source, originalFilename: '测试合同.docx', variant: 'final', format: 'docx' });
    assert.deepEqual(review.buffer, await fs.promises.readFile(source));
    assert.notDeepEqual(final.buffer, review.buffer);
    assert.equal(review.filename, '测试合同-审阅版.docx');
    assert.equal(final.filename, '测试合同-最终版.docx');
});

test('download filename carries ASCII fallback and UTF-8 filename', () => {
    assert.equal(buildExportFilename('众安合同.docx', 'review', 'pdf'), '众安合同-审阅版.pdf');
    const header = buildContentDisposition('众安合同-最终版.docx');
    assert.match(header, /filename="contract-final\.docx"/);
    assert.match(header, /filename\*=UTF-8''/);
});

test('PDF export converts the selected DOCX variant when LibreOffice is available', { skip: !findLibreOfficeBinary() }, async () => {
    const source = path.join(__dirname, '..', '..', 'offer-demo.docx');
    const output = await createDocumentExport({ sourcePath: source, originalFilename: 'offer-demo.docx', variant: 'final', format: 'pdf' });
    assert.equal(output.contentType, 'application/pdf');
    assert.equal(output.filename, 'offer-demo-最终版.pdf');
    assert.ok(output.buffer.length > 1000);
    assert.equal(output.buffer.subarray(0, 4).toString(), '%PDF');
});
