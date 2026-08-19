// Review.vue 采纳/批量/导出/差异对比
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

export function useReviewActions(state, editor, helpers) {
    const {
        contract, reviewData, activeAiTab, adoptedHighlights,
        selectedSuggestionPreview, reviewApplyMode,
    } = state;
    const {
        executeEditorMethod, ensureEditorReady, findTextRangeByCandidates,
        buildSuggestionCandidates, buildReplacementCandidates, replaceTextInEditorFinal, previewSuggestion,
        appendClauseInEditorFinal, scheduleForceSave, forceSaveCurrentDocument,
        reloadEditorConfig, ensureReviewApplyMode,
    } = editor;
    const { suggestionOriginal, suggestionText, suggestionTitle, isMissingClauseSuggestion } = helpers;

    const batchApplying = ref(false);
    const diffItems = ref([]);
    const diffLoading = ref(false);
    const exportingDocument = ref(false);
    let lastStatusEditorKey = '';

    const addDocComment = async (text, comment, item = {}) => {
        if (!text) {
            ElMessage.info('AI 未返回可批注定位的原文，请手动添加批注。');
            return;
        }
        if (!ensureEditorReady()) return;
        try {
            const matched = await findTextRangeByCandidates(buildSuggestionCandidates(text, item));
            if (!matched?.range) {
                ElMessage.info('定位原文失败，无法添加批注。');
                return;
            }
            await executeEditorMethod('SelectRange', [matched.range]);
            const bookmark = `ai_review_${Date.now()}`;
            await executeEditorMethod('AddBookmark', [bookmark]).catch(() => null);
            await executeEditorMethod('AddComment', [comment || 'AI 审查建议', 'AI 审查专家']).catch(async () => {
                await executeEditorMethod('AddComment', [comment || 'AI 审查建议']);
            });
            scheduleForceSave(300);
        } catch (error) {
            ElMessage.error('添加批注失败：当前 OnlyOffice 未开放批注接口。');
        }
    };

    const normalizeSuggestionApplicationStatus = (value) => {
        const status = String(value || '').trim().toLowerCase().replace(/-/g, '_');
        if (['pending_review', 'review_pending', 'pending_confirmation'].includes(status)) return 'pending_review';
        if (['accepted', 'approved'].includes(status)) return 'accepted';
        if (['applied', 'effective', 'completed'].includes(status)) return 'applied';
        if (['rejected', 'declined'].includes(status)) return 'rejected';
        return 'unresolved';
    };

    const suggestionApplicationStatus = (item) => {
        const direct = normalizeSuggestionApplicationStatus(item?.application_status ?? item?.applicationStatus);
        if (direct !== 'unresolved') return direct;
        if (item?.rejected === true) return 'rejected';
        if (item?.review_pending === true) return 'pending_review';
        if (item?.adopted === true) return 'applied';
        return 'unresolved';
    };

    const isSuggestionPendingReview = (item) => suggestionApplicationStatus(item) === 'pending_review';
    const isSuggestionEffective = (item) => ['accepted', 'applied'].includes(suggestionApplicationStatus(item));
    // Retain the existing public helper name for batch filtering. "Applied"
    // here means no further insertion action is available: pending revisions
    // must first be accepted or rejected inside OnlyOffice.
    const isSuggestionApplied = (item) => isSuggestionPendingReview(item) || isSuggestionEffective(item);

    const syncEditorConfigFromStatus = (payload = {}) => {
        const suppliedConfig = payload.editorConfig || payload.editor_config;
        const nextEditorKey = payload.documentKey || payload.document_key || suppliedConfig?.document?.key;
        const currentEditorKey = contract.editorConfig?.document?.key;
        if (!nextEditorKey || nextEditorKey === currentEditorKey || nextEditorKey === lastStatusEditorKey) return;

        lastStatusEditorKey = nextEditorKey;
        const reload = (editorConfig) => {
            if (!editorConfig || editorConfig.document?.key !== nextEditorKey) {
                lastStatusEditorKey = '';
                return;
            }
            reloadEditorConfig(editorConfig, '正在同步审阅确认结果...').catch((error) => {
                lastStatusEditorKey = '';
                console.warn('[OnlyOffice] revision status reload failed', error);
                ElMessage.error('审阅确认结果已保存，但文档刷新失败，请手动刷新页面。');
            });
        };

        if (suppliedConfig) {
            reload(suppliedConfig);
            return;
        }
        api.getFreshEditorConfig(contract.id)
            .then((response) => reload(response.data?.editorConfig))
            .catch((error) => {
                lastStatusEditorKey = '';
                console.warn('[OnlyOffice] fresh editor config after status sync failed', error);
                ElMessage.error('审阅状态已同步，但未能刷新在线文档，请手动刷新页面。');
            });
    };

    const applySuggestionStatusPayload = (payload = {}) => {
        const entries = payload.suggestions || payload.statuses;
        if (Array.isArray(entries)) {
            entries.forEach((entry) => applySuggestionStatusPayload(entry));
            syncEditorConfigFromStatus(payload);
            return;
        }
        const suggestionIndex = Number(payload.suggestionIndex ?? payload.suggestion_index ?? payload.index);
        if (!Number.isInteger(suggestionIndex)) return;
        const item = reviewData.modification_suggestions?.[suggestionIndex];
        if (!item) return;
        const status = normalizeSuggestionApplicationStatus(
            payload.applicationStatus ?? payload.application_status
                ?? payload.revisionStatus ?? payload.revision_status ?? payload.status,
        );
        item.application_status = status;
        item.review_pending = status === 'pending_review';
        item.adopted = ['accepted', 'applied'].includes(status);
        item.rejected = status === 'rejected';
        if (payload.documentKey || payload.document_key) {
            item.applied_document_key = payload.documentKey || payload.document_key;
        }
        if (payload.updatedAt || payload.updated_at) {
            item.application_status_updated_at = payload.updatedAt || payload.updated_at;
        }
        syncEditorConfigFromStatus(payload);
    };

    const setSuggestionReviewDecision = async (item, suggestionIndex, decision) => {
        const status = decision === 'accepted' ? 'accepted' : (decision === 'rejected' ? 'rejected' : 'unresolved');
        try {
            const response = await api.updateSuggestionApplicationStatus(contract.id, suggestionIndex, status);
            applySuggestionStatusPayload({ suggestionIndex, status, ...(response.data || {}) });
            return true;
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '修订状态同步失败，请稍后重试。');
            return false;
        }
    };

    const applyResultToSuggestion = (item, originalText, suggestedText, result = {}) => {
        const responseStatus = normalizeSuggestionApplicationStatus(result.applicationStatus ?? result.application_status);
        const applicationStatus = responseStatus !== 'unresolved'
            ? responseStatus
            : (reviewApplyMode.value === 'review' ? 'pending_review' : 'applied');
        const pendingReview = applicationStatus === 'pending_review';
        item.application_status = applicationStatus;
        item.review_pending = pendingReview;
        item.adopted = ['accepted', 'applied'].includes(applicationStatus);
        item.rejected = false;
        const revisionGroup = result.revisionGroup || result.revision_group;
        if (revisionGroup) item.revision_group = revisionGroup;
        item.adopted_original = originalText || '合同未约定';
        adoptedHighlights.value[suggestionTitle(item, 0)] = originalText || suggestedText;
        if (!selectedSuggestionPreview.value) {
            selectedSuggestionPreview.value = { before: originalText || '合同未约定', after: suggestedText, status: '' };
        }
        selectedSuggestionPreview.value.status = pendingReview
            ? '已加入审阅修订，可在左侧接受或拒绝'
            : '已直接写入左侧文档';
        // Keep the primary contract workflow quiet. The persistent inline status
        // and the green risk marker already confirm success without covering the
        // editor with a toast after every accepted suggestion.
    };

    const adoptSuggestion = async (item, suggestionIndex) => {
        if (item?._applying || isSuggestionApplied(item)) return;
        const originalText = suggestionOriginal(item);
        const suggestedText = suggestionText(item);

        if (!suggestedText || (!originalText && !isMissingClauseSuggestion(item))) {
            ElMessage.warning('该建议缺少可写入合同的建议文本，请手动修改。');
            return;
        }

        item._applying = true;
        const markAdopted = (result = {}) => {
            applyResultToSuggestion(item, originalText, suggestedText, result);
            item._applying = false;
        };
        const markFailed = (status) => {
            selectedSuggestionPreview.value.status = status;
            item._applying = false;
        };

        if (isMissingClauseSuggestion(item)) {
            previewSuggestion(item, '正在新增条款');
            await appendClauseInEditorFinal(
                suggestionTitle(item, 0),
                suggestedText,
                markAdopted,
                markFailed,
                {
                    mode: reviewApplyMode.value,
                    suggestionIndex,
                    anchorHint: item.anchor_hint || item.anchorHint || '',
                    currentClause: originalText || '',
                    targetClauseNo: item.target_clause_no || item.targetClauseNo || '',
                    targetHeading: item.target_heading || item.targetHeading || item.parent_clause || item.target_section || item.section_title || '',
                    suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                },
            );
            return;
        }

        previewSuggestion(item, '正在采纳');
        await replaceTextInEditorFinal(originalText, suggestedText, markAdopted, markFailed, item, {
            mode: reviewApplyMode.value,
            suggestionIndex,
            suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
        });
    };

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const applyAllSuggestions = async () => {
        const indexes = (reviewData.modification_suggestions || []).map((_, index) => index);
        const pendingItems = indexes.map((index) => ({
            index,
            item: reviewData.modification_suggestions[index],
        })).filter(({ item }) => item && !isSuggestionApplied(item));
        if (!pendingItems.length) {
            ElMessage.info('全部风险建议均已处理。');
            return;
        }
        batchApplying.value = true;
        try {
            if (!await ensureReviewApplyMode()) return;
            const appendItems = pendingItems.filter(({ item }) => isMissingClauseSuggestion(item));
            const replacementItems = pendingItems.filter(({ item }) => !isMissingClauseSuggestion(item));
            let succeededCount = 0;
            let failedCount = 0;
            let totalReplacements = 0;
            let latestEditorConfig = null;
            let latestDocumentKey = contract.editorConfig?.document?.key;
            let restoreTarget = null;

            // Serialize the whole batch behind one editor save. Re-saving the
            // stale browser session after the server has already produced a new
            // DOCX version can overwrite accepted revisions.
            if (pendingItems.length) {
                await forceSaveCurrentDocument(true);
                await new Promise((resolve) => setTimeout(resolve, 650));
            }

            if (replacementItems.length) {
                const suggestions = replacementItems.map(({ item, index }) => ({
                    suggestionIndex: index,
                    suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                    title: suggestionTitle(item, 0),
                    originalText: suggestionOriginal(item),
                    suggestedText: suggestionText(item),
                    originalCandidates: buildReplacementCandidates(suggestionOriginal(item), item),
                }));
                const response = await api.batchReplaceContractText(contract.id, {
                    suggestions,
                    mode: reviewApplyMode.value,
                    expectedDocumentKey: latestDocumentKey,
                });
                latestEditorConfig = response.data.editorConfig;
                latestDocumentKey = response.data.editorConfig?.document?.key || latestDocumentKey;
                totalReplacements += response.data.totalReplacements || 0;
                succeededCount += response.data.succeededCount || 0;
                failedCount += response.data.failedCount || 0;
                (response.data.results || []).forEach((result) => {
                    if (result.ok) {
                        const target = replacementItems[result.index].item;
                        if (!restoreTarget) {
                            restoreTarget = { text: result.replacementText || suggestionText(target) };
                        }
                        applyResultToSuggestion(target, suggestionOriginal(target), suggestionText(target), {
                            ...result,
                            applicationStatus: response.data.applicationStatus || response.data.application_status,
                        });
                    }
                });
            }

            for (const { item, index } of appendItems) {
                try {
                    const response = await api.appendContractClause(contract.id, {
                        title: suggestionTitle(item, 0),
                        content: suggestionText(item),
                        mode: reviewApplyMode.value,
                        suggestionIndex: index,
                        suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                        anchorHint: item.anchor_hint || item.anchorHint || '',
                        currentClause: suggestionOriginal(item) || '',
                        targetClauseNo: item.target_clause_no || item.targetClauseNo || '',
                        targetHeading: item.target_heading || item.targetHeading || item.parent_clause || item.target_section || item.section_title || '',
                        expectedDocumentKey: latestDocumentKey,
                    });
                    latestEditorConfig = response.data.editorConfig || latestEditorConfig;
                    latestDocumentKey = response.data.editorConfig?.document?.key || latestDocumentKey;
                    if (!restoreTarget) {
                        restoreTarget = { text: response.data.insertedText || suggestionText(item) };
                    }
                    applyResultToSuggestion(item, suggestionOriginal(item), suggestionText(item), response.data);
                    succeededCount += 1;
                } catch {
                    failedCount += 1;
                }
            }

            selectedSuggestionPreview.value = {
                before: '一键处理全部未处理风险建议',
                after: `成功 ${succeededCount} 项${totalReplacements ? `，替换 ${totalReplacements} 处` : ''}${failedCount ? `，失败 ${failedCount} 项` : ''}`,
                status: reviewApplyMode.value === 'review' ? '已加入审阅修订' : '已直接写入合同',
            };
            if (latestEditorConfig) {
                await reloadEditorConfig(latestEditorConfig, undefined, restoreTarget);
            }
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '批量采纳失败。');
        } finally {
            batchApplying.value = false;
        }
    };

    const loadLatestDiff = async () => {
        if (!contract.id) return;
        diffLoading.value = true;
        try {
            const response = await api.getContractDiff(contract.id);
            diffItems.value = response.data.diff || [];
            activeAiTab.value = 'workspace';
        } catch (error) {
            ElMessage.info(error.response?.data?.error || '暂无可对比的合同版本。');
        } finally {
            diffLoading.value = false;
        }
    };

    const exportReport = async (format = 'html') => {
        try {
            const response = await api.exportReviewReport(contract.id, format);
            downloadBlob(response.data, `合同审查报告.${format === 'word' ? 'doc' : format}`);
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出审查报告失败。');
        }
    };

    const downloadPdfAnnotations = async () => {
        try {
            const response = await api.downloadPdfAnnotations(contract.id);
            downloadBlob(response.data, 'PDF批注意见.txt');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出 PDF 批注意见失败。');
        }
    };

    const exportedFilename = (response, fallback) => {
        const disposition = String(response?.headers?.['content-disposition'] || '');
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        if (encoded) {
            try { return decodeURIComponent(encoded); } catch { /* use fallback */ }
        }
        const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
        return quoted || fallback;
    };

    const exportContractDocument = async (command = 'review-docx') => {
        if (exportingDocument.value) return;
        const [variant, format] = String(command).split('-');
        if (!['review', 'final'].includes(variant) || !['docx', 'pdf'].includes(format)) return;
        exportingDocument.value = true;
        try {
            const response = await api.exportContractDocument(contract.id, variant, format);
            const originalName = String(contract.original_filename || '合同').replace(/\.[^.]+$/, '');
            const variantLabel = variant === 'review' ? '审阅版' : '最终版';
            downloadBlob(response.data, exportedFilename(response, `${originalName}-${variantLabel}.${format}`));
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出合同文件失败。');
        } finally {
            exportingDocument.value = false;
        }
    };

    return {
        batchApplying, diffItems, diffLoading, exportingDocument,
        addDocComment, adoptSuggestion, isSuggestionApplied, isSuggestionPendingReview, isSuggestionEffective,
        normalizeSuggestionApplicationStatus, suggestionApplicationStatus,
        applySuggestionStatusPayload, setSuggestionReviewDecision, downloadBlob,
        applyAllSuggestions, loadLatestDiff, exportReport, downloadPdfAnnotations, exportContractDocument,
    };
}
