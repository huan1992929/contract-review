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
    preflightTextReplacementsInDocx,
    appendClauseInDocx,
    resolveRevisionGroupInDocx,
    syncRevisionGroupsFromDocx,
} = require('../../services/contractAnalysis/docxEdit');
const { buildOnlyOfficeConfig } = require('../../services/contractAnalysis/onlyoffice');
const { getIoInstance } = require('../../services/contractAnalysis/analysisJob');
const { mirrorContractFile } = require('../../services/thinkparkStorageGateway');
const { acquireContractWriteLock } = require('../../services/contractAnalysis/contractWriteLock');

const parseAnalysisResult = (contract) => {
    try {
        return typeof contract.analysis_result === 'string'
            ? JSON.parse(contract.analysis_result || '{}')
            : (contract.analysis_result || {});
    } catch {
        return {};
    }
};

const persistRevisionGroups = (analysis, suggestion, revisionGroups, documentKey) => {
    const storedGroups = (Array.isArray(revisionGroups) ? revisionGroups : [revisionGroups])
        .filter(Boolean)
        .map((revisionGroup) => ({ ...revisionGroup, document_key: documentKey }));
    if (!storedGroups.length) return;
    suggestion.revision_groups = storedGroups;
    // 保留单组字段兼容历史前端和旧分析结果。
    suggestion.revision_group = storedGroups[0];
    const registry = Array.isArray(analysis.revision_groups) ? analysis.revision_groups : [];
    for (const storedGroup of storedGroups) {
        const existingIndex = registry.findIndex((item) => item?.group_id === storedGroup.group_id);
        if (existingIndex >= 0) registry[existingIndex] = storedGroup;
        else registry.push(storedGroup);
    }
    analysis.revision_groups = registry;
};

const markSupersededRevisionGroups = (analysis, suggestion, results = []) => {
    const superseded = results
        .map((result) => result?.supersededRevisionGroup)
        .filter((group) => group?.group_id);
    if (!superseded.length) return;
    const now = new Date().toISOString();
    const registry = Array.isArray(analysis.revision_groups) ? analysis.revision_groups : [];
    const history = Array.isArray(suggestion.revision_history) ? suggestion.revision_history : [];
    for (const oldGroup of superseded) {
        const replacementGroup = results.find(
            (result) => result?.supersededRevisionGroup?.group_id === oldGroup.group_id,
        )?.revisionGroup;
        const record = {
            ...oldGroup,
            status: 'superseded',
            superseded_at: now,
            superseded_by_group_id: replacementGroup?.group_id || null,
        };
        const registryIndex = registry.findIndex((item) => item?.group_id === oldGroup.group_id);
        if (registryIndex >= 0) registry[registryIndex] = record;
        else registry.push(record);
        const historyIndex = history.findIndex((item) => item?.group_id === oldGroup.group_id);
        if (historyIndex >= 0) history[historyIndex] = record;
        else history.push(record);
    }
    analysis.revision_groups = registry;
    suggestion.revision_history = history;
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
        persistRevisionGroups(analysis, item, revisionGroups.get(Number(index)), documentKey);
    }
    return analysis;
};

const previousRevisionGroupForChange = (suggestion, changeIndex = 0) => {
    const groups = Array.isArray(suggestion?.revision_groups) && suggestion.revision_groups.length
        ? suggestion.revision_groups
        : (suggestion?.revision_group ? [suggestion.revision_group] : []);
    return groups[Number.isInteger(Number(changeIndex)) ? Number(changeIndex) : 0] || null;
};

const tempDocxPath = (storagePath) => `${storagePath}.${uuidv4()}.tmp`;

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
        DOCX_COMMENTED_PARAGRAPH_UNSUPPORTED: '目标条款包含批注范围，系统已停止自动修订以避免破坏批注。',
        DOCX_STRUCTURED_PARAGRAPH_UNSUPPORTED: '目标条款包含域、内容控件或超链接，暂不支持自动修订。',
        DOCX_HUMAN_REVISION_CONFLICT: '目标条款包含人工或对方的未决修订，请建立下一轮或先处理冲突。',
        DOCX_COMPOSITE_REVISION_AMBIGUOUS: '目标条款包含多组已有修订，无法安全合并为一个待审条款。',
        DOCX_COMPOSITE_REVISION_CONTENT_MISMATCH: '审核结果中的原文或已有修订意见与当前 DOCX 不一致，请重新全文审核。',
        DOCX_COMPOSITE_REVISION_ORDER_UNSUPPORTED: '目标条款的已有修订顺序异常，系统已停止自动覆盖。',
        DOCX_COMPOSITE_REVISION_GAP_UNSUPPORTED: '目标条款的原文与修订意见之间还包含其他正文，不能安全整体替换。',
        DOCX_COMMENT_CONFLICT: '目标条款的批注范围与已有修订交叉，不能安全整体替换。',
        DOCX_EXISTING_SYSTEM_REVISION_NEEDS_NEW_ROUND: '目标条款已有无法归属到本轮建议的系统修订，请建立下一轮处理。',
        DOCX_BATCH_RANGE_OVERLAP: '多条建议修改了同一条款的重叠范围，系统已取消整批写入。',
        DOCX_BATCH_SAME_PARAGRAPH_UNSUPPORTED: '多条建议同时修改同一段落，请先合并为一条建议。',
        DOCX_BATCH_DUPLICATE_REVISION_GROUP: '多个修改错误地指向同一个历史修订组，系统已取消整批写入。',
        DOCX_MULTI_PARAGRAPH_REPLACEMENT_UNSUPPORTED: '该建议包含多个段落，不能安全写入单个原文段落。系统已取消修改，请改用新增条款或人工审阅。',
        DOCX_REPLACEMENT_SCOPE_MISMATCH: '建议内容的结构范围与定位到的原文不一致，系统已阻止写入以避免破坏合同格式。',
        DOCX_BATCH_ABORTED: '批量修订中至少一项无法安全应用，本次批量已全部取消，文档未发生变化。',
        DOCX_APPEND_MIXED_SECTIONS: '新增建议同时包含多个不同目录的条款，系统已取消写入。请拆分为独立建议后分别新增。',
        DOCUMENT_VERSION_STALE: '文档已被其他修改更新，请刷新后再采纳该建议。',
        DOCUMENT_VERSION_REQUIRED: '缺少当前文档版本标识，系统已取消写入。请刷新后重试。',
        DOCUMENT_CONTENT_CHANGED: '编辑期间 OnlyOffice 已保存新内容，系统已取消本次 AI 写入以避免覆盖。请刷新后重试。',
        DOCUMENT_EDIT_IN_PROGRESS: '该合同正在执行另一次修订，请稍后重试。',
        DOCUMENT_EDIT_CAPACITY: '当前合同修订任务较多，系统已保留数据库安全容量，请稍后重试。',
        DOCUMENT_COMMIT_ORPHAN_OSS: '文档提交未完成，系统已回滚当前文件并记录存储清理任务，请勿立即重试。',
        REVISION_GROUP_NOT_FOUND: '未找到该建议对应的审阅修订组。',
        REVISION_GROUP_NOT_PENDING: '该建议的修订状态已变化，请先同步文档状态后重试。',
        REVISION_GROUP_AMBIGUOUS: '文档内存在重复的修订标识，系统已取消处理以避免误改。',
        REVISION_GROUP_ID_REQUIRED: '未找到本轮历史修订标识，不能安全覆盖现有修订。',
        REVISION_GROUP_AUTHOR_MISMATCH: '现有修订作者与本轮系统建议不一致，不能自动覆盖。',
        REVISION_GROUP_SUGGESTION_MISMATCH: '现有修订不属于当前建议，请建立下一轮或人工处理。',
        REVISION_GROUP_CONTENT_MISMATCH: '现有修订内容与登记记录不一致，请刷新或建立下一轮处理。',
        INVALID_REVISION_RESOLUTION: '修订处理方式无效。',
    };
    if (messages[error.message]) {
        if (error.message === 'DOCUMENT_EDIT_CAPACITY') res.set('Retry-After', '2');
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
    try {
        const affected = await db('contracts').where({ id: contract.id, document_key: contract.document_key }).update({
            document_key: nextKey,
            analysis_result: JSON.stringify(updatedAnalysis),
            oss_key: mirrored.oss_key,
            oss_sha256: mirrored.sha256,
            updated_at: db.fn.now(),
        });
        if (affected !== 1) {
            const error = new Error('DOCUMENT_VERSION_STALE');
            error.status = 409;
            throw error;
        }
    } catch (cause) {
        console.error('[Contract Storage Orphan] contracts update failed after mirror', {
            contractId: contract.id, ossKey: mirrored.oss_key, cause: cause.message,
        });
        const error = new Error('DOCUMENT_COMMIT_ORPHAN_OSS');
        error.status = 500;
        error.cause = cause;
        throw error;
    }
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
    const groups = Array.isArray(item?.revision_groups) && item.revision_groups.length
        ? item.revision_groups
        : (item?.revision_group ? [item.revision_group] : []);
    if (!groups.length) throw new Error('REVISION_GROUP_NOT_FOUND');
    const resolvedAt = new Date().toISOString();
    const status = resolution === 'accept' ? 'accepted' : 'rejected';
    item.revision_groups = groups.map((group) => ({
        ...group,
        status,
        resolved_at: resolvedAt,
        document_key: documentKey,
    }));
    item.revision_group = item.revision_groups[0];
    item.application_status = resolution === 'accept' ? 'applied' : 'rejected';
    item.review_pending = false;
    item.adopted = resolution === 'accept';
    item.resolved_at = resolvedAt;
    item.applied_document_key = documentKey;
    if (Array.isArray(analysis.revision_groups)) {
        for (const resolvedGroup of item.revision_groups) {
            const registered = analysis.revision_groups.find((group) => group?.group_id === resolvedGroup.group_id);
            if (registered) Object.assign(registered, resolvedGroup);
        }
    }
    return item;
};

module.exports = function (router) {
    router.post('/:id/revisions/preflight', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
        if (!suggestions.length) return res.status(400).json({ error: '请至少提供一条待预检的修订建议。' });
        let releaseWriteLock = null;
        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            assertEditPrecondition(contract, req.body?.expectedDocumentKey, req.body?.expectedSha256);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') {
                return res.status(400).json({ error: 'PDF 文件暂不支持原文修订预检。', code: 'PDF_REPLACE_NOT_SUPPORTED' });
            }
            const analysis = parseAnalysisResult(contract);
            const replacements = [];
            const appendResults = [];
            for (const [requestIndex, item] of suggestions.entries()) {
                const suggestionIndex = Number(item.suggestionIndex ?? item.suggestion_index);
                const previousSuggestion = Number.isInteger(suggestionIndex)
                    ? analysis.modification_suggestions?.[suggestionIndex]
                    : null;
                const changeIndex = Number(item.changeIndex ?? item.change_index ?? 0);
                const identity = {
                    index: requestIndex,
                    requestIndex,
                    suggestionIndex: Number.isInteger(suggestionIndex) ? suggestionIndex : item.suggestionIndex,
                    changeIndex: Number.isInteger(changeIndex) ? changeIndex : 0,
                    suggestionId: suggestionIdentity(
                        contract, suggestionIndex, item.suggestionId || item.suggestion_id || item.id,
                    ),
                    title: String(item.title || ''),
                };
                if (item.operation === 'append') {
                    if (req.body?.mode === 'review') {
                        appendResults.push({
                            ...identity,
                            status: 'unsupported',
                            code: 'DOCX_APPEND_REVIEW_LIFECYCLE_UNSUPPORTED',
                            message: '新增条款的多组审阅生命周期尚未开放，本次不写入文档；可切换为直接编辑或人工新增。',
                        });
                        continue;
                    }
                    let preflightPath = '';
                    try {
                        preflightPath = tempDocxPath(contract.storage_path);
                        fs.copyFileSync(contract.storage_path, preflightPath);
                        const appendResult = appendClauseInDocx(preflightPath, item.title, item.suggestedText, {
                            mode: 'review',
                            author: 'AI审查',
                            anchorHint: item.anchorHint || item.anchor_hint || '',
                            currentClause: item.originalText || item.currentClause || item.current_clause || '',
                            targetClauseNo: item.targetClauseNo || item.target_clause_no || '',
                            targetHeading: item.targetHeading || item.target_heading || '',
                        });
                        appendResults.push({
                            ...identity,
                            status: 'safe_new',
                            code: appendResult.alreadyPresent ? 'APPEND_ALREADY_PRESENT' : 'APPEND_SAFE_NEW',
                            message: appendResult.alreadyPresent
                                ? '目标条款已经存在，不会重复新增。'
                                : '可在当前合同结构中安全新增审阅条款。',
                        });
                    } catch (error) {
                        appendResults.push({
                            ...identity,
                            status: 'unsupported',
                            code: error.message || 'DOCX_APPEND_PREFLIGHT_FAILED',
                            message: '新增条款无法安全定位，请人工确认插入位置。',
                        });
                    } finally {
                        if (preflightPath && fs.existsSync(preflightPath)) fs.unlinkSync(preflightPath);
                    }
                    continue;
                }
                replacements.push({
                    requestIndex,
                    originalText: item.originalText || item.original_text || item.original_clause,
                    suggestedText: item.suggestedText ?? item.suggested_text ?? item.modification,
                    originalCandidates: item.originalCandidates || item.original_candidates || [],
                    suggestionIndex: identity.suggestionIndex,
                    suggestionId: identity.suggestionId,
                    title: identity.title,
                    options: {
                        mode: 'review',
                        author: 'AI审查',
                        suggestionId: identity.suggestionId,
                        previousRevisionGroup: previousRevisionGroupForChange(previousSuggestion, identity.changeIndex),
                        previousApplicationStatus: previousSuggestion?.application_status,
                        existingRevisionText: item.existingRevisionText || item.existing_revision_text || '',
                        reviewBaseline: item.reviewBaseline || item.review_baseline || '',
                    },
                });
            }
            const replacementPreflight = replacements.length
                ? preflightTextReplacementsInDocx(contract.storage_path, replacements)
                : { results: [] };
            const replacementResults = replacementPreflight.results.map((result, index) => ({
                ...result,
                index: replacements[index].requestIndex,
                requestIndex: replacements[index].requestIndex,
                changeIndex: Number(suggestions[replacements[index].requestIndex]?.changeIndex
                    ?? suggestions[replacements[index].requestIndex]?.change_index ?? 0),
            }));
            const results = [...replacementResults, ...appendResults].sort((left, right) => left.index - right.index);
            const summary = results.reduce((counts, result) => {
                counts.total += 1;
                counts[result.status] = (counts[result.status] || 0) + 1;
                return counts;
            }, { total: 0, safe_new: 0, safe_supersede: 0, safe_composite: 0, needs_new_round: 0, human_conflict: 0, unsupported: 0 });
            return res.json({ results, summary, documentKey: contract.document_key, documentSha256: fileSha256(contract.storage_path) });
        } catch (error) {
            return docxErrorResponse(res, error, '审阅修订预检失败。');
        } finally {
            await releaseWriteLock?.();
        }
    });

    router.post('/:id/replace-text', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const {
            originalText, suggestedText, originalCandidates = [], mode: rawMode,
            expectedDocumentKey, expectedSha256, suggestionIndex, suggestionId,
            existingRevisionText, existing_revision_text: existingRevisionTextSnake,
            reviewBaseline, review_baseline: reviewBaselineSnake,
        } = req.body || {};
        if (!String(originalText || '').trim() || suggestedText === undefined || suggestedText === null) {
            return res.status(400).json({ error: 'originalText and suggestedText are required.' });
        }
        const mode = rawMode === 'review' ? 'review' : 'edit';
        let workingPath = '';
        let releaseWriteLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, expectedDocumentKey, expectedSha256);
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
                previousRevisionGroup: previousRevisionGroupForChange(previousSuggestion, 0),
                previousApplicationStatus: previousSuggestion?.application_status,
                existingRevisionText: existingRevisionText || existingRevisionTextSnake || '',
                reviewBaseline: reviewBaseline || reviewBaselineSnake || '',
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
            if (previousSuggestion) markSupersededRevisionGroups(analysis, previousSuggestion, [result]);
            await updateContractAfterApply(contract, nextKey, analysis, indexes, mode, revisionGroups);
            commitComplete = true;
            return res.json({
                ...result,
                version,
                applicationStatus: mode === 'review' ? 'pending_review' : 'applied',
                documentSha256: fileSha256(contract.storage_path),
                editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: mode === 'review' }),
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '服务端 DOCX 替换失败。');
        } finally {
            await releaseWriteLock?.();
        }
    });

    router.post('/:id/batch-replace-text', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
        if (!suggestions.length) return res.status(400).json({ error: '请至少选择一条修改建议。' });
        const mode = req.body?.mode === 'review' ? 'review' : 'edit';
        let workingPath = '';
        let releaseWriteLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, req.body?.expectedDocumentKey, req.body?.expectedSha256);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') return res.status(400).json({ error: 'PDF 文件暂不支持原文直接改写。', code: 'PDF_REPLACE_NOT_SUPPORTED' });

            originalFileContents = fs.readFileSync(contract.storage_path);
            const initialFileSha256 = createHash('sha256').update(originalFileContents).digest('hex');
            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const analysis = parseAnalysisResult(contract);
            const changeOffsets = new Map();
            const replacements = suggestions.map((item) => {
                const originalText = item.originalText || item.original_text || item.original_clause;
                const suggestedText = item.suggestedText ?? item.suggested_text ?? item.modification;
                const previousSuggestion = Number.isInteger(Number(item.suggestionIndex))
                    ? analysis.modification_suggestions?.[Number(item.suggestionIndex)]
                    : null;
                const suggestionKey = Number.isInteger(Number(item.suggestionIndex))
                    ? Number(item.suggestionIndex)
                    : `unscoped-${changeOffsets.size}`;
                const implicitChangeIndex = changeOffsets.get(suggestionKey) || 0;
                changeOffsets.set(suggestionKey, implicitChangeIndex + 1);
                const changeIndex = Number(item.changeIndex ?? item.change_index ?? implicitChangeIndex);
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
                        previousRevisionGroup: previousRevisionGroupForChange(previousSuggestion, changeIndex),
                        previousApplicationStatus: previousSuggestion?.application_status,
                        existingRevisionText: item.existingRevisionText || item.existing_revision_text || '',
                        reviewBaseline: item.reviewBaseline || item.review_baseline || '',
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
                    const index = Number(item.suggestionIndex);
                    revisionGroups.set(index, [...(revisionGroups.get(index) || []), item.revisionGroup]);
                }
            }
            for (const index of appliedIndexes) {
                const suggestion = analysis.modification_suggestions?.[index];
                if (suggestion) {
                    markSupersededRevisionGroups(
                        analysis,
                        suggestion,
                        results.filter((item) => Number(item.suggestionIndex) === Number(index)),
                    );
                }
            }
            await updateContractAfterApply(contract, nextKey, analysis, appliedIndexes, mode, revisionGroups);
            commitComplete = true;
            return res.json({
                version, mode,
                applicationStatus: mode === 'review' ? 'pending_review' : 'applied',
                totalReplacements, succeededCount, failedCount, results,
                documentSha256: fileSha256(contract.storage_path),
                editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext, { reviewMode: mode === 'review' }),
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '批量替换失败。');
        } finally {
            await releaseWriteLock?.();
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
        let releaseWriteLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;

        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertEditPrecondition(contract, expectedDocumentKey, expectedSha256);
            const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
            if (ext !== 'docx') return res.status(400).json({ error: 'PDF 文件暂不支持追加条款。', code: 'PDF_APPEND_NOT_SUPPORTED' });
            if (mode === 'review') {
                return res.status(409).json({
                    error: '新增条款的审阅修订生命周期尚未开放，请切换为直接编辑或在 OnlyOffice 中人工新增。',
                    code: 'DOCX_APPEND_REVIEW_LIFECYCLE_UNSUPPORTED',
                });
            }

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
                    documentSha256: fileSha256(contract.storage_path),
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
                documentSha256: fileSha256(contract.storage_path),
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
            await releaseWriteLock?.();
        }
    });

    router.post('/:id/revisions/sync', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        let releaseWriteLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let commitComplete = false;
        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertCurrentDocumentKey(contract, req.body?.expectedDocumentKey);
            originalFileContents = fs.readFileSync(contract.storage_path);
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
                try {
                    const affected = await db('contracts')
                        .where({ id: contract.id, document_key: contract.document_key })
                        .update(update);
                    if (affected !== 1) {
                        const error = new Error('DOCUMENT_VERSION_STALE');
                        error.status = 409;
                        throw error;
                    }
                } catch (cause) {
                    if (update.oss_key) {
                        console.error('[Contract Storage Orphan] revision sync update failed after mirror', {
                            contractId: contract.id, ossKey: update.oss_key, cause: cause.message,
                        });
                        const error = new Error('DOCUMENT_COMMIT_ORPHAN_OSS');
                        error.status = 500;
                        error.cause = cause;
                        throw error;
                    }
                    throw cause;
                }
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
            commitComplete = true;
            return res.json({
                ok: true,
                changed: syncResult.changed,
                documentChanged: syncResult.documentChanged,
                revisions: syncResult.results,
                editorConfig,
            });
        } catch (error) {
            if (!commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, '同步审阅修订状态失败。');
        } finally {
            await releaseWriteLock?.();
        }
    });

    const resolveRevision = (resolution) => async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        let workingPath = '';
        let releaseWriteLock = null;
        let originalFileContents = null;
        let contractStoragePath = '';
        let documentReplaced = false;
        let commitComplete = false;
        try {
            let contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            releaseWriteLock = await acquireContractWriteLock(contract.id);
            contract = await findOwnedContract(req.params.id, userId);
            if (!contract) return res.status(404).json({ error: 'Contract not found.' });
            contractStoragePath = contract.storage_path;
            assertCurrentDocumentKey(contract, req.body?.expectedDocumentKey);
            originalFileContents = fs.readFileSync(contract.storage_path);
            const analysis = parseAnalysisResult(contract);
            const suggestionIndex = Number(req.params.suggestionIndex);
            const suggestion = analysis.modification_suggestions?.[suggestionIndex];
            const revisionGroups = Array.isArray(suggestion?.revision_groups) && suggestion.revision_groups.length
                ? suggestion.revision_groups
                : (suggestion?.revision_group ? [suggestion.revision_group] : []);
            if (!revisionGroups.length) throw new Error('REVISION_GROUP_NOT_FOUND');

            workingPath = tempDocxPath(contract.storage_path);
            fs.copyFileSync(contract.storage_path, workingPath);
            const groupResults = revisionGroups.map((group) => ({
                groupId: group.group_id,
                ...resolveRevisionGroupInDocx(workingPath, group, resolution),
            }));
            const result = {
                changed: groupResults.some((item) => item.changed),
                alreadyResolved: groupResults.every((item) => item.alreadyResolved),
                status: resolution === 'accept' ? 'accepted' : 'rejected',
            };
            let version = null;
            let nextKey = contract.document_key;
            if (result.changed) {
                version = await createContractVersionSnapshot(contract, `review-${resolution}-suggestion`);
                fs.renameSync(workingPath, contract.storage_path);
                workingPath = '';
                documentReplaced = true;
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
            try {
                const affected = await db('contracts')
                    .where({ id: contract.id, document_key: contract.document_key })
                    .update({
                    document_key: nextKey,
                    analysis_result: JSON.stringify(analysis),
                    oss_key: mirrored.oss_key,
                    oss_sha256: mirrored.sha256,
                    updated_at: db.fn.now(),
                    });
                if (affected !== 1) {
                    const error = new Error('DOCUMENT_VERSION_STALE');
                    error.status = 409;
                    throw error;
                }
            } catch (cause) {
                if (result.changed && mirrored.oss_key) {
                    console.error('[Contract Storage Orphan] revision resolution update failed after mirror', {
                        contractId: contract.id, ossKey: mirrored.oss_key, cause: cause.message,
                    });
                    const error = new Error('DOCUMENT_COMMIT_ORPHAN_OSS');
                    error.status = 500;
                    error.cause = cause;
                    throw error;
                }
                throw cause;
            }
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
            commitComplete = true;
            return res.json({
                ok: true,
                resolution,
                status: result.status,
                changed: result.changed,
                alreadyResolved: result.alreadyResolved,
                version,
                revisionGroup: suggestion.revision_group,
                revisionGroups: suggestion.revision_groups,
                groupResults,
                editorConfig,
            });
        } catch (error) {
            if (workingPath && fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
            if (documentReplaced && !commitComplete && originalFileContents && contractStoragePath) {
                restoreFileAtomically(contractStoragePath, originalFileContents);
            }
            return docxErrorResponse(res, error, resolution === 'accept'
                ? '接受审阅修订失败。'
                : '拒绝审阅修订失败。');
        } finally {
            await releaseWriteLock?.();
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
