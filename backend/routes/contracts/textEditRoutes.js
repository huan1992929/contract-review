/**
 * @file routes/contracts/textEditRoutes.js
 * @brief 合同 DOCX 的直接编辑与审阅修订路由
 */
const db = require('../../database');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { requireRequestUserId, findOwnedContract } = require('../../services/contractAnalysis/auth');
const { createContractVersionSnapshot } = require('../../services/contractAnalysis/version');
const {
    replaceTextInDocx,
    replaceTextsInDocxAtomic,
    appendClauseInDocx,
    resolveRevisionGroupInDocx,
    syncRevisionGroupsFromDocx,
} = require('../../services/contractAnalysis/docxEdit');
const { buildOnlyOfficeConfig } = require('../../services/contractAnalysis/onlyoffice');
const { getIoInstance } = require('../../services/contractAnalysis/analysisJob');
const { mirrorContractFile } = require('../../services/thinkparkStorageGateway');

const parseAnalysisResult = (contract) => {
    try {
        return typeof contract.analysis_result === 'string'
            ? JSON.parse(contract.analysis_result || '{}')
            : (contract.analysis_result || {});
    } catch {
        return {};
    }
};

const persistRevisionGroup = (analysis, suggestion, revisionGroup, documentKey) => {
    if (!revisionGroup) return;
    const storedGroup = {
        ...revisionGroup,
        document_key: documentKey,
    };
    suggestion.revision_group = storedGroup;
    const registry = Array.isArray(analysis.revision_groups) ? analysis.revision_groups : [];
    const existingIndex = registry.findIndex((item) => item?.group_id === storedGroup.group_id);
    if (existingIndex >= 0) registry[existingIndex] = storedGroup;
    else registry.push(storedGroup);
    analysis.revision_groups = registry;
};

const markSuggestionApplied = (analysis, indexes, mode, documentKey, revisionGroups = new Map()) => {
    const suggestions = Array.isArray(analysis.modification_suggestions)
        ? analysis.modification_suggestions
        : [];
    for (const index of indexes) {
        const item = suggestions[Number(index)];
        if (!item) continue;
        item.application_status = mode === 'review' ? 'pending_review' : 'applied';
        item.review_pending = mode === 'review';
        item.adopted = mode === 'edit';
        item.applied_at = new Date().toISOString();
        item.applied_document_key = documentKey;
        persistRevisionGroup(analysis, item, revisionGroups.get(Number(index)), documentKey);
    }
    return analysis;
};

const tempDocxPath = (storagePath) => `${storagePath}.${uuidv4()}.tmp`;

const activeContractEdits = new Set();

const acquireContractEditLock = (contractId) => {
    const key = String(contractId);
    if (activeContractEdits.has(key)) {
        const error = new Error('DOCUMENT_EDIT_IN_PROGRESS');
        error.status = 409;
        throw error;
    }
    activeContractEdits.add(key);
    return () => activeContractEdits.delete(key);
};

const fileSha256 = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const restoreFileAtomically = (filePath, contents) => {
    const restorePath = `${filePath}.restore-${uuidv4()}.tmp`;
    try {
        fs.writeFileSync(restorePath, contents);
        fs.renameSync(restorePath, filePath);
    } finally {
        if (fs.existsSync(restorePath)) fs.unlinkSync(restorePath);
    }
};

const assertCurrentDocumentKey = (contract, expectedDocumentKey) => {
    if (expectedDocumentKey && expectedDocumentKey !== contract.document_key) {
        const error = new Error('DOCUMENT_VERSION_STALE');
        error.status = 409;
        throw error;
    }
};

const assertEditPrecondition = (contract, expectedDocumentKey, expectedSha256) => {
    if (!String(expectedDocumentKey || '').trim()) {
        const error = new Error('DOCUMENT_VERSION_REQUIRED');
        error.status = 428;
        throw error;
    }
    assertCurrentDocumentKey(contract, expectedDocumentKey);
    if (expectedSha256 && contract.oss_sha256 && expectedSha256 !== contract.oss_sha256) {
        const error = new Error('DOCUMENT_VERSION_STALE');
        error.status = 409;
        throw error;
    }
};

const assertDocumentFileUnchanged = (filePath, expectedSha256) => {
    if (fileSha256(filePath) !== expectedSha256) {
        const error = new Error('DOCUMENT_CONTENT_CHANGED');
        error.status = 409;
        throw error;
    }
};

const docxErrorResponse = (res, error, fallback) => {
    const messages = {
        DOCX_EXACT_TEXT_NOT_FOUND: '未能在当前 DOCX 中唯一定位该条款。系统已取消本次修改，文档未发生变化。',
        DOCX_TEXT_MATCH_AMBIGUOUS: '文档中存在多个相同片段，无法安全确定修改位置。请先定位并缩短原文后重试。',
        DOCX_COMPLEX_PARAGRAPH_UNSUPPORTED: '目标条款已包含批注、修订或复杂域，无法安全自动改写，请在左侧文档中人工处理。',
        DOCX_MULTI_PARAGRAPH_REPLACEMENT_UNSUPPORTED: '该建议包含多个段落，不能安全写入单个原文段落。系统已取消修改，请改用新增条款或人工审阅。',
        DOCX_REPLACEMENT_SCOPE_MISMATCH: '建议内容的结构范围与定位到的原文不一致，系统已阻止写入以避免破坏合同格式。',
        DOCX_BATCH_ABORTED: '批量修订中至少一项无法安全应用，本次批量已全部取消，文档未发生变化。',
        DOCX_APPEND_MIXED_SECTIONS: '新增建议同时包含多个不同目录的条款，系统已取消写入。请拆分为独立建议后分别新增。',
        DOCUMENT_VERSION_STALE: '文档已被其他修改更新，请刷新后再采纳该建议。',
        DOCUMENT_VERSION_REQUIRED: '缺少当前文档版本标识，系统已取消写入。请刷新后重试。',
        DOCUMENT_CONTENT_CHANGED: '编辑期间 OnlyOffice 已保存新内容，系统已取消本次 AI 写入以避免覆盖。请刷新后重试。',
        DOCUMENT_EDIT_IN_PROGRESS: '该合同正在执行另一次修订，请稍后重试。',
        REVISION_GROUP_NOT_FOUND: '未找到该建议对应的审阅修订组。',
        REVISION_GROUP_NOT_PENDING: '该建议的修订状态已变化，请先同步文档状态后重试。',
        REVISION_GROUP_AMBIGUOUS: '文档内存在重复的修订标识，系统已取消处理以避免误改。',
        INVALID_REVISION_RESOLUTION: '修订处理方式无效。',
    };
    if (messages[error.message]) {
        return res.status(error.status || 409).json({
            error: messages[error.message], code: error.message, ...(error.results ? { results: error.results } : {}),
        });
    }
    console.error(`[ERROR] ${fallback}:`, error);
    return res.status(500).json({ error: fallback });
};

const updateContractAfterApply = async (contract, nextKey, analysis, appliedIndexes, mode, revisionGroups = new Map()) => {
    const updatedAnalysis = markSuggestionApplied(analysis, appliedIndexes, mode, nextKey, revisionGroups);
    const mirrored = await mirrorContractFile(contract.storage_path, {
        owner: `user-${contract.user_id}`,
        contractId: contract.id,
        version: `${mode}-${Date.now()}`,
    });
    await db('contracts').where({ id: contract.id }).update({
        document_key: nextKey,
        analysis_result: JSON.stringify(updatedAnalysis),
        oss_key: mirrored.oss_key,
        oss_sha256: mirrored.sha256,
        updated_at: db.fn.now(),
    });
};

const suggestionIdentity = (contract, suggestionIndex, providedId) => {
    if (String(providedId || '').trim()) return String(providedId).trim();
    if (Number.isInteger(Number(suggestionIndex))) return `contract-${contract.id}-suggestion-${Number(suggestionIndex)}`;
    return `contract-${contract.id}-suggestion-${uuidv4()}`;
};

const emitSuggestionStatusChanged = (
    req, contractId, suggestionIndex, applicationStatus, revisionGroup, documentKey, editorConfig,
) => {
    const io = req.app?.get?.('io') || getIoInstance();
    if (!io) return;
    io.to(`contract-${contractId}`).emit('suggestion-status-changed', {
        contractId,
        contract_id: contractId,
        suggestionIndex: Number(suggestionIndex),
        suggestion_index: Number(suggestionIndex),
        applicationStatus,
        application_status: applicationStatus,
        revisionStatus: revisionGroup?.status || '',
        revision_status: revisionGroup?.status || '',
        suggestionId: revisionGroup?.suggestion_id || '',
        suggestion_id: revisionGroup?.suggestion_id || '',
        documentKey: documentKey || revisionGroup?.document_key || '',
        document_key: documentKey || revisionGroup?.document_key || '',
        editorConfig,
    });
};

const updateResolvedSuggestion = (analysis, suggestionIndex, resolution, documentKey) => {
    const suggestions = Array.isArray(analysis.modification_suggestions)
        ? analysis.modification_suggestions
        : [];
    const item = suggestions[Number(suggestionIndex)];
    if (!item?.revision_group) throw new Error('REVISION_GROUP_NOT_FOUND');
    const resolvedAt = new Date().toISOString();
    const status = resolution === 'accept' ? 'accepted' : 'rejected';
    item.revision_group.status = status;
    item.revision_group.resolved_at = resolvedAt;
    item.revision_group.document_key = documentKey;
    item.application_status = resolution === 'accept' ? 'applied' : 'rejected';
    item.review_pending = false;
    item.adopted = resolution === 'accept';
    item.resolved_at = resolvedAt;
    item.applied_document_key = documentKey;
    if (Array.isArray(analysis.revision_groups)) {
        const registered = analysis.revision_groups.find((group) => group?.group_id === item.revision_group.group_id);
        if (registered) Object.assign(registered, item.revision_group);
    }
    return item;
};

module.exports = function (router) {
    router.post('/:id/replace-text', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const {
            originalText, suggestedText, originalCandidates = [], mode: rawMode,
            expectedDocumentKey, expectedSha256, suggestionIndex, suggestionId,
        } = req.body || {};
        if (!String(originalText || '').trim() || suggestedText === undefined || suggestedText === null) {
            return res.status(400).json({ error: 'originalText and suggestedText are required.' });
        }
        const mode = rawMode === 'review' ? 'review' : 'edit';
        let workingPath = '';
        let releaseEditLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, expectedDocumentKey, expectedSha256);
            releaseEditLock = acquireContractEditLock(contract.id);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') {
                return res.status(400).json({
                    error: 'PDF 文件暂不支持原文直接改写，请使用 PDF 批注意见或审查报告导出。',
                    code: 'PDF_REPLACE_NOT_SUPPORTED',
                });
            }

            originalFileContents = fs.readFileSync(contract.storage_path);
            const initialFileSha256 = createHash('sha256').update(originalFileContents).digest('hex');
            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const analysis = parseAnalysisResult(contract);
            const previousSuggestion = Number.isInteger(Number(suggestionIndex))
                ? analysis.modification_suggestions?.[Number(suggestionIndex)]
                : null;
            const stableSuggestionId = suggestionIdentity(contract, suggestionIndex, suggestionId);
            const result = replaceTextInDocx(workingPath, originalText, suggestedText, originalCandidates, {
                mode,
                author: 'AI审查',
                suggestionId: stableSuggestionId,
                revisionGroupId: `ai-${uuidv4()}`,
                previousRevisionGroup: previousSuggestion?.revision_group,
                previousApplicationStatus: previousSuggestion?.application_status,
            });
            assertDocumentFileUnchanged(contract.storage_path, initialFileSha256);
            const version = await createContractVersionSnapshot(contract, `${mode}-replace-text`);
            fs.renameSync(workingPath, contract.storage_path);
            workingPath = '';
            documentReplaced = true;

            const nextKey = uuidv4();
            const indexes = Number.isInteger(Number(suggestionIndex)) ? [Number(suggestionIndex)] : [];
            const revisionGroups = new Map();
            if (indexes.length && result.revisionGroup) revisionGroups.set(indexes[0], result.revisionGroup);
            await updateContractAfterApply(contract, nextKey, analysis, indexes, mode, revisionGroups);
            commitComplete = true;
            return res.json({
                ...result,
                version,
                applicationStatus: mode === 'review' ? 'pending_review' : 'applied',
                editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: mode === 'review' }),
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '服务端 DOCX 替换失败。');
        } finally {
            releaseEditLock?.();
        }
    });

    router.post('/:id/batch-replace-text', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
        if (!suggestions.length) return res.status(400).json({ error: '请至少选择一条修改建议。' });
        const mode = req.body?.mode === 'review' ? 'review' : 'edit';
        let workingPath = '';
        let releaseEditLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, req.body?.expectedDocumentKey, req.body?.expectedSha256);
            releaseEditLock = acquireContractEditLock(contract.id);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') return res.status(400).json({ error: 'PDF 文件暂不支持原文直接改写。', code: 'PDF_REPLACE_NOT_SUPPORTED' });

            originalFileContents = fs.readFileSync(contract.storage_path);
            const initialFileSha256 = createHash('sha256').update(originalFileContents).digest('hex');
            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const analysis = parseAnalysisResult(contract);
            const replacements = suggestions.map((item) => {
                const originalText = item.originalText || item.original_text || item.original_clause;
                const suggestedText = item.suggestedText ?? item.suggested_text ?? item.modification;
                const previousSuggestion = Number.isInteger(Number(item.suggestionIndex))
                    ? analysis.modification_suggestions?.[Number(item.suggestionIndex)]
                    : null;
                return {
                    originalText,
                    suggestedText,
                    originalCandidates: item.originalCandidates || item.original_candidates || [],
                    suggestionIndex: item.suggestionIndex,
                    title: item.title || '',
                    options: {
                        mode,
                        author: 'AI审查',
                        suggestionId: suggestionIdentity(
                            contract, item.suggestionIndex, item.suggestionId || item.suggestion_id || item.id,
                        ),
                        revisionGroupId: `ai-${uuidv4()}`,
                        previousRevisionGroup: previousSuggestion?.revision_group,
                        previousApplicationStatus: previousSuggestion?.application_status,
                    },
                };
            });
            const batchResult = replaceTextsInDocxAtomic(workingPath, replacements);
            const results = batchResult.results;
            const totalReplacements = batchResult.replacements;
            const appliedIndexes = results
                .filter((item) => Number.isInteger(Number(item.suggestionIndex)))
                .map((item) => Number(item.suggestionIndex));
            const succeededCount = results.length;
            const failedCount = 0;

            assertDocumentFileUnchanged(contract.storage_path, initialFileSha256);
            const version = await createContractVersionSnapshot(contract, `${mode}-batch-replace-text`);
            fs.renameSync(workingPath, contract.storage_path);
            workingPath = '';
            documentReplaced = true;
            const nextKey = uuidv4();
            const revisionGroups = new Map();
            for (const item of results) {
                if (item.ok && Number.isInteger(Number(item.suggestionIndex)) && item.revisionGroup) {
                    revisionGroups.set(Number(item.suggestionIndex), item.revisionGroup);
                }
            }
            await updateContractAfterApply(contract, nextKey, analysis, appliedIndexes, mode, revisionGroups);
            commitComplete = true;
            return res.json({
                version, mode,
                applicationStatus: mode === 'review' ? 'pending_review' : 'applied',
                totalReplacements, succeededCount, failedCount, results,
                editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: mode === 'review' }),
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '批量替换失败。');
        } finally {
            releaseEditLock?.();
        }
    });

    router.post('/:id/append-clause', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const body = req.body || {};
        const {
            title, content, expectedDocumentKey, expectedSha256, suggestionIndex,
            targetClauseNo, targetHeading,
        } = body;
        const anchorHint = body.anchorHint ?? body.anchor_hint;
        const currentClause = body.currentClause ?? body.current_clause;
        if (!String(content || '').trim()) return res.status(400).json({ error: '追加条款内容不能为空。' });
        const mode = req.body?.mode === 'review' ? 'review' : 'edit';
        let workingPath = '';
        let releaseEditLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, expectedDocumentKey, expectedSha256);
            releaseEditLock = acquireContractEditLock(contract.id);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') return res.status(400).json({ error: 'PDF 文件暂不支持追加条款。', code: 'PDF_APPEND_NOT_SUPPORTED' });

            originalFileContents = fs.readFileSync(contract.storage_path);
            const initialFileSha256 = createHash('sha256').update(originalFileContents).digest('hex');
            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const appendResult = appendClauseInDocx(workingPath, title, content, {
                mode,
                author: 'AI审查',
                anchorHint,
                currentClause,
                targetClauseNo,
                targetHeading,
            });
            if (appendResult.alreadyPresent) {
                fs.unlinkSync(workingPath);
                workingPath = '';
                const indexes = Number.isInteger(Number(suggestionIndex)) ? [Number(suggestionIndex)] : [];
                // The exact clause is already part of the source document, so there is no
                // pending tracked revision even when the user clicked the review action.
                await updateContractAfterApply(contract, contract.document_key, parseAnalysisResult(contract), indexes, 'edit');
                commitComplete = true;
                return res.json({
                    ok: true,
                    alreadyPresent: true,
                    ...appendResult,
                    applicationStatus: 'applied',
                    message: `条款「${title || '未命名条款'}」已存在，未重复追加。`,
                    editorConfig: buildOnlyOfficeConfig(contract, ext, { reviewMode: mode === 'review' }),
                });
            }

            assertDocumentFileUnchanged(contract.storage_path, initialFileSha256);
            const version = await createContractVersionSnapshot(contract, `${mode}-append-clause`);
            fs.renameSync(workingPath, contract.storage_path);
            workingPath = '';
            documentReplaced = true;
            const nextKey = uuidv4();
            const indexes = Number.isInteger(Number(suggestionIndex)) ? [Number(suggestionIndex)] : [];
            await updateContractAfterApply(contract, nextKey, parseAnalysisResult(contract), indexes, mode);
            commitComplete = true;
            return res.json({
                ok: true, mode, version, ...appendResult,
                applicationStatus: mode === 'review' ? 'pending_review' : 'applied',
                message: mode === 'review'
                    ? `已将条款 ${appendResult.insertedClauseNo} 加入审阅修订。`
                    : `已将条款 ${appendResult.insertedClauseNo} 写入合同目录。`,
                editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: mode === 'review' }),
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '追加条款失败。');
        } finally {
            releaseEditLock?.();
        }
    });

    router.post('/:id/revisions/sync', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            assertCurrentDocumentKey(contract, req.body?.expectedDocumentKey);
            const syncResult = syncRevisionGroupsFromDocx(contract.storage_path, parseAnalysisResult(contract));
            const requiresReload = syncResult.changed
                && syncResult.results.some((item) => ['accepted', 'rejected'].includes(item.status));
            const nextKey = requiresReload ? uuidv4() : contract.document_key;
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            const editorConfig = requiresReload
                ? buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: true })
                : undefined;
            if (syncResult.changed) {
                for (const revision of syncResult.results) {
                    const group = syncResult.analysis.modification_suggestions?.[revision.index]?.revision_group;
                    if (group && ['accepted', 'rejected'].includes(revision.status)) group.document_key = nextKey;
                }
                const update = {
                    analysis_result: JSON.stringify(syncResult.analysis),
                    updated_at: db.fn.now(),
                };
                if (syncResult.documentChanged) {
                    const mirrored = await mirrorContractFile(contract.storage_path, {
                        owner: `user-${contract.user_id}`,
                        contractId: contract.id,
                        version: `revision-sync-${Date.now()}`,
                    });
                    update.oss_key = mirrored.oss_key;
                    update.oss_sha256 = mirrored.sha256;
                }
                if (requiresReload) update.document_key = nextKey;
                await db('contracts').where({ id: contract.id }).update(update);
                for (const revision of syncResult.results.filter((item) => ['accepted', 'rejected'].includes(item.status))) {
                    const suggestion = syncResult.analysis.modification_suggestions?.[revision.index];
                    emitSuggestionStatusChanged(
                        req,
                        contract.id,
                        revision.index,
                        suggestion?.application_status || (revision.status === 'accepted' ? 'applied' : 'rejected'),
                        suggestion?.revision_group,
                        nextKey,
                        editorConfig,
                    );
                }
            }
            return res.json({
                ok: true,
                changed: syncResult.changed,
                documentChanged: syncResult.documentChanged,
                revisions: syncResult.results,
                editorConfig,
            });
        } catch (error) {
            return docxErrorResponse(res, error, '同步审阅修订状态失败。');
        }
    });

    const resolveRevision = (resolution) => async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        let workingPath = '';
        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            assertCurrentDocumentKey(contract, req.body?.expectedDocumentKey);
            const analysis = parseAnalysisResult(contract);
            const suggestionIndex = Number(req.params.suggestionIndex);
            const suggestion = analysis.modification_suggestions?.[suggestionIndex];
            if (!suggestion?.revision_group) throw new Error('REVISION_GROUP_NOT_FOUND');

            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const result = resolveRevisionGroupInDocx(workingPath, suggestion.revision_group, resolution);
            let version = null;
            let nextKey = contract.document_key;
            if (result.changed) {
                version = await createContractVersionSnapshot(contract, `review-${resolution}-suggestion`);
                fs.renameSync(workingPath, contract.storage_path);
                workingPath = '';
                nextKey = uuidv4();
            } else {
                fs.unlinkSync(workingPath);
                workingPath = '';
            }

            updateResolvedSuggestion(analysis, suggestionIndex, resolution, nextKey);
            const mirrored = result.changed
                ? await mirrorContractFile(contract.storage_path, {
                    owner: `user-${contract.user_id}`,
                    contractId: contract.id,
                    version: `revision-${resolution}-${Date.now()}`,
                })
                : { oss_key: contract.oss_key, sha256: contract.oss_sha256 };
            await db('contracts').where({ id: contract.id }).update({
                document_key: nextKey,
                analysis_result: JSON.stringify(analysis),
                oss_key: mirrored.oss_key,
                oss_sha256: mirrored.sha256,
                updated_at: db.fn.now(),
            });
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            const editorConfig = buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: true });
            emitSuggestionStatusChanged(
                req,
                contract.id,
                suggestionIndex,
                suggestion.application_status,
                suggestion.revision_group,
                nextKey,
                editorConfig,
            );
            return res.json({
                ok: true,
                resolution,
                status: result.status,
                changed: result.changed,
                alreadyResolved: result.alreadyResolved,
                version,
                revisionGroup: suggestion.revision_group,
                editorConfig,
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            return docxErrorResponse(res, error, resolution === 'accept'
                ? '接受审阅修订失败。'
                : '拒绝审阅修订失败。');
        }
    };

    router.post('/:id/revisions/:suggestionIndex/accept', resolveRevision('accept'));
    router.post('/:id/revisions/:suggestionIndex/reject', resolveRevision('reject'));

    // Unified API consumed by the review UI. Keep the explicit accept/reject
    // endpoints above for compatibility with integrations already using them.
    router.post('/:id/suggestions/:suggestionIndex/status', async (req, res, next) => {
        const requestedStatus = String(req.body?.status || '').toLowerCase();
        if (['accept', 'accepted', 'applied'].includes(requestedStatus)) {
            return resolveRevision('accept')(req, res, next);
        }
        if (['reject', 'rejected'].includes(requestedStatus)) {
            return resolveRevision('reject')(req, res, next);
        }
        return res.status(400).json({ error: '状态必须为 accepted/applied 或 rejected。', code: 'INVALID_REVISION_RESOLUTION' });
    });

    router.get('/:id/suggestion-statuses', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        try {
            const contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            const analysis = parseAnalysisResult(contract);
            const suggestions = Array.isArray(analysis.modification_suggestions)
                ? analysis.modification_suggestions
                : [];
            return res.json({
                contractId: contract.id,
                contract_id: contract.id,
                documentKey: contract.document_key,
                statuses: suggestions.map((item, index) => ({
                    suggestionIndex: index,
                    suggestion_index: index,
                    suggestionId: item?.revision_group?.suggestion_id || item?.suggestion_id || item?.id || '',
                    suggestion_id: item?.revision_group?.suggestion_id || item?.suggestion_id || item?.id || '',
                    applicationStatus: item?.application_status || 'pending',
                    application_status: item?.application_status || 'pending',
                    revisionStatus: item?.revision_group?.status || '',
                    revision_status: item?.revision_group?.status || '',
                })),
            });
        } catch (error) {
            return docxErrorResponse(res, error, '读取建议处理状态失败。');
        }
    });
};
