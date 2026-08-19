/**
 * @file services/contractAnalysis/documentExport.js
 * @brief 合同原文的审阅版/最终版 DOCX 与 PDF 导出
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const {
    ONLYOFFICE_JWT_SECRET,
    ONLYOFFICE_URL,
    BACKEND_URL_FOR_DOCKER,
} = require('./onlyoffice');

const execFileAsync = promisify(execFile);

const EXPORT_VARIANTS = new Set(['review', 'final']);
const EXPORT_FORMATS = new Set(['docx', 'pdf']);

const unwrapElements = (xml, names) => {
    let result = String(xml || '');
    for (const name of names) {
        const pattern = new RegExp(`<w:${name}\\b[^>]*>([\\s\\S]*?)<\\/w:${name}>`, 'g');
        let previous;
        do {
            previous = result;
            result = result.replace(pattern, '$1');
        } while (result !== previous);
    }
    return result;
};

const removeElements = (xml, names) => {
    let result = String(xml || '');
    for (const name of names) {
        result = result
            .replace(new RegExp(`<w:${name}\\b[^>]*/>`, 'g'), '')
            .replace(new RegExp(`<w:${name}\\b[^>]*>[\\s\\S]*?<\\/w:${name}>`, 'g'), '');
    }
    return result;
};

/**
 * 接受一个 WordprocessingML 部件中的全部修订。
 * 插入/移入内容保留并去掉包装，删除/移出内容彻底移除；属性变更和范围标记被清理。
 */
const acceptTrackedChangesInXml = (xml) => {
    let result = unwrapElements(xml, ['ins', 'moveTo', 'conflictIns']);
    result = removeElements(result, ['del', 'moveFrom', 'conflictDel']);
    result = removeElements(result, [
        'rPrChange', 'pPrChange', 'tblPrChange', 'tblPrExChange', 'tblGridChange',
        'trPrChange', 'tcPrChange', 'sectPrChange', 'numberingChange',
        'customXmlInsRangeStart', 'customXmlInsRangeEnd',
        'customXmlDelRangeStart', 'customXmlDelRangeEnd',
        'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
    ]);
    result = removeElements(result, ['trackRevisions']);
    return result;
};

const isWordprocessingXmlPart = (entryName) => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments|settings)\.xml$/i.test(entryName);

const acceptAllTrackedChanges = (sourcePath, targetPath) => {
    fs.copyFileSync(sourcePath, targetPath);
    const zip = new AdmZip(targetPath);
    for (const entry of zip.getEntries()) {
        if (!isWordprocessingXmlPart(entry.entryName)) continue;
        const xml = entry.getData().toString('utf8');
        const accepted = acceptTrackedChangesInXml(xml);
        if (accepted !== xml) zip.updateFile(entry.entryName, Buffer.from(accepted, 'utf8'));
    }
    zip.writeZip(targetPath);
    return targetPath;
};

const isExecutable = (candidate) => {
    if (!candidate) return false;
    const paths = candidate.includes(path.sep)
        ? [candidate]
        : String(process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, candidate));
    for (const executablePath of paths) {
        try {
            fs.accessSync(executablePath, fs.constants.X_OK);
            return true;
        } catch { /* continue */ }
    }
    return false;
};

const findLibreOfficeBinary = () => {
    const candidates = [
        process.env.LIBREOFFICE_BIN,
        'libreoffice',
        'soffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ];
    return candidates.find(isExecutable) || null;
};

const convertDocxToPdf = async (docxPath, outputDir, options = {}) => {
    const binary = options.libreOfficeBinary || findLibreOfficeBinary();
    if (!binary) {
        const error = new Error('LIBREOFFICE_NOT_AVAILABLE');
        error.code = 'LIBREOFFICE_NOT_AVAILABLE';
        throw error;
    }
    await fs.promises.mkdir(outputDir, { recursive: true });
    const profileDir = await fs.promises.mkdtemp(path.join(outputDir, 'lo-profile-'));
    const profileUri = `file://${profileDir.split(path.sep).map(encodeURIComponent).join('/')}`;
    try {
        await execFileAsync(binary, [
            `-env:UserInstallation=${profileUri}`,
            '--headless', '--convert-to', 'pdf', '--outdir', outputDir, docxPath,
        ], { timeout: Number(options.timeoutMs || 90000), maxBuffer: 4 * 1024 * 1024 });
        const expected = path.join(outputDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
        const outputPath = fs.existsSync(expected)
            ? expected
            : (await fs.promises.readdir(outputDir))
                .filter((name) => name.toLowerCase().endsWith('.pdf'))
                .map((name) => path.join(outputDir, name))[0];
        if (!outputPath || !(await fs.promises.stat(outputPath)).size) {
            throw new Error('PDF_CONVERSION_OUTPUT_MISSING');
        }
        return outputPath;
    } finally {
        await fs.promises.rm(profileDir, { recursive: true, force: true });
    }
};

const convertDocxToPdfWithOnlyOffice = async (docxPath, outputDir, options = {}) => {
    const onlyOfficeUrl = options.onlyOfficeUrl || ONLYOFFICE_URL;
    const backendUrl = options.backendUrl || BACKEND_URL_FOR_DOCKER;
    const jwtSecret = options.jwtSecret || ONLYOFFICE_JWT_SECRET;
    if (!onlyOfficeUrl || !backendUrl) {
        const error = new Error('ONLYOFFICE_CONVERSION_NOT_CONFIGURED');
        error.code = 'ONLYOFFICE_CONVERSION_NOT_CONFIGURED';
        throw error;
    }

    const publicFilesDir = options.publicFilesDir
        || path.join(__dirname, '..', '..', 'public', 'files');
    const publicTempDir = path.join(publicFilesDir, 'export-temp');
    const sourceName = `${crypto.randomUUID()}.docx`;
    const publicSourcePath = path.join(publicTempDir, sourceName);
    await fs.promises.mkdir(publicTempDir, { recursive: true });
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.copyFile(docxPath, publicSourcePath);

    try {
        const payload = {
            async: false,
            filetype: 'docx',
            key: `export-${crypto.randomUUID()}`,
            outputtype: 'pdf',
            title: sourceName,
            url: `${backendUrl.replace(/\/$/, '')}/files/export-temp/${encodeURIComponent(sourceName)}`,
        };
        const requestBody = jwtSecret
            ? { ...payload, token: jwt.sign(payload, jwtSecret) }
            : payload;
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        if (requestBody.token) headers.Authorization = `Bearer ${requestBody.token}`;

        const conversionResponse = await axios.post(
            `${onlyOfficeUrl.replace(/\/$/, '')}/converter`,
            requestBody,
            { headers, timeout: Number(options.timeoutMs || 90000) },
        );
        const result = conversionResponse.data;
        if (!result?.endConvert || !result?.fileUrl) {
            const error = new Error('ONLYOFFICE_PDF_CONVERSION_INCOMPLETE');
            error.code = 'ONLYOFFICE_PDF_CONVERSION_INCOMPLETE';
            error.details = result;
            throw error;
        }

        const downloadResponse = await axios.get(result.fileUrl, {
            responseType: 'arraybuffer',
            timeout: Number(options.timeoutMs || 90000),
        });
        const pdfBuffer = Buffer.from(downloadResponse.data);
        if (pdfBuffer.length < 4 || pdfBuffer.subarray(0, 4).toString() !== '%PDF') {
            const error = new Error('PDF_CONVERSION_OUTPUT_INVALID');
            error.code = 'PDF_CONVERSION_OUTPUT_INVALID';
            throw error;
        }
        const outputPath = path.join(outputDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
        await fs.promises.writeFile(outputPath, pdfBuffer);
        return outputPath;
    } finally {
        await fs.promises.rm(publicSourcePath, { force: true });
    }
};

const convertDocxToPdfUsingAvailableService = async (docxPath, outputDir, options = {}) => {
    const shouldUseOnlyOffice = Boolean(
        (options.onlyOfficeUrl || ONLYOFFICE_URL)
        && (options.backendUrl || BACKEND_URL_FOR_DOCKER),
    );
    if (shouldUseOnlyOffice) {
        try {
            return await convertDocxToPdfWithOnlyOffice(docxPath, outputDir, options);
        } catch (onlyOfficeError) {
            const binary = options.libreOfficeBinary || findLibreOfficeBinary();
            if (!binary) throw onlyOfficeError;
            console.warn('[Export] OnlyOffice PDF conversion failed, falling back to LibreOffice:', onlyOfficeError.message);
        }
    }
    return convertDocxToPdf(docxPath, outputDir, options);
};

const cleanStem = (filename) => path.basename(String(filename || 'contract'), path.extname(String(filename || '')))
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/[. ]+$/g, '') || 'contract';

const buildExportFilename = (originalFilename, variant, format) => {
    const suffix = variant === 'final' ? '最终版' : '审阅版';
    return `${cleanStem(originalFilename)}-${suffix}.${format}`;
};

const buildContentDisposition = (filename) => {
    const extension = path.extname(filename).toLowerCase();
    const variant = filename.includes('最终版') ? 'final' : 'review';
    const asciiFallback = `contract-${variant}${extension}`;
    const encoded = encodeURIComponent(filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
};

const createDocumentExport = async ({ sourcePath, originalFilename, variant, format, ...conversionOptions }) => {
    if (!EXPORT_VARIANTS.has(variant)) throw Object.assign(new Error('INVALID_EXPORT_VARIANT'), { code: 'INVALID_EXPORT_VARIANT' });
    if (!EXPORT_FORMATS.has(format)) throw Object.assign(new Error('INVALID_EXPORT_FORMAT'), { code: 'INVALID_EXPORT_FORMAT' });
    if (path.extname(sourcePath).toLowerCase() !== '.docx') {
        throw Object.assign(new Error('EXPORT_REQUIRES_DOCX'), { code: 'EXPORT_REQUIRES_DOCX' });
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'contract-export-'));
    try {
        const docxPath = path.join(tempDir, 'contract.docx');
        if (variant === 'final') acceptAllTrackedChanges(sourcePath, docxPath);
        else await fs.promises.copyFile(sourcePath, docxPath);

        const outputPath = format === 'pdf'
            ? await convertDocxToPdfUsingAvailableService(docxPath, tempDir, conversionOptions)
            : docxPath;
        const buffer = await fs.promises.readFile(outputPath);
        return {
            buffer,
            filename: buildExportFilename(originalFilename, variant, format),
            contentType: format === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
};

module.exports = {
    EXPORT_VARIANTS,
    EXPORT_FORMATS,
    acceptTrackedChangesInXml,
    acceptAllTrackedChanges,
    findLibreOfficeBinary,
    convertDocxToPdf,
    convertDocxToPdfWithOnlyOffice,
    convertDocxToPdfUsingAvailableService,
    buildExportFilename,
    buildContentDisposition,
    createDocumentExport,
};
