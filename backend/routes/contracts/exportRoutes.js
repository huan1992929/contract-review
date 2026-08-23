/**
 * @file routes/contracts/exportRoutes.js
 * @brief 审查报告导出、PDF 批注、强制保存与编辑器配置路由
 *
 * 核心职责：
 * - 导出审查报告（PDF/DOCX/HTML 三种格式）
 * - 导出 PDF 合同批注意见为文本
 * - 触发 OnlyOffice 强制保存（force-save）
 * - 获取最新的 OnlyOffice 编辑器配置
 *
 * 关键实现：
 * - DOCX 导出使用真正的 OOXML 格式
 * - 强制保存通过 postOnlyOfficeCommand 调用 OnlyOffice 服务
 *
 * 依赖关系：
 * - 上游：database、services/contractAnalysis（auth、reportRendering、onlyoffice）
 * - 下游：被 routes/contracts/index.js 注册
 */
const db = require('../../database');
const path = require('path');
const { requireRequestUserId, findOwnedContract } = require('../../services/contractAnalysis/auth');
const { parseJsonField, renderReviewReportHtml, generateDocxBuffer, streamReviewReportPdf } = require('../../services/contractAnalysis/reportRendering');
const {
    postOnlyOfficeCommand,
    buildOnlyOfficeConfig,
    classifyForceSaveResult,
} = require('../../services/contractAnalysis/onlyoffice');
const {
    EXPORT_VARIANTS,
    EXPORT_FORMATS,
    buildContentDisposition,
    createDocumentExport,
} = require('../../services/contractAnalysis/documentExport');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const tryForceSaveBeforeExport = async (contract) => {
    if (!contract.document_key || !contract.storage_path) return;
    try {
        const previousUpdatedAt = new Date(contract.updated_at || 0).getTime();
        const result = await postOnlyOfficeCommand({ c: 'forcesave', key: contract.document_key });
        if (result?.error !== 0) return;
        // save-callback only updates updated_at after the complete DOCX stream has been
        // written, so polling the database avoids copying a partially written file.
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            await sleep(200);
            const fresh = await db('contracts').where({ id: contract.id }).select('updated_at').first();
            if (new Date(fresh?.updated_at || 0).getTime() > previousUpdatedAt) return;
        }
    } catch (error) {
        console.warn(`[Export] OnlyOffice force-save skipped for contract ${contract.id}:`, error.message);
    }
};

module.exports = function (router) {
    router.get('/:id/export-document', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const variant = String(req.query.variant || 'review').toLowerCase();
        const requestedFormat = String(req.query.format || 'docx').toLowerCase();
        const format = requestedFormat === 'word' ? 'docx' : requestedFormat;
        if (!EXPORT_VARIANTS.has(variant)) {
            return res.status(400).json({ error: 'variant 仅支持 review 或 final。', code: 'INVALID_EXPORT_VARIANT' });
        }
        if (!EXPORT_FORMATS.has(format)) {
            return res.status(400).json({ error: 'format 仅支持 docx 或 pdf。', code: 'INVALID_EXPORT_FORMAT' });
        }

        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            if (req.query.sync !== 'false') await tryForceSaveBeforeExport(contract);
            const output = await createDocumentExport({
                sourcePath: contract.storage_path,
                originalFilename: contract.original_filename,
                variant,
                format,
            });
            res.setHeader('Content-Type', output.contentType);
            res.setHeader('Content-Length', output.buffer.length);
            res.setHeader('Content-Disposition', buildContentDisposition(output.filename));
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Export-Variant', variant);
            return res.send(output.buffer);
        } catch (error) {
            if (error.code === 'EXPORT_REQUIRES_DOCX') {
                return res.status(400).json({ error: '仅 DOCX 合同支持审阅版/最终版导出。', code: error.code });
            }
            if (error.code === 'LIBREOFFICE_NOT_AVAILABLE'
                || error.code?.startsWith('ONLYOFFICE_')
                || error.message === 'PDF_CONVERSION_OUTPUT_MISSING'
                || error.message === 'PDF_CONVERSION_OUTPUT_INVALID') {
                return res.status(503).json({ error: 'PDF 转换服务暂不可用，请先导出 Word 文件。', code: error.code || error.message });
            }
            console.error(`[ERROR] Failed to export contract document ${req.params.id}:`, error);
            return res.status(500).json({ error: '合同文件导出失败。' });
        }
    });

    router.get('/:id/export-report', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const format = String(req.query.format || 'html').toLowerCase();
        const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';

        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.pdf"`);
            return streamReviewReportPdf(res, contract, reviewData);
        }

        if (format === 'word' || format === 'docx') {
            // 真正的 DOCX 格式（OOXML），非 HTML 伪装
            const docxBuffer = generateDocxBuffer(contract, reviewData);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.docx"`);
            return res.send(docxBuffer);
        }

        const html = renderReviewReportHtml(contract, reviewData, format);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.html"`);
        res.send(html);
    });

    router.get('/:id/pdf-annotations', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
        const suggestions = reviewData.modification_suggestions || [];
        const lines = [
            `PDF 合同批注意见：${contract.original_filename}`,
            `导出时间：${new Date().toISOString()}`,
            '',
            ...suggestions.flatMap((item, index) => [
                `#${index + 1} ${item.title || item.clause || '修改建议'}`,
                `现状条款：${item.current_clause || item.original_text || item.original_clause || ''}`,
                `建议修改为：${item.suggested_text || item.modification || ''}`,
                `依据：${Array.isArray(item.basis) ? item.basis.map((basis) => [basis.title, basis.clause, basis.content].filter(Boolean).join(' ')).join('；') : (item.basis || item.reason || item.rationale || '当前知识库未检索到直接依据')}`,
                '',
            ]),
        ];
        const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-pdf-annotations.txt"`);
        res.send(lines.join('\n'));
    });

    router.post('/:id/force-save', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const { documentKey } = req.body || {};

        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            const key = String(documentKey || contract.document_key || '').trim();
            if (!key) return res.status(400).json({ error: 'Document key is required for force-save.' });
            if (key !== contract.document_key) {
                return res.status(409).json({ error: '文档版本已变化，请刷新后重试。', code: 'DOCUMENT_VERSION_STALE' });
            }
            const previousSavedAt = new Date(contract.onlyoffice_saved_at || 0).getTime();

            const result = await postOnlyOfficeCommand({
                c: 'forcesave',
                key,
            });

            const forceSaveState = classifyForceSaveResult(result);
            if (forceSaveState === 'no_changes') {
                return res.json({
                    ok: true,
                    saved: true,
                    noChanges: true,
                    documentKey: key,
                    ossSha256: contract.oss_sha256 || '',
                    result,
                });
            }

            if (forceSaveState === 'failed') {
                return res.status(502).json({ error: `OnlyOffice force-save failed: ${result.error}`, result });
            }

            // A command acknowledgement only means Document Server accepted the
            // request. Wait until save-callback has atomically replaced the file
            // and persisted its OSS hash before allowing an AI mutation.
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                await sleep(200);
                const fresh = await db('contracts').where({ id: contract.id })
                    .select('document_key', 'onlyoffice_saved_at', 'onlyoffice_saved_key', 'oss_sha256')
                    .first();
                if (fresh?.document_key !== key) {
                    return res.status(409).json({ error: '保存期间文档版本已变化，请刷新后重试。', code: 'DOCUMENT_VERSION_STALE' });
                }
                if (fresh?.onlyoffice_saved_key === key
                    && new Date(fresh?.onlyoffice_saved_at || 0).getTime() > previousSavedAt) {
                    return res.json({
                        ok: true,
                        saved: true,
                        documentKey: key,
                        ossSha256: fresh.oss_sha256 || '',
                        result,
                    });
                }
            }
            return res.status(504).json({
                error: 'OnlyOffice 保存确认超时，系统未执行后续 AI 修订。请刷新文档后重试。',
                code: 'ONLYOFFICE_SAVE_ACK_TIMEOUT',
            });
        } catch (error) {
            console.error(`[ERROR] Failed to force-save contract ${req.params.id}:`, error.response?.data || error.message);
            res.status(500).json({ error: 'Failed to trigger OnlyOffice force-save.' });
        }
    });

    router.get('/:id/editor-config', async (req, res) => {
        const { id } = req.params;
        const userId = req.header('X-User-ID');
        if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

        try {
            const contractRecord = await db('contracts').where({ id, user_id: userId }).first();
            if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

            const ext = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '') || 'docx';
            res.json({
                editorConfig: buildOnlyOfficeConfig(contractRecord, ext),
            });
        } catch (error) {
            console.error(`[ERROR] Failed to fetch fresh editor config for id ${id}:`, error);
            res.status(500).json({ error: 'Server error while fetching editor config.' });
        }
    });
};
