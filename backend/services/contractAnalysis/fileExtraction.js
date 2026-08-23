/**
 * @file services/contractAnalysis/fileExtraction.js
 * @brief 从上传的合同文件中提取文本内容，并识别扫描件 PDF
 *
 * 核心职责：
 * - 解析 .docx 与 .pdf 文件，提取纯文本供后续分析使用
 * - 检测图像型扫描件 PDF，避免无文本可提取的无效分析
 * - 提供合同正文包装标记，便于 LLM 识别合同上下文边界
 *
 * 关键实现：
 * - 使用 mammoth 提取 DOCX 原始文本，空文本时抛出 EMPTY_TEXT
 * - 使用 pdf-parse 解析 PDF，按每页平均字符数判断是否为扫描件
 * - 通过 BEGIN/END_CONTRACT_CONTENT 标记包裹合同正文
 *
 * 依赖关系：
 * - 上游：path、fs、mammoth、pdf-parse
 * - 下游：被分析流程（analysisCore、backgroundAnalysis）及上传接口调用
 */
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const AdmZip = require('adm-zip');

const OCR_SIDECAR_SUFFIX = '.ocr.txt';
const MIN_OCR_SIDECAR_CHARS = 50;

const getOcrSidecarPath = (filePath) => `${filePath}${OCR_SIDECAR_SUFFIX}`;

const readOcrSidecar = (filePath) => {
    const sidecarPath = getOcrSidecarPath(filePath);
    if (!fs.existsSync(sidecarPath)) return null;
    const text = fs.readFileSync(sidecarPath, 'utf8').trim();
    const effectiveChars = text.replace(/\s+/g, '').length;
    if (effectiveChars < MIN_OCR_SIDECAR_CHARS) return null;
    return text;
};

// 检测 PDF 是否为扫描件（图像型）：文本极少且页数大于0
const detectScannedPdf = (pdfData) => {
    const text = String(pdfData.text || '').replace(/\s+/g, '');
    const pageCount = pdfData.numpages || (pdfData.info && pdfData.info.Pages) || 1;
    // 每页平均有效字符少于 50 视为扫描件
    const avgCharsPerPage = text.length / Math.max(pageCount, 1);
    return {
        isScanned: pageCount > 0 && avgCharsPerPage < 50,
        textLength: text.length,
        pageCount,
        avgCharsPerPage: Math.round(avgCharsPerPage),
    };
};

const unwrapElements = (xml, names) => {
    let result = xml;
    for (const name of names) {
        result = result
            .replace(new RegExp(`<w:${name}\\b[^>]*>`, 'g'), '')
            .replace(new RegExp(`<\\/w:${name}>`, 'g'), '');
    }
    return result;
};

const removeElements = (xml, names) => {
    let result = xml;
    for (const name of names) {
        result = result
            .replace(new RegExp(`<w:${name}\\b[^>]*/>`, 'g'), '')
            .replace(new RegExp(`<w:${name}\\b[^>]*>[\\s\\S]*?<\\/w:${name}>`, 'g'), '');
    }
    return result;
};

// 审核必须基于尚未采纳修改前的权威合同，而不是把 Word 待审修订中的建议
// 当成已生效条款。这里只在内存副本中拒绝修订，绝不改写用户 DOCX。
const rejectTrackedChangesInXml = (xml) => {
    let result = removeElements(xml, ['ins', 'moveTo', 'conflictIns']);
    result = unwrapElements(result, ['del', 'moveFrom', 'conflictDel'])
        .replace(/<w:delText\b/g, '<w:t')
        .replace(/<\/w:delText>/g, '</w:t>');
    result = removeElements(result, [
        'rPrChange', 'pPrChange', 'tblPrChange', 'tblPrExChange', 'tblGridChange',
        'trPrChange', 'tcPrChange', 'sectPrChange', 'numberingChange',
        'customXmlInsRangeStart', 'customXmlInsRangeEnd',
        'customXmlDelRangeStart', 'customXmlDelRangeEnd',
        'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
    ]);
    return result;
};

const extractDocxReviewBaseline = async (filePath) => {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (entry) {
        const xml = entry.getData().toString('utf8');
        const baselineXml = rejectTrackedChangesInXml(xml);
        if (baselineXml !== xml) zip.updateFile(entry.entryName, Buffer.from(baselineXml, 'utf8'));
    }
    const { value } = await mammoth.extractRawText({ buffer: zip.toBuffer() });
    return value;
};

const extractTextFromFile = async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
        const value = await extractDocxReviewBaseline(filePath);
        if (!value || !value.trim()) {
            const err = new Error('DOCX 文本提取为空，文件可能已损坏或为空文档。');
            err.code = 'EMPTY_TEXT';
            throw err;
        }
        return value;
    }
    if (ext === '.pdf') {
        const data = await pdf(fs.readFileSync(filePath));
        const scanInfo = detectScannedPdf(data);
        if (scanInfo.isScanned || !data.text || !data.text.trim()) {
            const ocrText = readOcrSidecar(filePath);
            if (ocrText) return ocrText;
            const err = new Error('该 PDF 疑似扫描件（图像型），无法提取文本内容。请上传可复制的文字版 PDF，或先用 OCR 工具转换为文字版后再上传。');
            err.code = 'SCANNED_PDF';
            err.scanInfo = scanInfo;
            throw err;
        }
        return data.text;
    }
    const err = new Error(`Unsupported file extension: ${ext}`);
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
};

const CONTRACT_CONTENT_BEGIN = '[BEGIN_CONTRACT_CONTENT]';
const CONTRACT_CONTENT_END = '[END_CONTRACT_CONTENT]';

const wrapContractContent = (text) => [
    CONTRACT_CONTENT_BEGIN,
    String(text || ''),
    CONTRACT_CONTENT_END,
].join('\n');

module.exports = {
    detectScannedPdf,
    getOcrSidecarPath,
    readOcrSidecar,
    rejectTrackedChangesInXml,
    extractDocxReviewBaseline,
    extractTextFromFile,
    CONTRACT_CONTENT_BEGIN,
    CONTRACT_CONTENT_END,
    wrapContractContent,
};
