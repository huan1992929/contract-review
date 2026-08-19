const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ONLYOFFICE_URL = 'http://onlyoffice';
process.env.ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || 'test-onlyoffice-secret';

const { buildOnlyOfficeConfig, normalizeOnlyOfficeDownloadUrl } = require('../services/contractAnalysis/onlyoffice');
const {
    paragraphText,
    replaceTextInXmlRuns,
    replaceTextWithRevision,
    resolveParagraphMatch,
    appendClauseToDocumentXml,
} = require('../services/contractAnalysis/docxEdit');
const {
    basisText,
    buildSimulationPrompt,
    cleanJsonResponse,
} = require('../services/negotiationSimulator');

test('ONLYOFFICE callback URLs are rewritten to the internal document server', () => {
    const normalized = normalizeOnlyOfficeDownloadUrl(
        'http://127.0.0.1:18081/onlyoffice/cache/files/output.docx?token=abc',
    );
    assert.equal(normalized, 'http://onlyoffice/cache/files/output.docx?token=abc');
});

test('ONLYOFFICE review mode tracks changes without opening the review navigator', () => {
    const contract = {
        document_key: 'doc-key',
        original_filename: 'contract.docx',
        storage_path: '/app/uploads/contract.docx',
        user_id: 1,
    };
    const reviewConfig = buildOnlyOfficeConfig(contract, 'docx', { reviewMode: true });
    const editConfig = buildOnlyOfficeConfig(contract, 'docx');
    assert.equal(reviewConfig.editorConfig.customization.review.trackChanges, true);
    assert.equal(reviewConfig.editorConfig.customization.review.showReviewChanges, false);
    assert.equal(editConfig.editorConfig.customization.review.trackChanges, false);
});

test('multi-paragraph replacement avoids inheriting a heading paragraph style', () => {
    const xml = [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第六条 双方权利义务</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>6.1 甲方负责提供施工场地。</w:t></w:r></w:p>',
        '</w:body></w:document>',
    ].join('');

    const result = replaceTextInXmlRuns(
        xml,
        '第六条 双方权利义务6.1 甲方负责提供施工场地。',
        '6.5 双方应签订安全生产管理协议。',
    );

    assert.equal(result.replaced, true);
    const headingParagraph = result.xml.match(/<w:p><w:pPr>[\s\S]*?<\/w:p>/)[0];
    assert.equal(headingParagraph.includes('6.5 双方应签订安全生产管理协议。'), false);
    assert.match(result.xml, /<w:p><w:r><w:t>6\.5 双方应签订安全生产管理协议。<\/w:t><\/w:r><\/w:p>/);
});

test('clause-aware matching preserves numbering when AI original omits the clause prefix', () => {
    const xml = [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:p><w:pPr><w:spacing w:line="360"/></w:pPr><w:r><w:t>4.5 每次付款前，乙方应提交发票。若甲方尚未取得上游资金，甲方可顺延付款。</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>4.6 乙方提交结算资料；甲方审核期限不作固定限制。</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>7.2 工程具备竣工验收条件；甲方实际使用部分工程不视为验收合格。</w:t></w:r></w:p>',
        '</w:body></w:document>',
    ].join('');

    const cases = [
        ['4.5 若甲方尚未取得上游资金，甲方可顺延付款。', '4.5 甲方不得以上游资金未到账为由顺延付款。', '4.5'],
        ['4.6 甲方审核期限不作固定限制。', '4.6 甲方应在60日内完成审核。', '4.6'],
        ['7.2 甲方实际使用部分工程不视为验收合格。', '7.2 甲方擅自使用视为相应部分验收合格。', '7.2'],
    ];
    for (const [original, suggested, clauseNo] of cases) {
        const resolved = resolveParagraphMatch(xml, original, suggested);
        assert.equal(resolved.clauseNo, clauseNo);
        assert.equal(resolved.strategy, 'clause-body');
        assert.equal(resolved.replacement.startsWith(`${clauseNo} `), false);
    }
});

test('full clause replacement restores a missing 1.2 prefix and preserves paragraph formatting', () => {
    const xml = '<w:document><w:body><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>1.2 承包方式：包工、包料。</w:t></w:r></w:p></w:body></w:document>';
    const resolved = resolveParagraphMatch(xml, '1.2 承包方式：包工、包料。', '合同总价包含安全文明施工费。');
    assert.equal(resolved.replacement, '1.2 合同总价包含安全文明施工费。');
    const direct = replaceTextInXmlRuns(resolved.paragraph.xml, resolved.matchedText, resolved.replacement);
    assert.equal(paragraphText(direct.xml), '1.2 合同总价包含安全文明施工费。');
    assert.match(direct.xml, /<w:pPr><w:jc w:val="left"\/><\/w:pPr>/);
});

test('review mode emits real Word insert and delete revisions instead of direct text mutation', () => {
    const paragraph = '<w:p><w:pPr><w:spacing w:line="360"/></w:pPr><w:r><w:rPr><w:sz w:val="26"/></w:rPr><w:t>4.6 甲方审核期限不作固定限制。</w:t></w:r></w:p>';
    const revised = replaceTextWithRevision(paragraph, { start: 4, end: 17 }, '甲方应在60日内完成审核。', {
        revisionId: 10,
        author: 'AI审查',
        date: '2026-08-18T00:00:00.000Z',
    });
    assert.match(revised, /<w:del w:id="10"/);
    assert.match(revised, /<w:ins w:id="11"/);
    assert.match(revised, /<w:delText>/);
    assert.match(revised, /<w:pPr><w:spacing w:line="360"\/><\/w:pPr>/);
    assert.match(revised, /<w:rPr><w:sz w:val="26"\/><\/w:rPr>/);
});

const documentWithParagraphs = (...paragraphs) => [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    ...paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`),
    '<w:sectPr/></w:body></w:document>',
].join('');

test('append clause inserts the next subclause inside its existing major section', () => {
    const xml = documentWithParagraphs(
        '第九条 争议解决',
        '9.1 双方应协商解决争议。',
        '第十条 其他约定',
        '10.1 本合同一式两份。',
        '甲方（盖章）：',
    );
    const result = appendClauseToDocumentXml(
        xml,
        '增加争议解决条款',
        '9.8 协商不成的，向项目所在地人民法院起诉。',
        { mode: 'review', author: 'AI审查', date: '2026-08-18T00:00:00.000Z' },
    );

    assert.equal(result.insertedClauseNo, '9.2');
    assert.deepEqual(result.placement, {
        majorSection: 9,
        subclause: '9.2',
        strategy: 'content-clause-major',
    });
    assert.ok(result.xml.indexOf('9.2 协商不成的') > result.xml.indexOf('9.1 双方应协商'));
    assert.ok(result.xml.indexOf('9.2 协商不成的') < result.xml.indexOf('第十条 其他约定'));
    assert.match(result.xml, /<w:ins w:id="1" w:author="AI审查"/);
    assert.equal(result.xml.includes('增加争议解决条款</w:t>'), false);
});

test('append clause prioritizes a structural anchor over a conflicting generated clause number', () => {
    const xml = documentWithParagraphs(
        '第二条 合同价款与费用',
        '2.1 合同价款为人民币壹万元。',
        '第九条 争议解决',
        '9.1 双方应协商解决争议。',
        '甲方（盖章）：',
    );
    const result = appendClauseToDocumentXml(
        xml,
        '增加物业费承担条款',
        '9.9 物业费由乙方承担。',
        { currentClause: '2.1 合同价款为人民币壹万元。', mode: 'edit' },
    );

    assert.equal(result.insertedClauseNo, '2.2');
    assert.equal(result.placement.strategy, 'structural-hint-major');
    assert.ok(result.xml.indexOf('2.2 物业费由乙方承担') < result.xml.indexOf('第九条 争议解决'));
    assert.equal(result.xml.includes('<w:ins'), false);
});

test('append clause accepts a heading phrase anchor without requiring a numeric hint', () => {
    const xml = documentWithParagraphs(
        '第二条 合同价款与费用',
        '2.1 合同价款为人民币壹万元。',
        '第九条 争议解决',
        '9.1 双方应协商解决争议。',
        '甲方（盖章）：',
    );
    const result = appendClauseToDocumentXml(
        xml,
        '增加诉讼管辖条款',
        '协商不成的，向项目所在地人民法院起诉。',
        { anchorHint: '争议解决', mode: 'review' },
    );

    assert.equal(result.insertedClauseNo, '9.2');
    assert.equal(result.placement.strategy, 'anchor-text-major');
    assert.ok(result.xml.indexOf('9.2 协商不成的') < result.xml.indexOf('甲方（盖章）'));
});

test('append clause creates one new major section before signatures when no section matches', () => {
    const xml = documentWithParagraphs(
        '第五条 其他约定',
        '5.1 本合同未尽事宜另行协商。',
        '甲方（盖章）：',
        '乙方（盖章）：',
    );
    const result = appendClauseToDocumentXml(
        xml,
        '增加个人信息跨境传输条款',
        '乙方不得擅自向境外传输个人信息。',
        { mode: 'review', date: '2026-08-18T00:00:00.000Z' },
    );

    assert.equal(result.createdMajor, true);
    assert.equal(result.insertedClauseNo, '6.1');
    assert.equal(result.placement.strategy, 'new-major-before-signature');
    assert.ok(result.xml.indexOf('第六条 个人信息跨境传输') < result.xml.indexOf('6.1 乙方不得擅自'));
    assert.ok(result.xml.indexOf('6.1 乙方不得擅自') < result.xml.indexOf('甲方（盖章）'));
    assert.equal((result.xml.match(/第六条/g) || []).length, 1);
    assert.equal((result.xml.match(/增加个人信息跨境传输条款/g) || []).length, 0);
    assert.equal((result.xml.match(/<w:ins\b/g) || []).length, 2);
});

test('append clause reports an existing clause without modifying the document', () => {
    const xml = documentWithParagraphs(
        '第二条 合同价款与费用',
        '2.1 物业费由乙方承担。',
        '甲方（盖章）：',
    );
    const result = appendClauseToDocumentXml(xml, '增加物业费条款', '9.9 物业费由乙方承担。', { mode: 'review' });
    assert.equal(result.alreadyPresent, true);
    assert.equal(result.xml, xml);
});

test('append clause strips a generated instruction heading and renumbers sibling subclauses', () => {
    const xml = documentWithParagraphs(
        '第九条 争议解决',
        '9.1 双方应协商解决争议。',
        '甲方（盖章）：',
    );
    const result = appendClauseToDocumentXml(
        xml,
        '增加争议解决条款',
        '增加争议解决条款\n9.7 协商不成的，可以申请调解。\n9.9 调解不成的，向人民法院起诉。',
        { mode: 'review' },
    );
    assert.match(result.xml, />9\.2 协商不成的，可以申请调解。</);
    assert.match(result.xml, />9\.3 调解不成的，向人民法院起诉。</);
    assert.equal(result.xml.includes('增加争议解决条款</w:t>'), false);
});

test('append clause rejects one suggestion that mixes unrelated major sections', () => {
    const xml = documentWithParagraphs(
        '第二条 合同价款与费用',
        '2.1 合同价款为人民币壹万元。',
        '第九条 争议解决',
        '9.1 双方应协商解决争议。',
        '甲方（盖章）：',
    );
    assert.throws(() => appendClauseToDocumentXml(
        xml,
        '增加补充条款',
        '2.8 物业费由乙方承担。\n9.8 争议向人民法院起诉。',
        { mode: 'review' },
    ), /DOCX_APPEND_MIXED_SECTIONS/);
});

test('append clause treats a signature table as the hard end of substantive terms', () => {
    const xml = [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:p><w:r><w:t>第五条 其他约定</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>5.1 本合同未尽事宜另行协商。</w:t></w:r></w:p>',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲方（盖章）：</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        '<w:p><w:r><w:t>9.1 这是历史版本错误追加到签章后的条款。</w:t></w:r></w:p>',
        '<w:sectPr/></w:body></w:document>',
    ].join('');
    const result = appendClauseToDocumentXml(
        xml,
        '增加个人信息跨境传输条款',
        '乙方不得擅自向境外传输个人信息。',
        { mode: 'review' },
    );
    assert.equal(result.insertedClauseNo, '6.1');
    assert.ok(result.xml.indexOf('6.1 乙方不得擅自') < result.xml.indexOf('<w:tbl>'));
    assert.equal(result.xml.includes('第十条'), false);
});

test('negotiation prompt accepts current_clause and basis array schema', () => {
    const suggestion = {
        title: '调整质量保修金比例',
        current_clause: '剩余 5% 作为质量保证金。',
        suggested_text: '剩余 3% 作为质量保证金。',
        basis: [{ content: '质量保修金不得超过结算总额的3%' }],
    };
    assert.equal(basisText(suggestion), '质量保修金不得超过结算总额的3%');
    const prompt = buildSimulationPrompt(suggestion, {}, '乙方');
    assert.match(prompt, /剩余 5% 作为质量保证金/);
    assert.match(prompt, /质量保修金不得超过结算总额的3%/);
});

test('negotiation JSON parser tolerates a short textual prefix', () => {
    assert.deepEqual(cleanJsonResponse('结果如下：\n{"likely_objections":[],"fallback_options":[]}'), {
        likely_objections: [],
        fallback_options: [],
    });
});
