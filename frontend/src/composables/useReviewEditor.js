// Review.vue OnlyOffice 编辑器操作：搜索/替换/高亮/保存
import { nextTick, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

export function useReviewEditor(state, helpers) {
    const {
        contract, isEditorReady, selectedSuggestionPreview, docEditorComponent,
        editorReloading, editorReloadMessage, reviewApplyMode,
    } = state;
    const { suggestionOriginal, suggestionText } = helpers;

    const forceSaveTimer = ref(null);
    const forceSaveDebounceTimer = ref(null);
    const forceSaveInFlight = ref(false);
    const hasPendingEditorChanges = ref(false);
    const editorModeSyncing = ref(false);
    const editorTrackRevisionsActive = ref(null);
    const editorModeSyncError = ref('');
    let editorReloadWaiter = null;
    let documentMutationQueue = Promise.resolve();
    let editorModeSyncQueue = Promise.resolve();
    let trackRevisionsCallbackEditor = null;

    const getEditor = () => window?.DocEditor?.instances?.docEditorComponent || null;

    // ONLYOFFICE Community does not expose the paid Automation API connector on
    // the host DocEditor instance. The editor is proxied on the same origin in
    // this POC, so the document frame's plugin-compatible methods are available
    // as a fallback for search, comments, selected text and format-safe replace.
    const getCommunityEditor = () => {
        try {
            const frameWindow = document.querySelector('iframe[name="frameEditor"]')?.contentWindow;
            return frameWindow?.editor || frameWindow?.Asc?.editor || null;
        } catch {
            return null;
        }
    };

    const getEditorFrameWindow = () => {
        try {
            return document.querySelector('iframe[name="frameEditor"]')?.contentWindow || null;
        } catch {
            return null;
        }
    };

    // The DocsAPI host wrapper does not expose the current Track Changes flag.
    // The same-origin Community editor does expose the documented SDKJS review
    // methods; read the effective flag after every write so the page switch can
    // never claim "审阅修订" while the editor is actually performing direct edits.
    const readEditorTrackRevisions = () => {
        const editor = getCommunityEditor();
        if (!editor) return null;
        if (typeof editor.asc_IsTrackRevisions === 'function') {
            return Boolean(editor.asc_IsTrackRevisions());
        }
        const logicDocument = editor.WordControl?.m_oLogicDocument;
        if (typeof logicDocument?.IsTrackRevisions === 'function') {
            return Boolean(logicDocument.IsTrackRevisions());
        }
        return null;
    };

    const reflectEditorTrackRevisions = (actual) => {
        if (typeof actual !== 'boolean') return;
        editorTrackRevisionsActive.value = actual;
        if (!editorModeSyncing.value) {
            reviewApplyMode.value = actual ? 'review' : 'edit';
        }
    };

    const writeEditorTrackRevisions = (enabled) => {
        const editor = getCommunityEditor();
        if (!editor) throw new Error('EDITOR_NOT_READY');
        let handled = false;

        // Keep both the document-wide and this session's local flag aligned.
        // This matters for files that already contain w:trackRevisions: merely
        // switching the local flag off would still leave direct edit disabled.
        if (typeof editor.asc_SetGlobalTrackRevisions === 'function') {
            editor.asc_SetGlobalTrackRevisions(Boolean(enabled));
            handled = true;
        }
        if (typeof editor.asc_SetLocalTrackRevisions === 'function') {
            editor.asc_SetLocalTrackRevisions(Boolean(enabled));
            handled = true;
        } else if (typeof editor.asc_SetTrackRevisions === 'function') {
            editor.asc_SetTrackRevisions(Boolean(enabled));
            handled = true;
        }

        if (!handled) {
            const frameWindow = getEditorFrameWindow();
            const notificationCenter = frameWindow?.Common?.NotificationCenter;
            if (typeof notificationCenter?.trigger === 'function') {
                notificationCenter.trigger('reviewchanges:turn', enabled ? 'on' : 'off');
                handled = true;
            }
        }
        if (!handled) throw new Error('EDITOR_TRACK_REVISIONS_UNAVAILABLE');
    };

    const syncEditorTrackRevisions = (mode = reviewApplyMode.value, options = {}) => {
        const desiredMode = mode === 'edit' ? 'edit' : 'review';
        const desired = desiredMode === 'review';
        const run = editorModeSyncQueue.then(async () => {
            editorModeSyncing.value = true;
            editorModeSyncError.value = '';
            try {
                if (!getCommunityEditor()) throw new Error('EDITOR_NOT_READY');
                writeEditorTrackRevisions(desired);
                await new Promise((resolve) => setTimeout(resolve, 120));
                const actual = readEditorTrackRevisions();
                editorTrackRevisionsActive.value = actual;
                if (actual !== desired) {
                    const error = new Error('EDITOR_TRACK_REVISIONS_MISMATCH');
                    error.desiredMode = desiredMode;
                    error.actualMode = actual === true ? 'review' : (actual === false ? 'edit' : 'unknown');
                    throw error;
                }
                reviewApplyMode.value = desiredMode;
                return true;
            } catch (error) {
                const actual = readEditorTrackRevisions();
                // A failed verification must never leave the page switch
                // claiming a mode different from the editor's effective mode.
                if (typeof actual === 'boolean') {
                    editorTrackRevisionsActive.value = actual;
                    reviewApplyMode.value = actual ? 'review' : 'edit';
                }
                editorModeSyncError.value = error.message;
                if (options.notify !== false) {
                    ElMessage.error('未能同步在线文档的修订模式，请等待文档加载完成后重试。');
                }
                throw error;
            } finally {
                editorModeSyncing.value = false;
            }
        });
        editorModeSyncQueue = run.catch(() => undefined);
        return run;
    };

    const ensureReviewApplyMode = async (options = {}) => {
        try {
            await syncEditorTrackRevisions(reviewApplyMode.value, options);
            return true;
        } catch {
            return false;
        }
    };

    const setReviewApplyMode = async (mode) => {
        if (!['review', 'edit'].includes(mode) || editorModeSyncing.value) return false;
        if (!isEditorReady.value) {
            ElMessage.error('在线文档尚未加载完成，暂时无法切换修订模式。');
            return false;
        }
        try {
            return await syncEditorTrackRevisions(mode);
        } catch {
            return false;
        }
    };

    const bindTrackRevisionsState = () => {
        const editor = getCommunityEditor();
        if (!editor || trackRevisionsCallbackEditor === editor) return;
        trackRevisionsCallbackEditor = editor;
        if (typeof editor.asc_registerCallback === 'function') {
            editor.asc_registerCallback('asc_onOnTrackRevisionsChange', (localFlag, globalFlag) => {
                const actual = Boolean(localFlag || globalFlag);
                reflectEditorTrackRevisions(actual);
            });
        }
        reflectEditorTrackRevisions(readEditorTrackRevisions());
    };

    const executeCommunityEditorMethod = (method, args = []) => {
        const editor = getCommunityEditor();
        if (!editor) throw new Error('EDITOR_NOT_READY');

        if (method === 'Search' && typeof editor.pluginMethod_SearchNext === 'function') {
            const text = String(args[0] || '').trim();
            if (!text) return [];
            const found = editor.pluginMethod_SearchNext({ searchString: text, matchCase: false }, true);
            return found ? [{ __communitySelection: true, text }] : [];
        }

        if (method === 'SelectRange' && args[0]?.__communitySelection) {
            // SearchNext already selects and scrolls the matching text.
            return true;
        }

        if (method === 'GetSelectedText' && typeof editor.pluginMethod_GetSelectedText === 'function') {
            return editor.pluginMethod_GetSelectedText({ Numbering: true, ParaSeparator: '\n' });
        }

        if (method === 'AddComment' && typeof editor.pluginMethod_AddComment === 'function') {
            const commentText = String(args[0] || 'AI 审查建议');
            const author = String(args[1] || 'AI 审查专家');
            return editor.pluginMethod_AddComment({
                Text: commentText,
                UserName: author,
                Time: String(Date.now()),
                Solved: false,
            });
        }

        if ((method === 'PasteText' || method === 'ReplaceText')
            && typeof editor.pluginMethod_ReplaceTextSmart === 'function') {
            const replacement = String(method === 'ReplaceText' ? args[1] : args[0] || '');
            const result = editor.pluginMethod_ReplaceTextSmart(
                replacement.split(/\r?\n/),
                '\t',
                '\r\n',
            );
            if (result === false) throw new Error('EDITOR_SMART_REPLACE_FAILED');
            return new Promise((resolve) => setTimeout(() => resolve(result), 450));
        }

        throw new Error(`EDITOR_METHOD_UNAVAILABLE:${method}`);
    };

    const executeEditorMethod = (method, args = []) => {
        const editor = getEditor();
        if (!editor || typeof editor.executeMethod !== 'function') {
            try {
                return Promise.resolve(executeCommunityEditorMethod(method, args));
            } catch (error) {
                return Promise.reject(error);
            }
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve(null);
            }, 2500);
            try {
                editor.executeMethod(method, args, (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(result);
                });
            } catch (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
    };

    const findTextRange = async (text) => {
        const result = await executeEditorMethod('Search', [text]);
        if (Array.isArray(result) && result.length > 0) return result[0];
        return null;
    };

    const normalizeCandidate = (text) => String(text || '')
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/\s+/g, '')
        .trim();

    const splitCandidateSentences = (text) => String(text || '')
        .split(/(?<=[。！？；;.!?])|\n+/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 6);

    const clauseBodyCandidate = (text) => {
        const match = String(text || '').trim().match(/^\d+(?:\.\d+)+\s*(.+)$/s);
        return match?.[1]?.trim() || '';
    };

    const buildSuggestionCandidates = (originalText, item = {}) => {
        const candidates = [
            originalText,
            item.anchor_hint,
            item.original_clause,
            item.clause,
            clauseBodyCandidate(originalText),
            ...splitCandidateSentences(originalText),
        ];
        const compact = normalizeCandidate(originalText);
        if (compact && compact !== originalText) candidates.push(compact);
        if (originalText && originalText.length > 80) {
            candidates.push(originalText.slice(0, 80));
            candidates.push(originalText.slice(-80));
        }
        const seen = new Set();
        return candidates
            .map((candidate) => String(candidate || '').trim())
            .filter((candidate) => candidate.length >= 4)
            .filter((candidate) => {
                const key = normalizeCandidate(candidate);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };

    const buildReplacementCandidates = (originalText, item = {}) => {
        const candidates = [
            originalText,
            item.original_text,
            item.original_clause,
            item.current_clause,
            item.contract_clause,
            clauseBodyCandidate(originalText),
        ];
        const seen = new Set();
        return candidates
            .map((candidate) => String(candidate || '').trim())
            .filter((candidate) => normalizeCandidate(candidate).length >= 8)
            .filter((candidate) => {
                const key = normalizeCandidate(candidate);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };

    const findTextRangeByCandidates = async (candidates) => {
        for (const candidate of candidates) {
            const range = await findTextRange(candidate);
            if (range) return { range, matchedText: candidate };
        }
        return null;
    };

    const ensureEditorReady = () => {
        if (!getEditor() && !getCommunityEditor()) {
            ElMessage.warning('编辑器尚未就绪，请等待左侧文档加载完成。');
            return false;
        }
        return true;
    };

    const previewSuggestion = (item, status = '待采纳') => {
        item._showPreview = status === '待采纳' ? !item._showPreview : true;
        if (!item._showPreview) return;
        selectedSuggestionPreview.value = {
            before: suggestionOriginal(item) || 'AI 未返回可直接定位的原文。',
            after: suggestionText(item) || 'AI 未返回建议替换文本。',
            status,
        };
    };

    const locateText = async (text, item = {}) => {
        if (!text) {
            ElMessage.info('AI 未返回可定位的原文，请在文档中手动核对该建议。');
            return;
        }
        if (!ensureEditorReady()) return;
        try {
            const matched = await findTextRangeByCandidates(buildSuggestionCandidates(text, item));
            if (!matched?.range) {
                ElMessage.info('未在文档中找到对应条款原文。');
                return;
            }
            await executeEditorMethod('SelectRange', [matched.range]);
        } catch (error) {
            ElMessage.error('文档定位失败，请检查 OnlyOffice 是否已完全加载。');
        }
    };

    const replaceTextOnServer = async (originalText, suggestedText, item = {}, options = {}) => {
        const response = await api.replaceContractText(contract.id, {
            originalText,
            suggestedText,
            originalCandidates: buildReplacementCandidates(originalText, item),
            mode: options.mode === 'review' ? 'review' : 'edit',
            suggestionIndex: options.suggestionIndex,
            suggestionId: options.suggestionId || item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
            expectedDocumentKey: contract.editorConfig?.document?.key,
        });
        return response.data;
    };

    const markAdoptedText = async (originalText, suggestedText) => {
        try {
            const replacement = await findTextRangeByCandidates([suggestedText, suggestedText.slice(0, 80), suggestedText.slice(-80)]);
            if (!replacement?.range) return;
            await executeEditorMethod('SelectRange', [replacement.range]);
            const highlightMethods = [
                ['SetHighlightColor', ['#FFF2A8']],
                ['SetTextHighlightColor', ['#FFF2A8']],
                ['SetHighlight', ['#FFF2A8']],
            ];
            for (const [method, args] of highlightMethods) {
                try {
                    await executeEditorMethod(method, args);
                    break;
                } catch {
                    // Try the next OnlyOffice build-specific method name.
                }
            }
            await executeEditorMethod('AddComment', [`采纳前原文：${originalText}`, 'AI 审查']).catch(() => null);
        } catch {
            // Highlight/comment support depends on the deployed OnlyOffice build.
        }
    };

    const replaceTextInEditor = async (originalText, suggestedText, onSuccess, onFailure, item = {}) => {
        const runServerFallback = async (statusPrefix = 'OnlyOffice 未开放当前编辑方法，已更新源文件') => {
            try {
                const replacements = await replaceTextOnServer(originalText, suggestedText, item);
                onSuccess?.({ fallback: true, replacements });
            } catch (serverError) {
                const message = serverError.response?.data?.error || '服务器替换失败，请缩短原文片段后重试。';
                ElMessage.error(message);
                onFailure?.(message);
            }
        };

        if (!ensureEditorReady()) {
            onFailure?.('编辑器尚未就绪，请稍候');
            return;
        }
        try {
            const matched = await findTextRangeByCandidates(buildReplacementCandidates(originalText, item));
            if (!matched?.range) {
                await runServerFallback('编辑器未匹配到原文，已尝试从 DOCX 源文件替换');
                return;
            }
            await executeEditorMethod('SelectRange', [matched.range]);
            try {
                await executeEditorMethod('PasteText', [suggestedText]);
            } catch {
                await executeEditorMethod('ReplaceText', [matched.range, suggestedText]);
            }
            await markAdoptedText(originalText, suggestedText);
            onSuccess?.();
        } catch (error) {
            await runServerFallback();
        }
    };

    const settleEditorReload = (error = null) => {
        if (!editorReloadWaiter) return;
        const waiter = editorReloadWaiter;
        editorReloadWaiter = null;
        clearTimeout(waiter.timer);
        if (error) waiter.reject(error);
        else waiter.resolve(true);
    };

    const reloadEditorConfig = async (nextConfig, message = '正在重新载入修订后的合同...') => {
        if (!nextConfig) return false;
        editorReloading.value = true;
        editorReloadMessage.value = message;
        isEditorReady.value = false;
        hasPendingEditorChanges.value = false;
        stopAutoForceSave();

        settleEditorReload(new Error('EDITOR_RELOAD_SUPERSEDED'));
        const ready = new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                if (editorReloadWaiter?.timer !== timer) return;
                editorReloadWaiter = null;
                reject(new Error('EDITOR_RELOAD_TIMEOUT'));
            }, 30000);
            editorReloadWaiter = { resolve, reject, timer };
        });

        // The isolated editor component owns all DOM below its stable Vue host.
        // Replacing the config therefore rebuilds only the OnlyOffice instance
        // and keeps the review page, filters, scroll and history state intact.
        contract.editorConfig = JSON.parse(JSON.stringify(nextConfig));
        await nextTick();
        return ready;
    };

    const runDocumentMutation = (task) => {
        const run = documentMutationQueue.then(task, task);
        documentMutationQueue = run.catch(() => undefined);
        return run;
    };

    const refreshEditorDocument = async () => {
        try {
            const res = await api.getFreshEditorConfig(contract.id);
            return await reloadEditorConfig(res.data?.editorConfig);
        } catch (error) {
            console.warn('[OnlyOffice] refresh editor failed', error);
            return false;
        }
    };

    const serverFallback = async (originalText, suggestedText, onSuccess, onFailure, item = {}) => {
        try {
            const replacements = await replaceTextOnServer(originalText, suggestedText, item);
            const refreshed = await refreshEditorDocument();
            if (refreshed) {
                onSuccess?.({ fallback: true, refreshed: true, replacements });
            } else {
                onSuccess?.({ fallback: true, replacements });
            }
        } catch (err) {
            const msg = err.response?.data?.error || '替换失败';
            ElMessage.error(msg);
            onFailure?.(msg);
        }
    };

    const replaceTextInEditorFinal = (originalText, suggestedText, onSuccess, onFailure, item = {}, options = {}) => runDocumentMutation(async () => {
        try {
            if (!await ensureReviewApplyMode()) return onFailure?.('编辑器修订模式未同步');
            await forceSaveCurrentDocument(true);
            await new Promise((resolve) => setTimeout(resolve, 650));
            const result = await replaceTextOnServer(originalText, suggestedText, item, options);
            await reloadEditorConfig(result.editorConfig);
            onSuccess?.(result);
        } catch (error) {
            const message = error.message === 'EDITOR_RELOAD_TIMEOUT'
                ? '修订已写入，但在线文档重新加载超时，请刷新页面查看。'
                : (error.message === 'EDITOR_TRACK_REVISIONS_MISMATCH'
                    ? '修订已写入，但编辑器模式校验失败，请刷新页面确认。'
                    : (error.response?.data?.error || '替换失败，文档未发生变化。'));
            ElMessage.error(message);
            onFailure?.(message);
        }
    });

    const appendClauseInEditorFinal = (title, content, onSuccess, onFailure, options = {}) => runDocumentMutation(async () => {
        try {
            if (!await ensureReviewApplyMode()) return onFailure?.('编辑器修订模式未同步');
            await forceSaveCurrentDocument(true);
            await new Promise((resolve) => setTimeout(resolve, 650));
            const response = await api.appendContractClause(contract.id, {
                title,
                content,
                mode: options.mode === 'review' ? 'review' : 'edit',
                suggestionIndex: options.suggestionIndex,
                suggestionId: options.suggestionId || '',
                anchorHint: options.anchorHint || '',
                currentClause: options.currentClause || '',
                targetClauseNo: options.targetClauseNo || '',
                targetHeading: options.targetHeading || '',
                expectedDocumentKey: contract.editorConfig?.document?.key,
            });
            await reloadEditorConfig(response.data?.editorConfig);
            onSuccess?.({ appended: true, ...response.data });
        } catch (err) {
            const msg = err.response?.data?.error || '新增条款失败。';
            ElMessage.error(msg);
            onFailure?.(msg);
        }
    });

    // --- Force save ---
    const forceSaveCurrentDocument = async (silent = true) => {
        if (!contract.id || forceSaveInFlight.value) return false;
        forceSaveInFlight.value = true;
        try {
            const editor = getEditor();
            if (typeof editor?.serviceCommand === 'function') {
                editor.serviceCommand('forcesave', {});
            }
            await api.forceSaveContract(contract.id, {
                documentKey: contract.editorConfig?.document?.key,
            });
            hasPendingEditorChanges.value = false;
            return true;
        } catch (error) {
            console.warn('[OnlyOffice] force-save failed', error.response?.data || error.message);
            if (!silent) ElMessage.warning(error.response?.data?.error || '触发文档保存同步失败');
            return false;
        } finally {
            forceSaveInFlight.value = false;
        }
    };

    const scheduleForceSave = (delay = 1200) => {
        if (!contract.id) return;
        if (forceSaveDebounceTimer.value) {
            clearTimeout(forceSaveDebounceTimer.value);
        }
        forceSaveDebounceTimer.value = setTimeout(() => {
            forceSaveDebounceTimer.value = null;
            forceSaveCurrentDocument(true);
        }, delay);
    };

    const stopAutoForceSave = () => {
        if (forceSaveTimer.value) {
            clearInterval(forceSaveTimer.value);
            forceSaveTimer.value = null;
        }
        if (forceSaveDebounceTimer.value) {
            clearTimeout(forceSaveDebounceTimer.value);
            forceSaveDebounceTimer.value = null;
        }
    };

    const startAutoForceSave = () => {
        stopAutoForceSave();
        forceSaveTimer.value = setInterval(() => {
            if (hasPendingEditorChanges.value) {
                forceSaveCurrentDocument(true);
            }
        }, 30000);
    };

    const onDocumentStateChange = (event) => {
        const changed = typeof event === 'boolean' ? event : Boolean(event?.data);
        hasPendingEditorChanges.value = changed;
        if (changed) {
            scheduleForceSave();
        }
    };

    const onDocumentReady = () => {
        console.log("[INFO] OnlyOffice document is ready.");
        setTimeout(async () => {
            isEditorReady.value = Boolean(getEditor() || getCommunityEditor());
            if (isEditorReady.value) {
                const desiredMode = reviewApplyMode.value;
                bindTrackRevisionsState();
                try {
                    await syncEditorTrackRevisions(desiredMode, { notify: false });
                    editorReloading.value = false;
                    startAutoForceSave();
                    settleEditorReload();
                } catch (error) {
                    editorReloading.value = false;
                    settleEditorReload(error);
                    ElMessage.error('在线文档已载入，但修订模式校验失败，请重新切换后再处理建议。');
                }
            }
        }, 300);
    };

    const onEditorError = (event) => {
        editorReloading.value = false;
        isEditorReady.value = false;
        settleEditorReload(new Error(event?.data?.errorDescription || 'EDITOR_RELOAD_FAILED'));
        console.error('[OnlyOffice] editor error', event?.data || event);
        ElMessage.error('在线文档加载失败，请刷新后重试。');
    };

    return {
        forceSaveTimer, forceSaveDebounceTimer, forceSaveInFlight, hasPendingEditorChanges,
        editorModeSyncing, editorTrackRevisionsActive, editorModeSyncError,
        getEditor, getCommunityEditor, executeEditorMethod, findTextRange, normalizeCandidate,
        splitCandidateSentences, clauseBodyCandidate, buildSuggestionCandidates, buildReplacementCandidates, findTextRangeByCandidates,
        ensureEditorReady, previewSuggestion, locateText, replaceTextOnServer,
        markAdoptedText, replaceTextInEditor, reloadEditorConfig, refreshEditorDocument, serverFallback,
        runDocumentMutation,
        replaceTextInEditorFinal, appendClauseInEditorFinal,
        forceSaveCurrentDocument, scheduleForceSave, stopAutoForceSave, startAutoForceSave,
        readEditorTrackRevisions, syncEditorTrackRevisions, ensureReviewApplyMode, setReviewApplyMode,
        onDocumentStateChange, onDocumentReady, onEditorError,
    };
}
