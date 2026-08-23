/**
 * @file services/contractAnalysis/docxEdit.js
 * @brief 条款感知的 DOCX 文本定位、直接编辑与审阅修订
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const { randomUUID } = require('crypto');

const escapeXmlText = (text) => String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeXmlAttr = (text) => escapeXmlText(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const unescapeXmlText = (text) => String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const normalizeForDocxMatch = (text) => {
    const normalized = [];
    const indexMap = [];
    for (let index = 0; index < String(text || '').length; index += 1) {
        const char = String(text)[index]
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[：]/g, ':')
            .replace(/[，]/g, ',')
            .replace(/[。]/g, '.');
        if (/\s/.test(char)) continue;
        normalized.push(char);
        indexMap.push(index);
    }
    return { value: normalized.join(''), indexMap };
};

const findDocxTextRange = (fullText, candidate) => {
    const exactIndex = fullText.indexOf(candidate);
    if (exactIndex >= 0) return { start: exactIndex, end: exactIndex + candidate.length };
    const normalizedFull = normalizeForDocxMatch(fullText);
    const normalizedCandidate = normalizeForDocxMatch(candidate).value;
    if (!normalizedCandidate) return null;
    const normalizedIndex = normalizedFull.value.indexOf(normalizedCandidate);
    if (normalizedIndex < 0) return null;
    return {
        start: normalizedFull.indexMap[normalizedIndex],
        end: normalizedFull.indexMap[normalizedIndex + normalizedCandidate.length - 1] + 1,
    };
};

const isHeadingParagraphAt = (xml, position) => {
    const paragraphStart = Math.max(xml.lastIndexOf('<w:p>', position), xml.lastIndexOf('<w:p ', position));
    if (paragraphStart < 0) return false;
    const paragraphEnd = xml.indexOf('</w:p>', position);
    if (paragraphEnd < 0) return false;
    return /<w:pStyle\b[^>]*w:val="(?:Heading\d*|Title|标题\d*)"/i
        .test(xml.slice(paragraphStart, paragraphEnd + 6));
};

const paragraphText = (paragraphXml) => {
    const withoutDeletedRevisions = String(paragraphXml || '').replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
    return (withoutDeletedRevisions.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) || [])
        .map((node) => unescapeXmlText(node.replace(/^<w:t\b[^>]*>|<\/w:t>$/g, '')))
        .join('');
};

const parseClausePrefix = (text) => {
    const value = String(text || '').trim();
    const match = value.match(/^(\d+(?:\.\d+)+)\s*/);
    return match
        ? { clauseNo: match[1], body: value.slice(match[0].length).trim() }
        : { clauseNo: '', body: value };
};

const ensureClauseNumber = (replacement, clauseNo) => {
    if (!clauseNo) return String(replacement || '').trim();
    const replacementInfo = parseClausePrefix(replacement);
    if (replacementInfo.clauseNo) return String(replacement || '').trim();
    return `${clauseNo} ${String(replacement || '').trim()}`.trim();
};

const CHINESE_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

const parseChineseArticleNumber = (value) => {
    const text = String(value || '').trim();
    if (/^\d+$/.test(text)) return Number(text);
    if (!text || !/^[\u96f6〇一二两三四五六七八九十百]+$/.test(text)) return 0;
    let total = 0;
    let current = 0;
    for (const char of text) {
        if (char === '百') {
            total += (current || 1) * 100;
            current = 0;
        } else if (char === '十') {
            total += (current || 1) * 10;
            current = 0;
        } else {
            current = CHINESE_DIGITS[char] ?? current;
        }
    }
    return total + current;
};

const toChineseArticleNumber = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) return String(value || '');
    const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (number < 10) return digits[number];
    if (number < 20) return `十${number % 10 ? digits[number % 10] : ''}`;
    if (number < 100) return `${digits[Math.floor(number / 10)]}十${number % 10 ? digits[number % 10] : ''}`;
    return String(number);
};

const parseArticleHeading = (text) => {
    const match = String(text || '').trim().match(/^第\s*([\d零〇一二两三四五六七八九十百]+)\s*条[\s、：:.-]*(.*)$/);
    if (!match) return null;
    const major = parseChineseArticleNumber(match[1]);
    return major > 0 ? { major, title: match[2].trim() } : null;
};

const parseMinorClauseNumber = (text) => {
    const match = String(text || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?[\s、：:.-]*/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        clauseNo: `${Number(match[1])}.${Number(match[2])}`,
        body: String(text || '').trim().slice(match[0].length).trim(),
    };
};

const tableContextAt = (xml, position) => {
    const tableStart = xml.lastIndexOf('<w:tbl', position);
    const tableEnd = xml.lastIndexOf('</w:tbl>', position);
    return { insideTable: tableStart > tableEnd, tableStart };
};

const collectParagraphRecords = (documentXml) => {
    const records = [];
    const pattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let match;
    while ((match = pattern.exec(documentXml)) !== null) {
        const text = paragraphText(match[0]).trim();
        const tableContext = tableContextAt(documentXml, match.index);
        records.push({
            xml: match[0],
            start: match.index,
            end: match.index + match[0].length,
            text,
            article: parseArticleHeading(text),
            clause: parseMinorClauseNumber(text),
            directBodyParagraph: !tableContext.insideTable,
            tableStart: tableContext.insideTable ? tableContext.tableStart : -1,
        });
    }
    return records;
};

const APPEND_THEMES = [
    ['争议', '仲裁', '诉讼', '管辖', '鉴定'],
    ['不可抗力', '免责'],
    ['保密', '数据', '信息安全', '知识产权', '成果'],
    ['价款', '付款', '结算', '发票', '费用', '租金', '物业费', '能耗'],
    ['工期', '进度', '节点', '延期', '逾期'],
    ['质量', '验收', '保修', '质保'],
    ['变更', '签证'],
    ['安全', '保险', '文明施工'],
    ['解除', '终止', '取消'],
    ['违约', '赔偿', '责任'],
    ['权利义务', '甲方义务', '乙方义务'],
    ['转让', '分包', '转包'],
];

const inferAppendTheme = (title, content) => {
    const titleText = String(title || '');
    const contentText = String(content || '');
    return APPEND_THEMES.find((theme) => theme.some((keyword) => titleText.includes(keyword)))
        || APPEND_THEMES.find((theme) => theme.some((keyword) => contentText.includes(keyword)))
        || [];
};

const cleanMajorHeadingTitle = (title, content) => {
    const source = String(title || '').trim()
        .replace(/^(?:新增|增加|补充|完善|明确|调整|规范)+/, '')
        .replace(/(?:条款|约定|内容)$/, '')
        .trim();
    if (source) return source;
    const firstSentence = String(content || '').replace(/^\d+(?:\.\d+)+[\s、：:.-]*/, '').split(/[\u3002；;\n]/)[0].trim();
    return firstSentence.slice(0, 24) || '补充约定';
};

const paragraphProperties = (paragraphXml) => (
    String(paragraphXml || '').match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || ''
);

const runProperties = (paragraphXml) => (
    String(paragraphXml || '').match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || ''
);

const buildInsertedParagraph = (text, templateXml, revision) => {
    const pPr = paragraphProperties(templateXml);
    const rPr = runProperties(templateXml);
    const run = makeRun(text, rPr);
    const body = revision
        ? `<w:ins w:id="${revision.id}" w:author="${escapeXmlAttr(revision.author)}" w:date="${escapeXmlAttr(revision.date)}">${run}</w:ins>`
        : run;
    return `<w:p>${pPr}${body}</w:p>`;
};

const findSafeContractEnd = (documentXml, records) => {
    const signaturePattern = /(?:甲方|乙方)[\s（(]*(?:签字|盖章|签章|授权代表)|以下无正文|签约日期/;
    const signature = records.find((record) => signaturePattern.test(record.text));
    if (signature) return signature.tableStart >= 0 ? signature.tableStart : signature.start;
    const sectionIndex = documentXml.lastIndexOf('<w:sectPr');
    if (sectionIndex >= 0) return sectionIndex;
    const bodyEnd = documentXml.lastIndexOf('</w:body>');
    if (bodyEnd >= 0) return bodyEnd;
    throw new Error('DOCX_BODY_NOT_FOUND');
};

const appendClauseToDocumentXml = (documentXml, title, content, options = {}) => {
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) throw new Error('DOCX_APPEND_CONTENT_EMPTY');
    const allRecords = collectParagraphRecords(documentXml);
    const safeEnd = findSafeContractEnd(documentXml, allRecords);
    const records = allRecords.filter((record) => record.directBodyParagraph && record.start < safeEnd);
    const searchableRecords = allRecords.filter((record) => record.start < safeEnd);
    const rawContentLines = normalizedContent.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
    const normalizedTitle = normalizeForDocxMatch(title).value;
    const contentLines = rawContentLines.filter((line, index) => {
        if (index > 0) return true;
        const normalizedLine = normalizeForDocxMatch(line).value;
        if (normalizedTitle && normalizedLine === normalizedTitle) return false;
        return !/^(?:新增|增加|补充|完善|明确|调整|规范).{1,40}(?:条款|约定)$/.test(line);
    });
    if (!contentLines.length) throw new Error('DOCX_APPEND_CONTENT_EMPTY');
    const explicitContentClauses = contentLines.map(parseMinorClauseNumber).filter(Boolean);
    const explicitMajors = [...new Set(explicitContentClauses.map((clause) => clause.major))];
    if (explicitMajors.length > 1) throw new Error('DOCX_APPEND_MIXED_SECTIONS');
    const contentClause = parseMinorClauseNumber(contentLines[0] || '');
    const rawStructuralHint = String(
        options.targetClauseNo || options.anchorHint || options.currentClause || '',
    ).trim();
    const structuralHintClause = parseMinorClauseNumber(rawStructuralHint);
    const structuralArticleHint = parseArticleHeading(rawStructuralHint);
    const normalizedNeedles = (explicitContentClauses.length
        ? explicitContentClauses.map((clause) => clause.body)
        : [contentLines.join('')]
    ).map((value) => normalizeForDocxMatch(value).value).filter((value) => value.length >= 8);
    const duplicate = normalizedNeedles.length > 0 && normalizedNeedles.every((needle) => (
        searchableRecords.some((record) => {
            const haystack = normalizeForDocxMatch(parseMinorClauseNumber(record.text)?.body || record.text).value;
            return haystack === needle || haystack.includes(needle);
        })
    ));
    if (duplicate) {
        return {
            xml: documentXml,
            alreadyPresent: true,
            insertedClauseNo: contentClause?.clauseNo || '',
            placement: {
                majorSection: contentClause?.major || null,
                subclause: contentClause?.clauseNo || null,
                strategy: 'already-present',
            },
        };
    }

    const structuralRecords = records.filter((record) => record.article || record.clause);
    const majors = new Map();
    for (const record of structuralRecords) {
        const major = record.article?.major || record.clause?.major;
        if (!majors.has(major)) majors.set(major, { major, records: [], heading: '' });
        const group = majors.get(major);
        group.records.push(record);
        if (record.article?.title) group.heading = record.article.title;
    }

    let targetMajor = 0;
    let placementStrategy = '';
    if (structuralHintClause && majors.has(structuralHintClause.major)) {
        targetMajor = structuralHintClause.major;
        placementStrategy = 'structural-hint-major';
    } else if (structuralArticleHint && majors.has(structuralArticleHint.major)) {
        targetMajor = structuralArticleHint.major;
        placementStrategy = 'article-hint-major';
    }
    if (!targetMajor) {
        const targetHeadingSource = options.targetHeading
            || options.anchorHint
            || (!/^(?:合同(?:全文)?|本合同)?\s*(?:未|没有)(?:约定|提及|包含|明确|设置|规定|涉及)/.test(String(options.currentClause || '').trim())
                ? options.currentClause
                : '');
        const targetHeading = normalizeForDocxMatch(targetHeadingSource).value;
        const headingGroup = [...majors.values()].find((candidate) => {
            const normalizedHeading = normalizeForDocxMatch(candidate.heading).value;
            if (targetHeading.length < 2) return false;
            if (normalizedHeading && (normalizedHeading.includes(targetHeading) || targetHeading.includes(normalizedHeading))) return true;
            return targetHeading.length >= 4 && candidate.records.some((record) => (
                normalizeForDocxMatch(record.text).value.includes(targetHeading)
            ));
        });
        if (headingGroup) {
            targetMajor = headingGroup.major;
            placementStrategy = 'anchor-text-major';
        }
    }
    if (!targetMajor && contentClause && majors.has(contentClause.major)) {
        targetMajor = contentClause.major;
        placementStrategy = 'content-clause-major';
    }
    if (!targetMajor) {
        const theme = inferAppendTheme(title, normalizedContent);
        if (theme.length) {
            let best = { major: 0, score: 0 };
            for (const group of majors.values()) {
                const heading = group.heading;
                const groupText = group.records.map((record) => record.text).join(' ');
                const score = theme.reduce((total, keyword) => (
                    total + (heading.includes(keyword) ? 5 : 0) + (groupText.includes(keyword) ? 1 : 0)
                ), 0);
                if (score > best.score) best = { major: group.major, score };
            }
            if (best.score > 0) {
                targetMajor = best.major;
                placementStrategy = 'semantic-major';
            }
        }
    }

    const maxMajor = Math.max(0, ...majors.keys());
    const createdMajor = !targetMajor;
    if (createdMajor) {
        targetMajor = maxMajor + 1;
        placementStrategy = 'new-major-before-signature';
    }
    const group = majors.get(targetMajor);
    const maxMinor = Math.max(0, ...((group?.records || []).map((record) => record.clause?.minor || 0)));
    const nextMinor = maxMinor + 1;
    const insertedClauseNo = `${targetMajor}.${nextMinor}`;
    let allocatedMinor = nextMinor;
    const numberedLines = contentLines.map((line, index) => {
        const parsed = parseMinorClauseNumber(line);
        if (index === 0 || parsed) {
            const body = parsed?.body || line;
            const value = `${targetMajor}.${allocatedMinor} ${body}`.trim();
            allocatedMinor += 1;
            return value;
        }
        return line;
    });

    let insertionOffset = safeEnd;
    if (group?.records?.length) {
        const firstGroupOffset = Math.min(...group.records.map((record) => record.start));
        const nextGroupRecord = structuralRecords.find((record) => {
            const major = record.article?.major || record.clause?.major;
            return record.start > firstGroupOffset && major !== targetMajor;
        });
        insertionOffset = Math.min(nextGroupRecord?.start ?? safeEnd, safeEnd);
    }

    const clauseTemplate = [...(group?.records || [])].reverse().find((record) => record.clause)?.xml
        || [...structuralRecords].reverse().find((record) => record.clause)?.xml
        || '';
    const headingTemplate = [...structuralRecords].reverse().find((record) => record.article)?.xml
        || '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>';
    const maxRevisionId = Math.max(0, ...(documentXml.match(/w:id="(\d+)"/g) || [])
        .map((value) => Number(value.match(/\d+/)?.[0] || 0)));
    let revisionId = maxRevisionId + 1;
    const revisionBase = options.mode === 'review'
        ? { author: options.author || 'AI审查', date: options.date || new Date().toISOString() }
        : null;
    const nextRevision = () => (revisionBase ? { ...revisionBase, id: revisionId++ } : null);
    const parts = [];
    if (createdMajor) {
        const heading = `第${toChineseArticleNumber(targetMajor)}条 ${cleanMajorHeadingTitle(title, normalizedContent)}`;
        parts.push(buildInsertedParagraph(heading, headingTemplate, nextRevision()));
    }
    for (const line of numberedLines) {
        parts.push(buildInsertedParagraph(line, clauseTemplate, nextRevision()));
    }
    const insertXml = parts.join('');
    return {
        xml: `${documentXml.slice(0, insertionOffset)}${insertXml}${documentXml.slice(insertionOffset)}`,
        alreadyPresent: false,
        insertedClauseNo,
        targetMajor,
        createdMajor,
        placement: {
            majorSection: targetMajor,
            subclause: insertedClauseNo,
            strategy: placementStrategy,
        },
        insertionOffset,
    };
};

const appendClauseInDocx = (filePath, title, content, options = {}) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    const documentXml = entry.getData().toString('utf8');
    const result = appendClauseToDocumentXml(documentXml, title, content, options);
    if (!result.alreadyPresent) {
        zip.updateFile('word/document.xml', Buffer.from(result.xml, 'utf8'));
        zip.writeZip(filePath);
    }
    const { xml, ...metadata } = result;
    return metadata;
};

const replaceTextInXmlRuns = (xml, candidate, suggestedText) => {
    const replacementLines = String(suggestedText ?? '').split(/\r?\n/).filter((line) => line.trim());
    if (replacementLines.length > 1) throw new Error('DOCX_MULTI_PARAGRAPH_REPLACEMENT_UNSUPPORTED');
    const textRunPattern = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
    const runs = [];
    let match;
    let fullText = '';
    while ((match = textRunPattern.exec(xml)) !== null) {
        const decodedText = unescapeXmlText(match[2]);
        runs.push({
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
            attrs: match[1],
            rawText: match[2],
            text: decodedText,
            start: fullText.length,
            end: fullText.length + decodedText.length,
            isHeading: isHeadingParagraphAt(xml, match.index),
        });
        fullText += decodedText;
    }
    const range = findDocxTextRange(fullText, candidate);
    if (!range) return { xml, replaced: false };
    const overlappingRuns = runs.filter((run) => run.end > range.start && run.start < range.end);
    const insertionRun = overlappingRuns.find((run) => !run.isHeading) || overlappingRuns[0];
    const safeSuggestion = replacementLines[0] ?? '';
    const parts = [];
    let cursor = 0;
    for (const run of runs) {
        parts.push(xml.slice(cursor, run.matchStart));
        cursor = run.matchEnd;
        if (run.end <= range.start || run.start >= range.end) {
            parts.push(`<w:t${run.attrs}>${run.rawText}</w:t>`);
            continue;
        }
        const overlapStart = Math.max(range.start, run.start) - run.start;
        const overlapEnd = Math.min(range.end, run.end) - run.start;
        const before = run.text.slice(0, overlapStart);
        const after = run.text.slice(overlapEnd);
        let nextText = run.start <= range.start ? before : '';
        if (run === insertionRun) nextText += safeSuggestion;
        if (run.end >= range.end) nextText += after;
        const attrs = /^\s/.test(nextText) || /\s$/.test(nextText)
            ? (run.attrs.includes('xml:space=') ? run.attrs : `${run.attrs} xml:space="preserve"`)
            : run.attrs;
        parts.push(`<w:t${attrs}>${escapeXmlText(nextText)}</w:t>`);
    }
    parts.push(xml.slice(cursor));
    return { xml: parts.join(''), replaced: true };
};

const makeRun = (text, runProperties = '', textTag = 'w:t') => {
    if (!text) return '';
    const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
    return `<w:r>${runProperties}<${textTag}${preserve}>${escapeXmlText(text)}</${textTag}></w:r>`;
};

const replaceTextWithRevision = (paragraphXml, range, replacement, options = {}) => {
    return replaceTextWithRevisionGroup(paragraphXml, range, replacement, options).xml;
};

const pairedWholeParagraphBookmarks = (paragraphXml, range, textLength) => {
    const starts = String(paragraphXml || '').match(/<w:bookmarkStart\b[^>]*\/>/g) || [];
    const ends = String(paragraphXml || '').match(/<w:bookmarkEnd\b[^>]*\/>/g) || [];
    if (!starts.length && !ends.length) return { starts: [], ends: [] };

    const wholeParagraph = range?.start === 0 && range?.end === textLength;
    const bookmarkId = (tag) => tag.match(/\bw:id=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find(Boolean) || '';
    const startIds = starts.map(bookmarkId);
    const endIds = ends.map(bookmarkId);
    const balanced = startIds.length === endIds.length
        && startIds.every((id) => id && startIds.filter((candidate) => candidate === id).length === 1)
        && endIds.every((id) => id && endIds.filter((candidate) => candidate === id).length === 1)
        && startIds.every((id) => endIds.includes(id));

    // A complete paragraph replacement may safely retain locally paired
    // navigation/risk bookmarks by expanding their range over the new tracked
    // revision. Partial or cross-paragraph bookmarks remain fail-closed.
    if (!wholeParagraph || !balanced) throw new Error('DOCX_COMPLEX_PARAGRAPH_UNSUPPORTED');
    return { starts, ends };
};

/**
 * Build one logical AI suggestion as a stable Word revision group.
 *
 * Word itself stores a replacement as two independent revisions (w:del + w:ins).
 * The returned metadata is persisted with the review suggestion so the server can
 * later accept/reject both halves as one atomic operation.
 */
const replaceTextWithRevisionGroup = (paragraphXml, range, replacement, options = {}) => {
    if (/<w:(?:hyperlink|fldChar|instrText|commentRangeStart|commentRangeEnd|commentReference|ins|del)\b/.test(paragraphXml)) {
        throw new Error('DOCX_COMPLEX_PARAGRAPH_UNSUPPORTED');
    }
    const text = paragraphText(paragraphXml);
    const bookmarks = pairedWholeParagraphBookmarks(paragraphXml, range, text.length);
    const oldText = text.slice(range.start, range.end);
    const startTag = paragraphXml.match(/^<w:p\b[^>]*>/)?.[0] || '<w:p>';
    const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || '';
    const runProperties = paragraphXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || '';
    const before = text.slice(0, range.start);
    const after = text.slice(range.end);
    const id = Number(options.revisionId || 1);
    const author = escapeXmlAttr(options.author || 'AI审查');
    const date = escapeXmlAttr(options.date || new Date().toISOString());
    const groupId = String(options.revisionGroupId || `revision-${id}-${id + 1}`);
    const suggestionId = String(options.suggestionId || groupId);
    const deleted = oldText
        ? `<w:del w:id="${id}" w:author="${author}" w:date="${date}">${makeRun(oldText, runProperties, 'w:delText')}</w:del>`
        : '';
    const inserted = replacement
        ? `<w:ins w:id="${id + 1}" w:author="${author}" w:date="${date}">${makeRun(replacement, runProperties)}</w:ins>`
        : '';
    return {
        xml: `${startTag}${pPr}${bookmarks.starts.join('')}${makeRun(before, runProperties)}${deleted}${inserted}${makeRun(after, runProperties)}${bookmarks.ends.join('')}</w:p>`,
        revisionGroup: {
            group_id: groupId,
            suggestion_id: suggestionId,
            author: options.author || 'AI审查',
            delete_revision_id: oldText ? id : null,
            insert_revision_id: replacement ? id + 1 : null,
            original_text: oldText,
            suggested_text: String(replacement || ''),
            paragraph_prefix: before,
            paragraph_suffix: after,
            status: 'pending',
            created_at: options.date || new Date().toISOString(),
        },
    };
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const revisionElementPattern = (type, revisionId) => new RegExp(
    `<w:${type}\\b[^>]*\\bw:id=(?:"${escapeRegExp(revisionId)}"|'${escapeRegExp(revisionId)}')[^>]*>[\\s\\S]*?<\\/w:${type}>`,
    'g',
);

const revisionElementMatches = (documentXml, type, revisionId) => {
    if (revisionId === undefined || revisionId === null || revisionId === '') return [];
    return String(documentXml || '').match(revisionElementPattern(type, revisionId)) || [];
};

const revisionElementText = (elementXml) => (String(elementXml || '')
    .match(/<w:(?:t|delText)\b[^>]*>[\s\S]*?<\/w:(?:t|delText)>/g) || [])
    .map((node) => unescapeXmlText(node.replace(/^<w:(?:t|delText)\b[^>]*>|<\/w:(?:t|delText)>$/g, '')))
    .join('');

const revisionElementAuthor = (elementXml) => unescapeXmlText(
    String(elementXml || '').match(/\bw:author=(?:"([^"]*)"|'([^']*)')/)?.slice(1).find(Boolean) || '',
);

const pendingApplicationStatus = (status) => ['pending', 'pending_review'].includes(String(status || ''));

const makeRevisionPlanningError = (code, details = {}) => {
    const error = new Error(code);
    Object.assign(error, details);
    return error;
};

/**
 * Recover a stale revision pair by its exact deleted/inserted text when the
 * database IDs and the DOCX IDs drift apart after an out-of-order ONLYOFFICE
 * save. Requiring one delete and one insert in the same paragraph, exact text
 * equality and a unique document-wide match keeps this fallback narrowly
 * scoped to the rejected suggestion being re-applied.
 */
const findRevisionGroupByContent = (documentXml, revisionGroup = {}) => {
    const original = normalizedText(revisionGroup.original_text);
    const suggested = normalizedText(revisionGroup.suggested_text);
    if (!original || !suggested) return null;

    const paragraphs = String(documentXml || '').match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
    const candidates = paragraphs.flatMap((paragraph) => {
        const deletions = paragraph.match(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g) || [];
        const insertions = paragraph.match(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g) || [];
        if (deletions.length !== 1 || insertions.length !== 1) return [];
        if (normalizedText(revisionElementText(deletions[0])) !== original
            || normalizedText(revisionElementText(insertions[0])) !== suggested) return [];
        const deleteId = deletions[0].match(/\bw:id=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find(Boolean);
        const insertId = insertions[0].match(/\bw:id=(?:"([^"]+)"|'([^']+)')/)?.slice(1).find(Boolean);
        if (deleteId === undefined || insertId === undefined) return [];
        return [{
            ...revisionGroup,
            delete_revision_id: deleteId,
            insert_revision_id: insertId,
        }];
    });
    return candidates.length === 1 ? candidates[0] : null;
};

const unwrapDeletedRevision = (elementXml) => String(elementXml || '')
    .replace(/^<w:del\b[^>]*>/, '')
    .replace(/<\/w:del>$/, '')
    .replace(/<w:delText\b/g, '<w:t')
    .replace(/<\/w:delText>/g, '</w:t>');

const unwrapInsertedRevision = (elementXml) => String(elementXml || '')
    .replace(/^<w:ins\b[^>]*>/, '')
    .replace(/<\/w:ins>$/, '');

const normalizedContains = (haystack, needle) => {
    const normalizedNeedle = normalizeForDocxMatch(needle).value;
    if (!normalizedNeedle) return false;
    return normalizeForDocxMatch(haystack).value.includes(normalizedNeedle);
};

const normalizedText = (value) => normalizeForDocxMatch(value).value;

const visibleParagraphTexts = (documentXml) => {
    const paragraphs = String(documentXml || '').match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
    return paragraphs.map((paragraph) => paragraphText(paragraph));
};

const containsIndependentOriginal = (visibleText, originalText, suggestedText) => {
    const visible = normalizedText(visibleText);
    const original = normalizedText(originalText);
    const suggested = normalizedText(suggestedText);
    if (!original) return false;
    if (!suggested) return visible.includes(original);
    const suggestionIndex = visible.indexOf(suggested);
    if (suggestionIndex < 0) return visible.includes(original);
    const outsideSuggestion = `${visible.slice(0, suggestionIndex)}${visible.slice(suggestionIndex + suggested.length)}`;
    return outsideSuggestion.includes(original);
};

/**
 * Best-effort status detection after a document was edited inside ONLYOFFICE.
 * Pending is authoritative while the persisted revision IDs still exist. Once
 * Word removes the wrappers, visible text is compared with the exact text that
 * was written for this suggestion.
 */
const detectRevisionGroupStatusInXml = (documentXml, revisionGroup = {}) => {
    const expectsDelete = revisionGroup.delete_revision_id !== undefined
        && revisionGroup.delete_revision_id !== null;
    const expectsInsert = revisionGroup.insert_revision_id !== undefined
        && revisionGroup.insert_revision_id !== null;
    const hasDelete = expectsDelete
        ? revisionElementMatches(documentXml, 'del', revisionGroup.delete_revision_id).length === 1
        : false;
    const hasInsert = expectsInsert
        ? revisionElementMatches(documentXml, 'ins', revisionGroup.insert_revision_id).length === 1
        : false;
    const expectedCount = Number(expectsDelete) + Number(expectsInsert);
    const presentCount = Number(hasDelete) + Number(hasInsert);
    if (expectedCount > 0 && presentCount === expectedCount) return 'pending';
    if (presentCount > 0) return 'partial';

    const paragraphs = visibleParagraphTexts(documentXml);
    const acceptedParagraph = normalizedText(
        `${revisionGroup.paragraph_prefix || ''}${revisionGroup.suggested_text || ''}${revisionGroup.paragraph_suffix || ''}`,
    );
    const rejectedParagraph = normalizedText(
        `${revisionGroup.paragraph_prefix || ''}${revisionGroup.original_text || ''}${revisionGroup.paragraph_suffix || ''}`,
    );
    if (acceptedParagraph && paragraphs.some((text) => normalizedText(text) === acceptedParagraph)) return 'accepted';
    if (rejectedParagraph && paragraphs.some((text) => normalizedText(text) === rejectedParagraph)) return 'rejected';

    const visibleText = paragraphs.join('\n');
    const hasOriginal = normalizedContains(visibleText, revisionGroup.original_text);
    const hasSuggested = normalizedContains(visibleText, revisionGroup.suggested_text);
    if (revisionGroup.suggested_text && hasSuggested
        && !containsIndependentOriginal(visibleText, revisionGroup.original_text, revisionGroup.suggested_text)) return 'accepted';
    if (revisionGroup.original_text && hasOriginal && !hasSuggested) return 'rejected';
    if (!revisionGroup.suggested_text && !hasOriginal) return 'accepted';
    if (!revisionGroup.original_text && !hasSuggested) return 'rejected';
    return 'resolved_unknown';
};

/**
 * Resolve both halves of one replacement revision in-memory. The caller writes
 * the returned XML to a temporary DOCX and renames it, making the file update
 * atomic and preventing half-accepted replacement suggestions.
 */
const resolveRevisionGroupInXml = (documentXml, revisionGroup = {}, resolution) => {
    if (!['accept', 'reject'].includes(resolution)) throw new Error('INVALID_REVISION_RESOLUTION');
    const expectedStatus = resolution === 'accept' ? 'accepted' : 'rejected';
    const currentStatus = detectRevisionGroupStatusInXml(documentXml, revisionGroup);
    if (currentStatus !== 'pending') {
        if (currentStatus === expectedStatus) {
            return { xml: documentXml, status: currentStatus, changed: false, alreadyResolved: true };
        }
        const error = new Error('REVISION_GROUP_NOT_PENDING');
        error.currentStatus = currentStatus;
        throw error;
    }

    const deleteMatches = revisionElementMatches(documentXml, 'del', revisionGroup.delete_revision_id);
    const insertMatches = revisionElementMatches(documentXml, 'ins', revisionGroup.insert_revision_id);
    if (deleteMatches.length > 1 || insertMatches.length > 1) throw new Error('REVISION_GROUP_AMBIGUOUS');

    let xml = String(documentXml);
    if (resolution === 'accept') {
        if (deleteMatches[0]) xml = xml.replace(deleteMatches[0], '');
        if (insertMatches[0]) xml = xml.replace(insertMatches[0], unwrapInsertedRevision(insertMatches[0]));
    } else {
        if (deleteMatches[0]) xml = xml.replace(deleteMatches[0], unwrapDeletedRevision(deleteMatches[0]));
        if (insertMatches[0]) xml = xml.replace(insertMatches[0], '');
    }
    return { xml, status: expectedStatus, changed: true, alreadyResolved: false };
};

const revisionParagraphContext = (documentXml, revisionElement) => {
    if (!revisionElement) return String(documentXml || '');
    const elementStart = String(documentXml).indexOf(revisionElement);
    if (elementStart < 0) return String(documentXml || '');
    const paragraphStart = Math.max(
        String(documentXml).lastIndexOf('<w:p>', elementStart),
        String(documentXml).lastIndexOf('<w:p ', elementStart),
    );
    const paragraphEnd = String(documentXml).indexOf('</w:p>', elementStart);
    if (paragraphStart < 0 || paragraphEnd < 0) return String(documentXml || '');
    return String(documentXml).slice(paragraphStart, paragraphEnd + 6);
};

/**
 * ONLYOFFICE can save a replacement after the user resolves only one half of
 * its delete/insert pair. Infer the user's intent from the ordinary text next
 * to the surviving wrapper, then normalize the whole logical suggestion.
 */
const reconcilePartialRevisionGroupInXml = (documentXml, revisionGroup = {}) => {
    const deleteMatch = revisionElementMatches(documentXml, 'del', revisionGroup.delete_revision_id)[0] || '';
    const insertMatch = revisionElementMatches(documentXml, 'ins', revisionGroup.insert_revision_id)[0] || '';
    if (Boolean(deleteMatch) === Boolean(insertMatch)) {
        return { xml: documentXml, status: detectRevisionGroupStatusInXml(documentXml, revisionGroup), changed: false };
    }

    let xml = String(documentXml);
    if (deleteMatch) {
        const visibleContext = paragraphText(revisionParagraphContext(xml, deleteMatch));
        const insertionWasAccepted = normalizedContains(visibleContext, revisionGroup.suggested_text);
        xml = xml.replace(deleteMatch, insertionWasAccepted ? '' : unwrapDeletedRevision(deleteMatch));
        return { xml, status: insertionWasAccepted ? 'accepted' : 'rejected', changed: true };
    }

    const insertContext = revisionParagraphContext(xml, insertMatch);
    const visibleContext = paragraphText(insertContext.replace(insertMatch, ''));
    const deletionWasRejected = normalizedContains(visibleContext, revisionGroup.original_text);
    xml = xml.replace(insertMatch, deletionWasRejected ? '' : unwrapInsertedRevision(insertMatch));
    return { xml, status: deletionWasRejected ? 'rejected' : 'accepted', changed: true };
};

/**
 * A stale ONLYOFFICE save can upload the previous pending revision pair after
 * the application has already recorded that suggestion as rejected. Before a
 * rejected suggestion is re-applied, remove only its persisted revision IDs
 * and restore the original paragraph. Other revisions, comments and fields
 * remain protected by the normal complex-paragraph guard.
 */
const normalizeRejectedRevisionBeforeReapply = (documentXml, revisionGroup = {}, applicationStatus = '') => {
    if (applicationStatus !== 'rejected' || !revisionGroup?.group_id) {
        return { xml: documentXml, status: '', changed: false };
    }
    const currentStatus = detectRevisionGroupStatusInXml(documentXml, revisionGroup);
    if (currentStatus === 'rejected') {
        return { xml: documentXml, status: currentStatus, changed: false };
    }
    if (currentStatus === 'pending') {
        const resolved = resolveRevisionGroupInXml(documentXml, revisionGroup, 'reject');
        return { xml: resolved.xml, status: resolved.status, changed: resolved.changed };
    }
    if (currentStatus === 'partial') {
        const reconciled = reconcilePartialRevisionGroupInXml(documentXml, revisionGroup);
        if (reconciled.status === 'rejected') return reconciled;
    }
    const recoveredGroup = findRevisionGroupByContent(documentXml, revisionGroup);
    if (recoveredGroup) {
        const resolved = resolveRevisionGroupInXml(documentXml, recoveredGroup, 'reject');
        return { xml: resolved.xml, status: resolved.status, changed: resolved.changed };
    }
    const error = new Error('REVISION_GROUP_NOT_PENDING');
    error.currentStatus = currentStatus;
    throw error;
};

/**
 * Restore the baseline of the application's own pending replacement before a
 * newer suggestion supersedes it. Unlike stale-revision recovery, this path is
 * deliberately strict: IDs, text, suggestion identity and author must all
 * match. A pending revision created by a person or another round is never
 * removed by content similarity.
 */
const normalizePendingRevisionBeforeSupersede = (
    documentXml,
    revisionGroup = {},
    applicationStatus = '',
    options = {},
) => {
    if (!pendingApplicationStatus(applicationStatus)) {
        return { xml: documentXml, status: '', changed: false };
    }
    if (!revisionGroup?.group_id) {
        throw makeRevisionPlanningError('REVISION_GROUP_ID_REQUIRED');
    }
    const expectedAuthor = String(options.author || revisionGroup.author || 'AI审查');
    const expectedSuggestionId = String(options.suggestionId || '');
    if (expectedSuggestionId && revisionGroup.suggestion_id
        && String(revisionGroup.suggestion_id) !== expectedSuggestionId) {
        throw makeRevisionPlanningError('REVISION_GROUP_SUGGESTION_MISMATCH');
    }
    if (revisionGroup.author && String(revisionGroup.author) !== expectedAuthor) {
        throw makeRevisionPlanningError('REVISION_GROUP_AUTHOR_MISMATCH');
    }

    const deleteMatches = revisionElementMatches(documentXml, 'del', revisionGroup.delete_revision_id);
    const insertMatches = revisionElementMatches(documentXml, 'ins', revisionGroup.insert_revision_id);
    const expectsDelete = revisionGroup.delete_revision_id !== undefined
        && revisionGroup.delete_revision_id !== null;
    const expectsInsert = revisionGroup.insert_revision_id !== undefined
        && revisionGroup.insert_revision_id !== null;
    if ((expectsDelete && deleteMatches.length !== 1) || (expectsInsert && insertMatches.length !== 1)) {
        throw makeRevisionPlanningError(
            deleteMatches.length > 1 || insertMatches.length > 1
                ? 'REVISION_GROUP_AMBIGUOUS'
                : 'REVISION_GROUP_NOT_PENDING',
        );
    }

    const elements = [...deleteMatches, ...insertMatches];
    if (elements.some((element) => revisionElementAuthor(element) !== expectedAuthor)) {
        throw makeRevisionPlanningError('REVISION_GROUP_AUTHOR_MISMATCH');
    }
    if (expectsDelete && revisionElementText(deleteMatches[0]) !== String(revisionGroup.original_text || '')) {
        throw makeRevisionPlanningError('REVISION_GROUP_CONTENT_MISMATCH');
    }
    if (expectsInsert && revisionElementText(insertMatches[0]) !== String(revisionGroup.suggested_text || '')) {
        throw makeRevisionPlanningError('REVISION_GROUP_CONTENT_MISMATCH');
    }
    const currentStatus = detectRevisionGroupStatusInXml(documentXml, revisionGroup);
    if (currentStatus !== 'pending') {
        throw makeRevisionPlanningError('REVISION_GROUP_NOT_PENDING', { currentStatus });
    }
    const resolved = resolveRevisionGroupInXml(documentXml, revisionGroup, 'reject');
    return {
        xml: resolved.xml,
        status: 'superseded',
        changed: resolved.changed,
        previousRevisionGroup: revisionGroup,
    };
};

const normalizePreviousRevisionForReplacement = (documentXml, options = {}) => {
    if (pendingApplicationStatus(options.previousApplicationStatus)) {
        return normalizePendingRevisionBeforeSupersede(
            documentXml,
            options.previousRevisionGroup,
            options.previousApplicationStatus,
            options,
        );
    }
    return normalizeRejectedRevisionBeforeReapply(
        documentXml,
        options.previousRevisionGroup,
        options.previousApplicationStatus,
    );
};

const resolveRevisionGroupInDocx = (filePath, revisionGroup, resolution) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    const result = resolveRevisionGroupInXml(entry.getData().toString('utf8'), revisionGroup, resolution);
    if (result.changed) {
        zip.updateFile('word/document.xml', Buffer.from(result.xml, 'utf8'));
        zip.writeZip(filePath);
    }
    return {
        status: result.status,
        changed: result.changed,
        alreadyResolved: result.alreadyResolved,
        groupId: revisionGroup?.group_id || '',
        suggestionId: revisionGroup?.suggestion_id || '',
    };
};

const detectRevisionGroupStatusInDocx = (filePath, revisionGroup) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    return detectRevisionGroupStatusInXml(entry.getData().toString('utf8'), revisionGroup);
};

const syncRevisionGroupsFromDocx = (filePath, analysis = {}) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    let documentXml = entry.getData().toString('utf8');
    const suggestions = Array.isArray(analysis.modification_suggestions)
        ? analysis.modification_suggestions
        : [];
    const results = [];
    let changed = false;
    let documentChanged = false;
    for (let index = 0; index < suggestions.length; index += 1) {
        const item = suggestions[index];
        const groups = Array.isArray(item?.revision_groups) && item.revision_groups.length
            ? item.revision_groups
            : (item?.revision_group ? [item.revision_group] : []);
        if (!groups.length) continue;
        let groupChanged = false;
        for (const group of groups) {
            if (!['pending', 'partial', 'pending_review'].includes(group.status || 'pending')) continue;
            let status = detectRevisionGroupStatusInXml(documentXml, group);
            if (status === 'partial') {
                const reconciled = reconcilePartialRevisionGroupInXml(documentXml, group);
                documentXml = reconciled.xml;
                status = reconciled.status;
                documentChanged = documentChanged || reconciled.changed;
            }
            if (status === group.status || (status === 'pending' && group.status === 'pending_review')) continue;
            group.status = status;
            group.synced_at = new Date().toISOString();
            if (Array.isArray(analysis.revision_groups)) {
                const registered = analysis.revision_groups.find((candidate) => candidate?.group_id === group.group_id);
                if (registered) Object.assign(registered, group);
            }
            groupChanged = true;
        }
        const statuses = groups.map((group) => group.status === 'pending_review' ? 'pending' : (group.status || 'pending'));
        const status = statuses.every((value) => value === 'accepted')
            ? 'accepted'
            : (statuses.every((value) => value === 'rejected') ? 'rejected' : 'pending');
        results.push({
            index,
            suggestionId: groups[0].suggestion_id || '',
            groupId: groups[0].group_id || '',
            groupIds: groups.map((group) => group.group_id || ''),
            status,
        });
        if (!groupChanged) continue;
        item.revision_group = groups[0];
        item.revision_groups = groups;
        if (status === 'accepted') {
            item.application_status = 'applied';
            item.review_pending = false;
            item.adopted = true;
            item.resolved_at = new Date().toISOString();
        } else if (status === 'rejected') {
            item.application_status = 'rejected';
            item.review_pending = false;
            item.adopted = false;
            item.resolved_at = new Date().toISOString();
        } else {
            item.application_status = 'pending_review';
            item.review_pending = true;
            item.adopted = false;
        }
        changed = true;
    }
    if (documentChanged) {
        zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
        const tempPath = `${filePath}.revision-sync-${randomUUID()}.tmp`;
        try {
            zip.writeZip(tempPath);
            fs.renameSync(tempPath, filePath);
        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    }
    return { analysis, changed, documentChanged, results };
};

// AI review output can describe one conflict by concatenating a main clause and
// an attachment excerpt even though they live in separate DOCX paragraphs. If
// the value starts with a numbered clause, retain the leading clause as a safe
// structural candidate. The boundary deliberately requires an attachment or
// another explicitly labelled main-text excerpt so ordinary sentences such as
// "按附件三执行" are not truncated.
const primaryClauseCandidate = (text) => {
    const value = String(text || '').trim();
    if (!parseClausePrefix(value).clauseNo) return '';
    const match = value.match(
        /^(\d+(?:\.\d+)+\s+[\s\S]*?[。；;])\s*(?=(?:附件(?:[一二三四五六七八九十百\d]+)(?:[：:]|第)|正文\s*\d+(?:\.\d+)+))/u,
    );
    return match?.[1]?.trim() || '';
};

const normalizeReplacementCandidates = (originalText, originalCandidates = []) => {
    const candidates = [originalText, ...originalCandidates, primaryClauseCandidate(originalText)]
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = normalizeForDocxMatch(candidate).value;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

// Review suggestions sometimes contain an instruction wrapper intended for a
// human reader (for example "附件三第四条修改为：..."). The wrapper is not part
// of the contract text and must never be written into the DOCX.
const stripReplacementInstructionPrefix = (text) => String(text || '').trim().replace(
    /^[^：:\n]{0,80}(?:修改为|调整为|替换为|修订为|改为)\s*[：:]\s*/,
    '',
).trim();

const withoutTerminalPunctuation = (text) => String(text || '').trim().replace(/[。；;，,！!？?：:]+$/u, '');

const coversWholeParagraphIgnoringTerminalPunctuation = (paragraphTextValue, needle) => {
    const paragraph = normalizeForDocxMatch(withoutTerminalPunctuation(paragraphTextValue)).value;
    const candidate = normalizeForDocxMatch(withoutTerminalPunctuation(needle)).value;
    return Boolean(paragraph && candidate && paragraph === candidate);
};

const replacementParagraphs = (text) => String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Fail closed when a text suggestion changes the structural scope of its
 * anchor. A plain text replacement cannot safely turn one title/paragraph
 * into a multi-paragraph preamble; doing so would put every line inside the
 * matched paragraph and inherit its alignment/style.
 */
const assertReplacementScopeCompatible = (resolved, suggestedText) => {
    const paragraphs = replacementParagraphs(stripReplacementInstructionPrefix(suggestedText));
    if (paragraphs.length > 1) throw new Error('DOCX_MULTI_PARAGRAPH_REPLACEMENT_UNSUPPORTED');

    const replacement = paragraphs[0] || '';
    const paragraphLength = normalizeForDocxMatch(resolved?.paragraph?.text).value.length;
    const matchedLength = normalizeForDocxMatch(resolved?.matchedText).value.length;
    const replacementLength = normalizeForDocxMatch(replacement).value.length;
    const wholeParagraph = resolved?.range?.start === 0
        && resolved?.range?.end === String(resolved?.paragraph?.text || '').length;
    const styledHeading = /<w:pStyle\b[^>]*w:val="(?:Heading\d*|Title|标题\d*)"/i
        .test(String(resolved?.paragraph?.xml || ''));
    const centeredParagraph = /<w:jc\b[^>]*w:val="center"/i
        .test(String(resolved?.paragraph?.xml || ''));
    const titleLikeParagraph = styledHeading || centeredParagraph;

    // Short headings such as a contract title are only locators. They must not
    // authorize insertion of a complete party block or contract preamble.
    const shortTitleExpandedIntoBlock = wholeParagraph
        && titleLikeParagraph
        && paragraphLength <= 32
        && replacementLength >= 48
        && replacementLength > paragraphLength * 2;
    const tinyPartialAnchorExpandedIntoBlock = !wholeParagraph
        && matchedLength <= 16
        && replacementLength >= 48
        && replacementLength > matchedLength * 3;
    const headingExpandedIntoBody = titleLikeParagraph
        && replacementLength >= 48
        && replacementLength > Math.max(paragraphLength * 2, 40);
    if (shortTitleExpandedIntoBlock || tinyPartialAnchorExpandedIntoBlock || headingExpandedIntoBody) {
        throw new Error('DOCX_REPLACEMENT_SCOPE_MISMATCH');
    }
};

// A short clause-numbered anchor (for example "7.3 本工程整体质量保修期…")
// identifies the paragraph, not merely the prefix to overwrite. If the AI
// suggestion is also a complete clause with the same number, retaining the
// unmatched paragraph tail creates duplicated text after the inserted
// revision. Promote that match to the complete paragraph so review mode emits
// one paired deletion/insertion for the whole clause.
const shouldReplaceWholeClauseParagraph = (paragraphTextValue, needle, replacement, range) => {
    if (!range || range.start !== 0 || range.end >= String(paragraphTextValue || '').length) return false;
    const paragraphInfo = parseClausePrefix(paragraphTextValue);
    const needleInfo = parseClausePrefix(needle);
    const replacementInfo = parseClausePrefix(stripReplacementInstructionPrefix(replacement));
    return Boolean(
        paragraphInfo.clauseNo
        && paragraphInfo.clauseNo === needleInfo.clauseNo
        && paragraphInfo.clauseNo === replacementInfo.clauseNo,
    );
};

const resolveParagraphMatch = (documentXml, originalText, suggestedText, originalCandidates = []) => {
    const paragraphs = [];
    const pattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let match;
    while ((match = pattern.exec(documentXml)) !== null) {
        paragraphs.push({ xml: match[0], start: match.index, end: match.index + match[0].length, text: paragraphText(match[0]) });
    }
    const candidates = normalizeReplacementCandidates(originalText, originalCandidates);
    const findMatches = (bodyOnly) => {
        const found = [];
        for (const candidate of candidates) {
            const source = parseClausePrefix(candidate);
            const needle = bodyOnly ? source.body : candidate;
            if (!needle || (bodyOnly && !source.clauseNo)) continue;
            for (let index = 0; index < paragraphs.length; index += 1) {
                const paragraph = paragraphs[index];
                const target = parseClausePrefix(paragraph.text);
                if (bodyOnly && target.clauseNo !== source.clauseNo) continue;
                let range = findDocxTextRange(paragraph.text, needle);
                if (!range) continue;
                // When the anchor omits only the terminal punctuation, replace
                // the complete paragraph so the old full stop is not left after
                // the inserted clause.
                if (coversWholeParagraphIgnoringTerminalPunctuation(paragraph.text, needle)) {
                    range = { start: 0, end: paragraph.text.length };
                }
                let replacement = stripReplacementInstructionPrefix(suggestedText);
                if (shouldReplaceWholeClauseParagraph(paragraph.text, needle, replacement, range)) {
                    range = { start: 0, end: paragraph.text.length };
                }
                const replacementInfo = parseClausePrefix(replacement);
                if (bodyOnly && replacementInfo.clauseNo === source.clauseNo) replacement = replacementInfo.body;
                if (!bodyOnly && source.clauseNo && !replacementInfo.clauseNo) {
                    replacement = ensureClauseNumber(replacement, source.clauseNo);
                }
                found.push({
                    paragraphIndex: index,
                    paragraph,
                    range,
                    matchedText: paragraph.text.slice(range.start, range.end),
                    replacement,
                    clauseNo: source.clauseNo || target.clauseNo,
                    strategy: bodyOnly ? 'clause-body' : 'exact-paragraph-text',
                });
            }
            if (found.length) break;
        }
        return found;
    };
    let matches = findMatches(false);
    if (!matches.length) matches = findMatches(true);
    if (!matches.length) {
        const joinedParagraphs = normalizeForDocxMatch(paragraphs.map((paragraph) => paragraph.text).join('')).value;
        const spansParagraphBoundary = candidates.some((candidate) => {
            const normalizedCandidate = normalizeForDocxMatch(candidate).value;
            return normalizedCandidate && joinedParagraphs.includes(normalizedCandidate);
        });
        if (spansParagraphBoundary) throw new Error('DOCX_CROSS_PARAGRAPH_REPLACEMENT_UNSUPPORTED');
        throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
    }
    if (matches.length > 1) throw new Error('DOCX_TEXT_MATCH_AMBIGUOUS');
    assertReplacementScopeCompatible(matches[0], suggestedText);
    return matches[0];
};

const revisionAuthorsInParagraph = (paragraphXml) => (
    String(paragraphXml || '').match(/<w:(?:ins|del)\b[^>]*>/g) || []
).map(revisionElementAuthor).filter(Boolean);

const classifyProtectedParagraph = (paragraphXml, expectedAuthor = 'AI审查') => {
    if (/<w:(?:commentRangeStart|commentRangeEnd|commentReference)\b/.test(paragraphXml)) {
        throw makeRevisionPlanningError('DOCX_COMMENTED_PARAGRAPH_UNSUPPORTED');
    }
    if (/<w:(?:hyperlink|fldChar|instrText|sdt|smartTag)\b/.test(paragraphXml)) {
        throw makeRevisionPlanningError('DOCX_STRUCTURED_PARAGRAPH_UNSUPPORTED');
    }
    if (/<w:(?:ins|del)\b/.test(paragraphXml)) {
        const authors = revisionAuthorsInParagraph(paragraphXml);
        if (authors.some((author) => author !== expectedAuthor)) {
            throw makeRevisionPlanningError('DOCX_HUMAN_REVISION_CONFLICT', { authors });
        }
        throw makeRevisionPlanningError('DOCX_EXISTING_SYSTEM_REVISION_NEEDS_NEW_ROUND', { authors });
    }
};

const replacementPlanningStatus = (code) => {
    if (code === 'DOCX_HUMAN_REVISION_CONFLICT' || code === 'REVISION_GROUP_AUTHOR_MISMATCH') {
        return 'human_conflict';
    }
    if (code === 'DOCX_EXISTING_SYSTEM_REVISION_NEEDS_NEW_ROUND'
        || code === 'REVISION_GROUP_NOT_PENDING'
        || code === 'REVISION_GROUP_SUGGESTION_MISMATCH'
        || code === 'REVISION_GROUP_CONTENT_MISMATCH') {
        return 'needs_new_round';
    }
    return 'unsupported';
};

const replacementPlanningMessage = (status, code) => {
    if (status === 'safe_new') return '可在当前基线上新建审阅修订。';
    if (status === 'safe_supersede') return '可安全替换当前系统的未决修订。';
    if (status === 'human_conflict') return '目标条款存在人工或对方修订，不能自动覆盖。';
    if (status === 'needs_new_round') return '当前修订无法严格验证为本轮同一建议，请新建修订轮次。';
    const messages = {
        DOCX_COMMENTED_PARAGRAPH_UNSUPPORTED: '目标条款包含批注范围，为避免损坏批注已阻止自动修订。',
        DOCX_STRUCTURED_PARAGRAPH_UNSUPPORTED: '目标条款包含域、内容控件或链接等复杂结构。',
        DOCX_MULTI_PARAGRAPH_REPLACEMENT_UNSUPPORTED: '建议跨越多个段落，当前不能安全自动修订。',
        DOCX_CROSS_PARAGRAPH_REPLACEMENT_UNSUPPORTED: '目标原文跨越多个段落，当前不能安全自动修订。',
        DOCX_BATCH_RANGE_OVERLAP: '批量建议的目标文本范围重叠。',
        DOCX_BATCH_SAME_PARAGRAPH_UNSUPPORTED: '多条建议同时修改同一段落，请先合并为一条建议。',
    };
    return messages[code] || `无法安全应用审阅修订（${code}）。`;
};

const makePreflightResult = (index, identity, status, code, extra = {}) => ({
    index,
    ...identity,
    status,
    code,
    message: replacementPlanningMessage(status, code),
    ...extra,
});

/**
 * Build a read-only replacement plan. The returned preparedXml is an internal
 * in-memory baseline only; callers may inspect the public classification
 * without writing the DOCX.
 */
const planTextReplacementInDocumentXml = (
    sourceXml,
    originalText,
    suggestedText,
    originalCandidates = [],
    options = {},
) => {
    const priorRevision = normalizePreviousRevisionForReplacement(sourceXml, options);
    const documentXml = priorRevision.xml;
    const resolved = resolveParagraphMatch(documentXml, originalText, suggestedText, originalCandidates);
    classifyProtectedParagraph(resolved.paragraph.xml, String(options.author || 'AI审查'));
    if (options.mode === 'review') {
        // Reuse the exact bookmark and structure guards used by the writer.
        pairedWholeParagraphBookmarks(resolved.paragraph.xml, resolved.range, resolved.paragraph.text.length);
    }
    return {
        preparedXml: documentXml,
        priorRevision,
        resolved,
        status: priorRevision.status === 'superseded' ? 'safe_supersede' : 'safe_new',
        code: priorRevision.status === 'superseded' ? 'REVISION_SAFE_SUPERSEDE' : 'REVISION_SAFE_NEW',
    };
};

const preflightTextReplacementInDocumentXml = (
    sourceXml,
    originalText,
    suggestedText,
    originalCandidates = [],
    options = {},
) => {
    try {
        const plan = planTextReplacementInDocumentXml(
            sourceXml, originalText, suggestedText, originalCandidates, options,
        );
        return {
            status: plan.status,
            code: plan.code,
            message: replacementPlanningMessage(plan.status, plan.code),
            revisionGroup: options.previousRevisionGroup || null,
            clauseNo: plan.resolved.clauseNo,
            matchedText: plan.resolved.matchedText,
            replacementText: plan.resolved.replacement,
        };
    } catch (error) {
        const status = replacementPlanningStatus(error.message);
        return {
            status,
            code: error.message,
            message: replacementPlanningMessage(status, error.message),
            revisionGroup: options.previousRevisionGroup || null,
        };
    }
};

const replaceTextInDocumentXml = (sourceXml, originalText, suggestedText, originalCandidates = [], options = {}) => {
    const plan = planTextReplacementInDocumentXml(
        sourceXml, originalText, suggestedText, originalCandidates, options,
    );
    const documentXml = plan.preparedXml;
    const resolved = plan.resolved;
    let paragraphXml;
    let revisionGroup = null;
    if (options.mode === 'review') {
        const maxRevisionId = Math.max(0, ...(documentXml.match(/w:id="(\d+)"/g) || [])
            .map((value) => Number(value.match(/\d+/)?.[0] || 0)));
        const revisionResult = replaceTextWithRevisionGroup(resolved.paragraph.xml, resolved.range, resolved.replacement, {
            revisionId: maxRevisionId + 1,
            author: options.author,
            date: options.date,
            revisionGroupId: options.revisionGroupId,
            suggestionId: options.suggestionId,
        });
        paragraphXml = revisionResult.xml;
        revisionGroup = revisionResult.revisionGroup;
    } else {
        const result = replaceTextInXmlRuns(resolved.paragraph.xml, resolved.matchedText, resolved.replacement);
        if (!result.replaced) throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
        paragraphXml = result.xml;
    }
    const updatedXml = `${documentXml.slice(0, resolved.paragraph.start)}${paragraphXml}${documentXml.slice(resolved.paragraph.end)}`;
    return {
        xml: updatedXml,
        replacements: 1,
        clauseNo: resolved.clauseNo,
        matchedText: resolved.matchedText,
        replacementText: resolved.replacement,
        strategy: resolved.strategy,
        mode: options.mode === 'review' ? 'review' : 'edit',
        revisionGroup,
        planningStatus: plan.status,
        supersededRevisionGroup: plan.priorRevision.status === 'superseded'
            ? plan.priorRevision.previousRevisionGroup
            : null,
    };
};

const writeZipAtomically = (zip, filePath, suffix = 'docx-edit') => {
    const tempPath = `${filePath}.${suffix}-${randomUUID()}.tmp`;
    try {
        zip.writeZip(tempPath);
        fs.renameSync(tempPath, filePath);
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
};

const replaceTextInDocx = (filePath, originalText, suggestedText, originalCandidates = [], options = {}) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    const result = replaceTextInDocumentXml(
        entry.getData().toString('utf8'), originalText, suggestedText, originalCandidates, options,
    );
    zip.updateFile('word/document.xml', Buffer.from(result.xml, 'utf8'));
    writeZipAtomically(zip, filePath);
    const { xml, ...metadata } = result;
    return metadata;
};

const planTextReplacementsInDocumentXml = (sourceXml, replacements = []) => {
    const states = replacements.map((item, index) => ({
        index,
        item,
        identity: {
            suggestionIndex: item?.suggestionIndex,
            suggestionId: item?.options?.suggestionId || item?.suggestionId || '',
            title: String(item?.title || ''),
        },
        result: null,
        priorRevision: null,
        plan: null,
    }));
    const seenPreviousGroups = new Set();
    let preparedXml = String(sourceXml || '');

    // Phase 1: validate and restore every explicitly linked prior system
    // revision. Nothing is written, and no text matching happens until the
    // common batch baseline has been constructed.
    for (const state of states) {
        const { item, index, identity } = state;
        if (!String(item?.originalText || '').trim()
            || item?.suggestedText === undefined || item?.suggestedText === null) {
            state.result = makePreflightResult(
                index, identity, 'unsupported', 'DOCX_REPLACEMENT_INPUT_INVALID',
            );
            continue;
        }
        const previousGroupId = item?.options?.previousRevisionGroup?.group_id;
        if (previousGroupId && seenPreviousGroups.has(String(previousGroupId))) {
            state.result = makePreflightResult(
                index, identity, 'unsupported', 'DOCX_BATCH_DUPLICATE_REVISION_GROUP',
                { revisionGroup: item.options.previousRevisionGroup },
            );
            continue;
        }
        if (previousGroupId) seenPreviousGroups.add(String(previousGroupId));
        try {
            state.priorRevision = normalizePreviousRevisionForReplacement(preparedXml, item.options || {});
            preparedXml = state.priorRevision.xml;
        } catch (error) {
            const status = replacementPlanningStatus(error.message);
            state.result = makePreflightResult(index, identity, status, error.message, {
                revisionGroup: item?.options?.previousRevisionGroup || null,
            });
        }
    }

    // Phase 2: resolve every target against the same immutable baseline.
    for (const state of states) {
        if (state.result) continue;
        const { item, index, identity } = state;
        try {
            const resolved = resolveParagraphMatch(
                preparedXml,
                item.originalText,
                item.suggestedText,
                item.originalCandidates || [],
            );
            classifyProtectedParagraph(resolved.paragraph.xml, String(item?.options?.author || 'AI审查'));
            if (item?.options?.mode === 'review') {
                pairedWholeParagraphBookmarks(
                    resolved.paragraph.xml, resolved.range, resolved.paragraph.text.length,
                );
            }
            const status = state.priorRevision?.status === 'superseded' ? 'safe_supersede' : 'safe_new';
            const code = status === 'safe_supersede' ? 'REVISION_SAFE_SUPERSEDE' : 'REVISION_SAFE_NEW';
            state.plan = { resolved, status, code };
            state.result = makePreflightResult(index, identity, status, code, {
                revisionGroup: item?.options?.previousRevisionGroup || null,
                clauseNo: resolved.clauseNo,
                matchedText: resolved.matchedText,
                replacementText: resolved.replacement,
            });
        } catch (error) {
            const status = replacementPlanningStatus(error.message);
            state.result = makePreflightResult(index, identity, status, error.message, {
                revisionGroup: item?.options?.previousRevisionGroup || null,
            });
        }
    }

    // Phase 3: fail closed for same-paragraph batches. Overlapping ranges get
    // their own error; disjoint edits are also deferred until a paragraph-level
    // merge strategy is available, instead of being misreported as a complex
    // paragraph after the first write.
    const planned = states.filter((state) => state.plan);
    const batchConflicts = new Map();
    for (let leftIndex = 0; leftIndex < planned.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < planned.length; rightIndex += 1) {
            const left = planned[leftIndex];
            const right = planned[rightIndex];
            if (left.plan.resolved.paragraph.start !== right.plan.resolved.paragraph.start) continue;
            const leftRange = left.plan.resolved.range;
            const rightRange = right.plan.resolved.range;
            const overlap = leftRange.start < rightRange.end && rightRange.start < leftRange.end;
            const code = overlap ? 'DOCX_BATCH_RANGE_OVERLAP' : 'DOCX_BATCH_SAME_PARAGRAPH_UNSUPPORTED';
            for (const state of [left, right]) {
                const existing = batchConflicts.get(state.index);
                if (!existing || code === 'DOCX_BATCH_RANGE_OVERLAP') {
                    batchConflicts.set(state.index, code);
                }
            }
        }
    }
    for (const [index, code] of batchConflicts) {
        const state = states[index];
        state.plan = null;
        state.result = makePreflightResult(
            state.index, state.identity, 'unsupported', code,
            { revisionGroup: state.item?.options?.previousRevisionGroup || null },
        );
    }

    const results = states.map((state) => state.result);
    const summary = results.reduce((counts, result) => {
        counts.total += 1;
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
    }, { total: 0, safe_new: 0, safe_supersede: 0, needs_new_round: 0, human_conflict: 0, unsupported: 0 });
    return { preparedXml, states, results, summary };
};

const preflightTextReplacementsInDocumentXml = (sourceXml, replacements = []) => {
    const planned = planTextReplacementsInDocumentXml(sourceXml, replacements);
    return { results: planned.results, summary: planned.summary };
};

const preflightTextReplacementsInDocx = (filePath, replacements = []) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    return preflightTextReplacementsInDocumentXml(entry.getData().toString('utf8'), replacements);
};

/**
 * Apply a complete batch in memory and write the DOCX only when every item is
 * safe. This prevents a batch with one ambiguous/unsupported suggestion from
 * leaving a partially modified document behind.
 */
const replaceTextsInDocxAtomic = (filePath, replacements = []) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('DOCX_DOCUMENT_XML_NOT_FOUND');
    const planning = planTextReplacementsInDocumentXml(entry.getData().toString('utf8'), replacements);
    const failed = planning.results.some((item) => !['safe_new', 'safe_supersede'].includes(item.status));
    if (failed) {
        const error = new Error('DOCX_BATCH_ABORTED');
        error.results = planning.results.map((item) => ({
            ...item,
            ok: ['safe_new', 'safe_supersede'].includes(item.status),
            error: ['safe_new', 'safe_supersede'].includes(item.status) ? undefined : item.code,
        }));
        error.summary = planning.summary;
        throw error;
    }

    let documentXml = planning.preparedXml;
    let nextRevisionId = Math.max(0, ...(documentXml.match(/w:id="(\d+)"/g) || [])
        .map((value) => Number(value.match(/\d+/)?.[0] || 0))) + 1;
    const results = [];
    const orderedStates = [...planning.states].sort((left, right) => (
        right.plan.resolved.paragraph.start - left.plan.resolved.paragraph.start
    ));
    for (const state of orderedStates) {
        const { item, plan, identity, index } = state;
        const resolved = plan.resolved;
        let paragraphXml;
        let revisionGroup = null;
        if (item?.options?.mode === 'review') {
            const revisionResult = replaceTextWithRevisionGroup(
                resolved.paragraph.xml,
                resolved.range,
                resolved.replacement,
                {
                    revisionId: nextRevisionId,
                    author: item.options.author,
                    date: item.options.date,
                    revisionGroupId: item.options.revisionGroupId,
                    suggestionId: item.options.suggestionId,
                },
            );
            paragraphXml = revisionResult.xml;
            revisionGroup = revisionResult.revisionGroup;
            nextRevisionId += 2;
        } else {
            const replaced = replaceTextInXmlRuns(
                resolved.paragraph.xml, resolved.matchedText, resolved.replacement,
            );
            if (!replaced.replaced) throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
            paragraphXml = replaced.xml;
        }
        documentXml = `${documentXml.slice(0, resolved.paragraph.start)}${paragraphXml}${documentXml.slice(resolved.paragraph.end)}`;
        results.push({
            index,
            ...identity,
            ok: true,
            replacements: 1,
            clauseNo: resolved.clauseNo,
            matchedText: resolved.matchedText,
            replacementText: resolved.replacement,
            strategy: resolved.strategy,
            mode: item?.options?.mode === 'review' ? 'review' : 'edit',
            revisionGroup,
            planningStatus: plan.status,
            supersededRevisionGroup: state.priorRevision?.status === 'superseded'
                ? state.priorRevision.previousRevisionGroup
                : null,
        });
    }
    results.sort((left, right) => left.index - right.index);

    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
    writeZipAtomically(zip, filePath, 'docx-batch');
    return {
        replacements: results.reduce((total, item) => total + Number(item.replacements || 0), 0),
        results,
        summary: planning.summary,
    };
};

module.exports = {
    escapeXmlText,
    unescapeXmlText,
    normalizeForDocxMatch,
    findDocxTextRange,
    isHeadingParagraphAt,
    paragraphText,
    parseClausePrefix,
    ensureClauseNumber,
    replaceTextInXmlRuns,
    replaceTextWithRevision,
    replaceTextWithRevisionGroup,
    detectRevisionGroupStatusInXml,
    detectRevisionGroupStatusInDocx,
    resolveRevisionGroupInXml,
    resolveRevisionGroupInDocx,
    reconcilePartialRevisionGroupInXml,
    normalizeRejectedRevisionBeforeReapply,
    normalizePendingRevisionBeforeSupersede,
    syncRevisionGroupsFromDocx,
    normalizeReplacementCandidates,
    assertReplacementScopeCompatible,
    resolveParagraphMatch,
    planTextReplacementInDocumentXml,
    preflightTextReplacementInDocumentXml,
    planTextReplacementsInDocumentXml,
    preflightTextReplacementsInDocumentXml,
    preflightTextReplacementsInDocx,
    replaceTextInDocumentXml,
    replaceTextInDocx,
    replaceTextsInDocxAtomic,
    parseChineseArticleNumber,
    toChineseArticleNumber,
    parseArticleHeading,
    parseMinorClauseNumber,
    collectParagraphRecords,
    appendClauseToDocumentXml,
    appendClauseInDocx,
};
