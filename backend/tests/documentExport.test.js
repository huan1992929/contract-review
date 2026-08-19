const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const {
    acceptTrackedChangesInXml,
    acceptAllTrackedChanges,
    buildExportFilename,
    buildContentDisposition,
    createDocumentExport,
    findLibreOfficeBinary,
    convertDocxToPdfWithOnlyOffice,
} = require('../services/contractAnalysis/documentExport');
const {
    detectRevisionGroupStatusInDocx,
} = require('../services/contractAnalysis/docxEdit');

const REVISION_GROUP = {
    group_id: 'suggestion-1',
    suggestion_id: 'suggestion-1',
    delete_revision_id: 41,
    insert_revision_id: 42,
    original_text: '原条款内容',
    suggested_text: '建议条款内容',
};

const documentXmlForState = (state) => {
    const clauseBody = state === 'pending'
        ? '<w:del w:id="41" w:author="AI审查"><w:r><w:delText>原条款内容</w:delText></w:r></w:del><w:ins w:id="42" w:author="AI审查"><w:r><w:t>建议条款内容</w:t></w:r></w:ins>'
        : `<w:r><w:t>${state === 'accepted' ? '建议条款内容' : '原条款内容'}</w:t></w:r>`;
    return `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="ContractClause"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">1.2 </w:t></w:r>${clauseBody}</w:p><w:sectPr/></w:body></w:document>`;
};

const makeRevisionStateDocx = (filePath, state) => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
    zip.addFile('word/document.xml', Buffer.from(documentXmlForState(state)));
    zip.addFile('word/styles.xml', Buffer.from('<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/><w:style w:type="paragraph" w:styleId="ContractClause"><w:name w:val="Contract Clause"/><w:basedOn w:val="Normal"/></w:style></w:styles>'));
    zip.addFile('word/numbering.xml', Buffer.from('<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="7"/></w:num></w:numbering>'));
    zip.addFile('word/settings.xml', Buffer.from(`<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${state === 'pending' ? '<w:trackRevisions/>' : ''}</w:settings>`));
    zip.writeZip(filePath);
};

const writeExportBuffer = async (directory, name, buffer) => {
    const filePath = path.join(directory, name);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
};

const assertNumberingAndStylePreserved = (sourcePath, exportedPath) => {
    const sourceZip = new AdmZip(sourcePath);
    const exportedZip = new AdmZip(exportedPath);
    assert.deepEqual(exportedZip.readFile('word/styles.xml'), sourceZip.readFile('word/styles.xml'));
    assert.deepEqual(exportedZip.readFile('word/numbering.xml'), sourceZip.readFile('word/numbering.xml'));
    const documentXml = exportedZip.readAsText('word/document.xml');
    assert.match(documentXml, /<w:pStyle w:val="ContractClause"\/>/);
    assert.match(documentXml, /<w:numPr>[\s\S]*?<w:numId w:val="7"\/>[\s\S]*?<\/w:numPr>/);
};

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

test('DOCX export matrix remains compatible with pending, accepted, and rejected paired revisions', async (t) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-export-state-matrix-'));
    t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));

    const states = [
        {
            state: 'pending', variant: 'review', expectedStatus: 'pending',
            expectedText: '建议条款内容', unexpectedText: '', keepsRevisions: true,
        },
        {
            state: 'pending', variant: 'final', expectedStatus: 'accepted',
            expectedText: '建议条款内容', unexpectedText: '原条款内容', keepsRevisions: false,
        },
        {
            state: 'accepted', variant: 'review', expectedStatus: 'accepted',
            expectedText: '建议条款内容', unexpectedText: '原条款内容', keepsRevisions: false,
        },
        {
            state: 'accepted', variant: 'final', expectedStatus: 'accepted',
            expectedText: '建议条款内容', unexpectedText: '原条款内容', keepsRevisions: false,
        },
        {
            state: 'rejected', variant: 'review', expectedStatus: 'rejected',
            expectedText: '原条款内容', unexpectedText: '建议条款内容', keepsRevisions: false,
        },
        {
            state: 'rejected', variant: 'final', expectedStatus: 'rejected',
            expectedText: '原条款内容', unexpectedText: '建议条款内容', keepsRevisions: false,
        },
    ];

    for (const scenario of states) {
        const source = path.join(tempDir, `${scenario.state}-source.docx`);
        if (!fs.existsSync(source)) makeRevisionStateDocx(source, scenario.state);
        const exported = await createDocumentExport({
            sourcePath: source,
            originalFilename: `${scenario.state}.docx`,
            variant: scenario.variant,
            format: 'docx',
        });
        const outputPath = await writeExportBuffer(
            tempDir,
            `${scenario.state}-${scenario.variant}.docx`,
            exported.buffer,
        );
        const documentXml = new AdmZip(outputPath).readAsText('word/document.xml');
        if (scenario.keepsRevisions) {
            assert.match(documentXml, /<w:del\b[^>]*w:id="41"/);
            assert.match(documentXml, /<w:ins\b[^>]*w:id="42"/);
            assert.match(documentXml, /原条款内容/);
            assert.match(documentXml, /建议条款内容/);
        } else {
            assert.doesNotMatch(documentXml, /<w:(?:ins|del)\b/);
            assert.match(documentXml, new RegExp(scenario.expectedText));
            assert.doesNotMatch(documentXml, new RegExp(scenario.unexpectedText));
        }
        assert.equal(detectRevisionGroupStatusInDocx(outputPath, REVISION_GROUP), scenario.expectedStatus);
        assertNumberingAndStylePreserved(source, outputPath);

        const { value: parsedText } = await mammoth.extractRawText({ path: outputPath });
        assert.match(parsedText, /1\.2/);
        assert.match(parsedText, new RegExp(scenario.expectedText));
        if (!scenario.keepsRevisions) assert.doesNotMatch(parsedText, new RegExp(scenario.unexpectedText));
    }
});

test('OnlyOffice native accept/reject save shapes remain parseable and export idempotently', async (t) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-native-resolution-'));
    t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));

    for (const state of ['accepted', 'rejected']) {
        const source = path.join(tempDir, `onlyoffice-${state}.docx`);
        makeRevisionStateDocx(source, state);
        assert.equal(detectRevisionGroupStatusInDocx(source, REVISION_GROUP), state);

        const beforeXml = new AdmZip(source).readAsText('word/document.xml');
        const exported = await createDocumentExport({
            sourcePath: source,
            originalFilename: `onlyoffice-${state}.docx`,
            variant: 'final',
            format: 'docx',
        });
        const outputPath = await writeExportBuffer(tempDir, `onlyoffice-${state}-final.docx`, exported.buffer);
        const afterXml = new AdmZip(outputPath).readAsText('word/document.xml');
        assert.equal(afterXml, beforeXml);
        assert.equal(detectRevisionGroupStatusInDocx(outputPath, REVISION_GROUP), state);
        const { value } = await mammoth.extractRawText({ path: outputPath });
        assert.match(value, state === 'accepted' ? /建议条款内容/ : /原条款内容/);
    }
});

test('download filename carries ASCII fallback and UTF-8 filename', () => {
    assert.equal(buildExportFilename('众安合同.docx', 'review', 'pdf'), '众安合同-审阅版.pdf');
    const header = buildContentDisposition('众安合同-最终版.docx');
    assert.match(header, /filename="contract-final\.docx"/);
    assert.match(header, /filename\*=UTF-8''/);
});

test('OnlyOffice PDF conversion publishes an unguessable temporary source and cleans it', async (t) => {
    const axios = require('axios');
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-export-test-'));
    const publicDir = path.join(tempDir, 'public-files');
    const source = path.join(tempDir, 'source.docx');
    await fs.promises.writeFile(source, 'docx-placeholder');
    t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));

    const originalPost = axios.post;
    const originalGet = axios.get;
    let sourceUrl;
    axios.post = async (_url, body) => {
        sourceUrl = body.url;
        const publicName = decodeURIComponent(new URL(body.url).pathname.split('/').pop());
        assert.ok(fs.existsSync(path.join(publicDir, 'export-temp', publicName)));
        assert.ok(body.token);
        return { data: { endConvert: true, fileUrl: 'http://onlyoffice/cache/output.pdf' } };
    };
    axios.get = async () => ({ data: Buffer.from('%PDF-test') });
    t.after(() => { axios.post = originalPost; axios.get = originalGet; });

    const output = await convertDocxToPdfWithOnlyOffice(source, tempDir, {
        onlyOfficeUrl: 'http://onlyoffice',
        backendUrl: 'http://backend:3000',
        jwtSecret: 'test-secret',
        publicFilesDir: publicDir,
    });
    assert.equal((await fs.promises.readFile(output)).subarray(0, 4).toString(), '%PDF');
    assert.match(sourceUrl, /^http:\/\/backend:3000\/files\/export-temp\/[0-9a-f-]+\.docx$/);
    assert.deepEqual(await fs.promises.readdir(path.join(publicDir, 'export-temp')), []);
});

test('PDF export converts the selected DOCX variant when LibreOffice is available', { skip: !findLibreOfficeBinary() }, async () => {
    const source = path.join(__dirname, '..', '..', 'offer-demo.docx');
    const output = await createDocumentExport({ sourcePath: source, originalFilename: 'offer-demo.docx', variant: 'final', format: 'pdf' });
    assert.equal(output.contentType, 'application/pdf');
    assert.equal(output.filename, 'offer-demo-最终版.pdf');
    assert.ok(output.buffer.length > 1000);
    assert.equal(output.buffer.subarray(0, 4).toString(), '%PDF');
});
