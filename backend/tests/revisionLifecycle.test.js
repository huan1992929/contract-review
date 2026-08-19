const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const {
    paragraphText,
    replaceTextWithRevisionGroup,
    resolveRevisionGroupInXml,
    reconcilePartialRevisionGroupInXml,
    resolveRevisionGroupInDocx,
    detectRevisionGroupStatusInXml,
    syncRevisionGroupsFromDocx,
    resolveParagraphMatch,
    replaceTextInDocx,
} = require('../services/contractAnalysis/docxEdit');

const baseParagraph = '<w:p><w:pPr><w:spacing w:line="360"/></w:pPr><w:r><w:rPr><w:sz w:val="26"/></w:rPr><w:t>4.6 甲方审核期限不作固定限制。</w:t></w:r></w:p>';
const makeDocumentXml = (paragraph) => [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    paragraph,
    '<w:sectPr/></w:body></w:document>',
].join('');

const writeMinimalDocx = (filePath, documentXml) => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '</Types>',
    ].join('')));
    zip.addFile('_rels/.rels', Buffer.from([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
        '</Relationships>',
    ].join('')));
    zip.addFile('word/document.xml', Buffer.from(documentXml));
    zip.writeZip(filePath);
};

test('attachment anchor replaces only its paragraph and removes the human instruction wrapper', () => {
    const attachmentParagraph = '<w:p><w:r><w:t>四、质保期内出现问题，乙方在接到通知后 48 小时内到场维修。</w:t></w:r></w:p>';
    const mainClauseParagraph = '<w:p><w:r><w:t>7.4 乙方接到维修通知后应在 4 小时内响应、24 小时内到场。</w:t></w:r></w:p>';
    const documentXml = makeDocumentXml(`${attachmentParagraph}${mainClauseParagraph}`);
    const compositeOriginal = '附件三：四、质保期内出现问题，乙方在接到通知后 48 小时内到场维修。正文7.4 乙方接到维修通知后应在 4 小时内响应、24 小时内到场。';
    const anchor = '四、质保期内出现问题，乙方在接到通知后 48 小时内到场维修';
    const suggestion = '附件三第四条修改为：四、质保期内出现问题，乙方在接到通知后 4 小时内响应、24 小时内到场处理。逾期未处理的，按本合同第七条第7.4款执行。';
    const resolved = resolveParagraphMatch(documentXml, compositeOriginal, suggestion, [anchor]);

    assert.equal(resolved.paragraph.text, '四、质保期内出现问题，乙方在接到通知后 48 小时内到场维修。');
    assert.deepEqual(resolved.range, { start: 0, end: resolved.paragraph.text.length });
    assert.equal(resolved.replacement, '四、质保期内出现问题，乙方在接到通知后 4 小时内响应、24 小时内到场处理。逾期未处理的，按本合同第七条第7.4款执行。');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-anchor-'));
    const filePath = path.join(tempDir, 'contract.docx');
    try {
        writeMinimalDocx(filePath, documentXml);
        const result = replaceTextInDocx(filePath, compositeOriginal, suggestion, [anchor], {
            mode: 'review',
            revisionGroupId: 'attachment-group',
            suggestionId: 'suggestion-8',
        });
        const xml = new AdmZip(filePath).getEntry('word/document.xml').getData().toString('utf8');
        assert.equal(result.matchedText, '四、质保期内出现问题，乙方在接到通知后 48 小时内到场维修。');
        assert.equal((xml.match(/<w:del\b/g) || []).length, 1);
        assert.equal((xml.match(/<w:ins\b/g) || []).length, 1);
        assert.equal(xml.includes('附件三第四条修改为'), false);
        assert.equal(paragraphText(xml).includes('7.4 乙方接到维修通知后应在 4 小时内响应、24 小时内到场。'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('replacement revision persists one stable suggestion group with a delete/insert pair', () => {
    const result = replaceTextWithRevisionGroup(
        baseParagraph,
        { start: 4, end: 17 },
        '甲方应在60日内完成审核。',
        {
            revisionId: 20,
            author: 'AI审查',
            date: '2026-08-19T00:00:00.000Z',
            revisionGroupId: 'ai-group-1',
            suggestionId: 'suggestion-7',
        },
    );

    assert.equal(result.revisionGroup.group_id, 'ai-group-1');
    assert.equal(result.revisionGroup.suggestion_id, 'suggestion-7');
    assert.equal(result.revisionGroup.delete_revision_id, 20);
    assert.equal(result.revisionGroup.insert_revision_id, 21);
    assert.equal(result.revisionGroup.original_text, '甲方审核期限不作固定限制。');
    assert.equal(result.revisionGroup.suggested_text, '甲方应在60日内完成审核。');
    assert.match(result.xml, /<w:del w:id="20"/);
    assert.match(result.xml, /<w:ins w:id="21"/);
});

test('clause-numbered prefix anchor replaces the complete clause without duplicated tail', () => {
    const original = '7.3 本工程整体质量保修期为竣工验收合格之日起 24 个月。防水工程保修期为 5 年，苗木成活养护期按附件三执行。';
    const anchor = '7.3 本工程整体质量保修期为竣工验收合格之日起 24 个月';
    const compositeOriginal = `${original} 附件三：一、整体工程保修期为 12 个月。三、防水工程保修期为 2 年。`;
    const suggestion = '7.3 本工程整体质量保修期为竣工验收合格之日起 24 个月。防水工程保修期为 5 年，苗木成活养护期按附件三执行。本合同附件三与本条不一致的，以本条为准。';
    const documentXml = makeDocumentXml(`<w:p><w:r><w:t>${original}</w:t></w:r></w:p>`);
    const resolved = resolveParagraphMatch(documentXml, compositeOriginal, suggestion, [anchor]);

    assert.deepEqual(resolved.range, { start: 0, end: original.length });
    assert.equal(resolved.matchedText, original);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whole-clause-anchor-'));
    const filePath = path.join(tempDir, 'contract.docx');
    try {
        writeMinimalDocx(filePath, documentXml);
        const result = replaceTextInDocx(filePath, compositeOriginal, suggestion, [anchor], {
            mode: 'review',
            revisionGroupId: 'whole-clause-group',
            suggestionId: 'suggestion-7.3',
        });
        const xml = new AdmZip(filePath).getEntry('word/document.xml').getData().toString('utf8');
        assert.equal((xml.match(/<w:del\b/g) || []).length, 1);
        assert.equal((xml.match(/<w:ins\b/g) || []).length, 1);
        assert.equal(result.revisionGroup.original_text, original);
        assert.equal(result.revisionGroup.suggested_text, suggestion);
        assert.equal(paragraphText(xml), suggestion);
        assert.equal((paragraphText(xml).match(/7\.3/g) || []).length, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('accepting a replacement revision removes original and revision wrappers', () => {
    const revised = replaceTextWithRevisionGroup(baseParagraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
        revisionId: 30,
        revisionGroupId: 'accept-group',
        suggestionId: 'suggestion-accept',
    });
    const resolved = resolveRevisionGroupInXml(makeDocumentXml(revised.xml), revised.revisionGroup, 'accept');

    assert.equal(resolved.status, 'accepted');
    assert.equal(resolved.changed, true);
    assert.equal(resolved.xml.includes('<w:del'), false);
    assert.equal(resolved.xml.includes('<w:ins'), false);
    assert.equal(resolved.xml.includes('<w:delText'), false);
    assert.equal(paragraphText(resolved.xml).includes('甲方审核期限不作固定限制'), false);
    assert.equal(paragraphText(resolved.xml).includes('甲方应在60日内完成审核'), true);
});

test('rejecting a replacement revision restores original without deletion markup', () => {
    const revised = replaceTextWithRevisionGroup(baseParagraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
        revisionId: 40,
        revisionGroupId: 'reject-group',
        suggestionId: 'suggestion-reject',
    });
    const resolved = resolveRevisionGroupInXml(makeDocumentXml(revised.xml), revised.revisionGroup, 'reject');

    assert.equal(resolved.status, 'rejected');
    assert.equal(resolved.xml.includes('<w:del'), false);
    assert.equal(resolved.xml.includes('<w:ins'), false);
    assert.equal(resolved.xml.includes('<w:delText'), false);
    assert.equal(paragraphText(resolved.xml).includes('甲方审核期限不作固定限制'), true);
    assert.equal(paragraphText(resolved.xml).includes('甲方应在60日内完成审核'), false);
});

test('status detection recognizes acceptance when suggested text contains the full original text', () => {
    const paragraph = '<w:p><w:r><w:t>2.4 合同总价。</w:t></w:r></w:p>';
    const revised = replaceTextWithRevisionGroup(paragraph, { start: 4, end: 8 }, '合同总价包含安全文明施工费', {
        revisionId: 44,
        revisionGroupId: 'prefix-accepted',
        suggestionId: 'prefix-accepted-suggestion',
    });
    const accepted = resolveRevisionGroupInXml(makeDocumentXml(revised.xml), revised.revisionGroup, 'accept');
    assert.equal(detectRevisionGroupStatusInXml(accepted.xml, revised.revisionGroup), 'accepted');
});

test('status detection recognizes rejection when suggested text contains the full original text', () => {
    const paragraph = '<w:p><w:r><w:t>2.4 合同总价。</w:t></w:r></w:p>';
    const revised = replaceTextWithRevisionGroup(paragraph, { start: 4, end: 8 }, '合同总价包含安全文明施工费', {
        revisionId: 46,
        revisionGroupId: 'prefix-rejected',
        suggestionId: 'prefix-rejected-suggestion',
    });
    const rejected = resolveRevisionGroupInXml(makeDocumentXml(revised.xml), revised.revisionGroup, 'reject');
    assert.equal(detectRevisionGroupStatusInXml(rejected.xml, revised.revisionGroup), 'rejected');
});

test('real DOCX lifecycle atomically resolves revision pair and remains a readable OOXML package', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-lifecycle-'));
    const filePath = path.join(tempDir, 'contract.docx');
    try {
        const revised = replaceTextWithRevisionGroup(baseParagraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
            revisionId: 50,
            revisionGroupId: 'docx-group',
            suggestionId: 'docx-suggestion',
        });
        writeMinimalDocx(filePath, makeDocumentXml(revised.xml));
        assert.equal(detectRevisionGroupStatusInXml(makeDocumentXml(revised.xml), revised.revisionGroup), 'pending');

        const result = resolveRevisionGroupInDocx(filePath, revised.revisionGroup, 'accept');
        assert.equal(result.status, 'accepted');
        const reopened = new AdmZip(filePath);
        const xml = reopened.getEntry('word/document.xml').getData().toString('utf8');
        assert.equal(xml.includes('<w:del'), false);
        assert.equal(xml.includes('<w:ins'), false);
        assert.equal(paragraphText(xml), '4.6 甲方应在60日内完成审核。');
        assert.ok(reopened.getEntry('[Content_Types].xml'));
        assert.ok(reopened.getEntry('_rels/.rels'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('callback-style sync recognizes a user-accepted revision and updates suggestion state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-sync-'));
    const filePath = path.join(tempDir, 'accepted.docx');
    try {
        const revised = replaceTextWithRevisionGroup(baseParagraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
            revisionId: 60,
            revisionGroupId: 'sync-group',
            suggestionId: 'sync-suggestion',
        });
        const accepted = resolveRevisionGroupInXml(makeDocumentXml(revised.xml), revised.revisionGroup, 'accept');
        writeMinimalDocx(filePath, accepted.xml);
        const analysis = {
            modification_suggestions: [{
                application_status: 'pending_review',
                review_pending: true,
                adopted: false,
                revision_group: { ...revised.revisionGroup },
            }],
            revision_groups: [{ ...revised.revisionGroup }],
        };
        const sync = syncRevisionGroupsFromDocx(filePath, analysis);

        assert.equal(sync.changed, true);
        assert.equal(sync.results[0].status, 'accepted');
        assert.equal(analysis.modification_suggestions[0].application_status, 'applied');
        assert.equal(analysis.modification_suggestions[0].review_pending, false);
        assert.equal(analysis.modification_suggestions[0].adopted, true);
        assert.equal(analysis.modification_suggestions[0].revision_group.status, 'accepted');
        assert.equal(analysis.revision_groups[0].status, 'accepted');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

const partialRevisionCases = () => {
    const revised = replaceTextWithRevisionGroup(baseParagraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
        revisionId: 70,
        revisionGroupId: 'partial-group',
        suggestionId: 'partial-suggestion',
    });
    const documentXml = makeDocumentXml(revised.xml);
    const del = documentXml.match(/<w:del\b[^>]*w:id="70"[^>]*>[\s\S]*?<\/w:del>/)[0];
    const ins = documentXml.match(/<w:ins\b[^>]*w:id="71"[^>]*>[\s\S]*?<\/w:ins>/)[0];
    const plainOriginal = del
        .replace(/^<w:del\b[^>]*>|<\/w:del>$/g, '')
        .replace(/w:delText/g, 'w:t');
    const plainSuggestion = ins.replace(/^<w:ins\b[^>]*>|<\/w:ins>$/g, '');
    return { revisionGroup: revised.revisionGroup, cases: [
        {
            name: 'delete pending + insertion plain means accept',
            xml: documentXml.replace(ins, plainSuggestion),
            status: 'accepted',
            visible: '甲方应在60日内完成审核',
        },
        {
            name: 'delete pending + insertion absent means reject',
            xml: documentXml.replace(ins, ''),
            status: 'rejected',
            visible: '甲方审核期限不作固定限制',
        },
        {
            name: 'deletion absent + insertion pending means accept',
            xml: documentXml.replace(del, ''),
            status: 'accepted',
            visible: '甲方应在60日内完成审核',
        },
        {
            name: 'deletion plain + insertion pending means reject',
            xml: documentXml.replace(del, plainOriginal),
            status: 'rejected',
            visible: '甲方审核期限不作固定限制',
        },
    ] };
};

for (const caseName of [
    'delete pending + insertion plain means accept',
    'delete pending + insertion absent means reject',
    'deletion absent + insertion pending means accept',
    'deletion plain + insertion pending means reject',
]) {
    test(`partial revision: ${caseName}`, () => {
        const fixture = partialRevisionCases();
        const item = fixture.cases.find((candidate) => candidate.name === caseName);
        assert.equal(detectRevisionGroupStatusInXml(item.xml, fixture.revisionGroup), 'partial', item.name);
        const normalized = reconcilePartialRevisionGroupInXml(item.xml, fixture.revisionGroup);
        assert.equal(normalized.status, item.status, item.name);
        assert.equal(normalized.xml.includes('<w:del'), false, item.name);
        assert.equal(normalized.xml.includes('<w:ins'), false, item.name);
        assert.equal(normalized.xml.includes('<w:delText'), false, item.name);
        assert.equal(paragraphText(normalized.xml).includes(item.visible), true, item.name);
    });
}

test('callback sync atomically normalizes a half-resolved native revision in a real DOCX', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-partial-sync-'));
    const filePath = path.join(tempDir, 'partial.docx');
    try {
        const fixture = partialRevisionCases();
        const acceptedHalf = fixture.cases.find((item) => item.name === 'delete pending + insertion plain means accept');
        writeMinimalDocx(filePath, acceptedHalf.xml);
        const analysis = {
            modification_suggestions: [{
                application_status: 'pending_review',
                review_pending: true,
                adopted: false,
                revision_group: { ...fixture.revisionGroup },
            }],
        };
        const sync = syncRevisionGroupsFromDocx(filePath, analysis);
        const xml = new AdmZip(filePath).getEntry('word/document.xml').getData().toString('utf8');

        assert.equal(sync.changed, true);
        assert.equal(sync.documentChanged, true);
        assert.equal(sync.results[0].status, 'accepted');
        assert.equal(xml.includes('<w:del'), false);
        assert.equal(xml.includes('<w:ins'), false);
        assert.equal(paragraphText(xml).includes('甲方应在60日内完成审核'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
