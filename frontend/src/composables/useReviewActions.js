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
        reloadEditorConfig, ensureReviewApplyMode, replaceTextOnServer,
    } = editor;
    const { suggestionOriginal, suggestionText, suggestionTitle, isMissingClauseSuggestion } = helpers;

    const batchApplying = ref(false);
    const diffItems = ref([]);
    const diffLoading = ref(false);
    const exportingDocument = ref(false);
    const batchPreflightLoading = ref(false);
    const batchPreflightResults = ref([]);
    let lastStatusEditorKey = '';

    const PREFLIGHT_STATUS = Object.freeze({
        SAFE_NEW: 'safe_new',
        SAFE_SUPERSEDE: 'safe_supersede',
        SAFE_COMPOSITE: 'safe_composite',
        NEEDS_NEW_ROUND: 'needs_new_round',
        HUMAN_CONFLICT: 'human_conflict',
        UNSUPPORTED: 'unsupported',
        FAILED: 'preflight_failed',
    });
    const PREFLIGHT_SAFE = new Set([
        PREFLIGHT_STATUS.SAFE_NEW,
        PREFLIGHT_STATUS.SAFE_SUPERSEDE,
        PREFLIGHT_STATUS.SAFE_COMPOSITE,
    ]);
    const preflightStatusLabel = (status) => ({
        safe_new: '可安全新增修订',
        safe_supersede: '可更新本轮建议',
        safe_composite: '可基于已有修订继续审阅',
        needs_new_round: '需建立下一轮修订',
        human_conflict: '存在人工或对方修订冲突',
        unsupported: '当前文档结构不支持自动修订',
        preflight_failed: '修订预检失败',
    }[status] || '修订状态未知');
    const preflightDefaultMessage = (status) => ({
        safe_new: '已确认目标条款可安全生成新的审阅修订。',
        safe_supersede: '已识别本轮系统修订，将以最新建议更新，原历史仍保留。',
        safe_composite: '已同时识别修订前原文和已有修订意见，将作为一个整体生成最新审阅修订。',
        needs_new_round: '该条款已进入上一轮或对方回稿，请先建立新的谈判轮次。',
        human_conflict: '目标与人工或对方待审修订重叠，请在左侧文档确认后再处理。',
        unsupported: '目标包含跨段、复杂域或无法唯一定位的结构，本次不会改动合同。',
        preflight_failed: '无法确认本次写入是否安全，已停止修订，请稍后重试。',
    }[status] || '本次修订已停止。');
    const normalizePreflightStatus = (value) => {
        const status = String(value || '').trim().toLowerCase().replace(/-/g, '_');
        if (['safe', 'new', 'safe_to_apply'].includes(status)) return PREFLIGHT_STATUS.SAFE_NEW;
        if (['supersede', 'safe_update', 'same_round'].includes(status)) return PREFLIGHT_STATUS.SAFE_SUPERSEDE;
        if (['composite', 'review_pair', 'existing_revision_pair'].includes(status)) return PREFLIGHT_STATUS.SAFE_COMPOSITE;
        if (['new_round', 'next_round'].includes(status)) return PREFLIGHT_STATUS.NEEDS_NEW_ROUND;
        if (['conflict', 'manual_conflict', 'counterparty_conflict'].includes(status)) return PREFLIGHT_STATUS.HUMAN_CONFLICT;
        if (['not_supported', 'blocked', 'ambiguous'].includes(status)) return PREFLIGHT_STATUS.UNSUPPORTED;
        return Object.values(PREFLIGHT_STATUS).includes(status) ? status : PREFLIGHT_STATUS.UNSUPPORTED;
    };
    const isRevisionPreflightSafe = (result) => PREFLIGHT_SAFE.has(
        normalizePreflightStatus(typeof result === 'string' ? result : result?.status),
    );

    const revisionPreflightEntries = (item, suggestionIndex) => {
        const linked = Array.isArray(item?.linked_changes)
            ? item.linked_changes.filter((change) => (change?.operation === 'append' || change?.current_clause || change?.original_text)
                && change?.suggested_text)
            : [];
        const changes = linked.length ? linked : [item];
        return changes.map((change, changeIndex) => {
            const operation = change?.operation === 'append' || (changes.length === 1 && isMissingClauseSuggestion(item))
                ? 'append'
                : 'replace';
            const originalText = change?.current_clause || change?.original_text || suggestionOriginal(item) || '';
            const suggestedText = change?.suggested_text || suggestionText(item) || '';
            return {
                suggestionIndex,
                changeIndex,
                operation,
                suggestionId: item?.revision_group?.suggestion_id || item?.suggestion_id || item?.id || '',
                revisionGroup: item?.revision_group || undefined,
                title: suggestionTitle(item, suggestionIndex),
                originalText,
                suggestedText,
                originalCandidates: operation === 'replace'
                    ? buildReplacementCandidates(originalText, change || item)
                    : [],
                existingRevisionText: change?.existing_revision_text || change?.existingRevisionText
                    || item?.existing_revision_text || item?.existingRevisionText || '',
                reviewBaseline: change?.review_baseline || change?.reviewBaseline
                    || item?.review_baseline || item?.reviewBaseline || '',
                anchorHint: change?.anchor_hint || change?.anchorHint || item?.anchor_hint || item?.anchorHint || '',
                targetClauseNo: change?.target_clause_no || change?.targetClauseNo || item?.target_clause_no || item?.targetClauseNo || '',
                targetHeading: change?.target_heading || change?.targetHeading || item?.target_heading || item?.targetHeading
                    || item?.parent_clause || item?.target_section || item?.section_title || '',
            };
        });
    };

    const normalizePreflightResults = (responseData, entries) => {
        const rawResults = Array.isArray(responseData?.results)
            ? responseData.results
            : (Array.isArray(responseData?.items) ? responseData.items : []);
        return rawResults.map((result, resultIndex) => {
            const requestIndex = Number(result.requestIndex ?? result.request_index ?? result.index ?? resultIndex);
            const entry = entries[Number.isInteger(requestIndex) ? requestIndex : resultIndex] || {};
            const suggestionIndex = Number(result.suggestionIndex ?? result.suggestion_index ?? entry.suggestionIndex);
            const status = normalizePreflightStatus(
                result.status ?? result.classification ?? result.outcome ?? result.preflightStatus ?? result.preflight_status,
            );
            return {
                ...result,
                requestIndex,
                suggestionIndex,
                changeIndex: Number(result.changeIndex ?? result.change_index ?? entry.changeIndex ?? 0),
                operation: result.operation || entry.operation || 'replace',
                status,
                code: result.code || result.errorCode || result.error_code || '',
                message: result.message || result.reason || result.error || preflightDefaultMessage(status),
            };
        });
    };

    const collapsePreflightResults = (results, pendingItems) => pendingItems.map(({ item, index }) => {
        const childResults = results.filter((result) => result.suggestionIndex === index);
        const statuses = childResults.map((result) => result.status);
        const operations = new Set(childResults.map((result) => result.operation));
        let status = PREFLIGHT_STATUS.UNSUPPORTED;
        if (operations.size > 1 || (operations.has('append') && childResults.length > 1)) {
            status = PREFLIGHT_STATUS.UNSUPPORTED;
            childResults.push({
                status,
                message: '同一根风险同时包含新增与替换，当前不支持拆分写入，请合并为一个可原子处理的建议。',
            });
        } else if (statuses.length && statuses.every((value) => PREFLIGHT_SAFE.has(value))) {
            status = statuses.includes(PREFLIGHT_STATUS.SAFE_COMPOSITE)
                ? PREFLIGHT_STATUS.SAFE_COMPOSITE
                : (statuses.includes(PREFLIGHT_STATUS.SAFE_SUPERSEDE)
                    ? PREFLIGHT_STATUS.SAFE_SUPERSEDE
                    : PREFLIGHT_STATUS.SAFE_NEW);
        } else {
            status = [PREFLIGHT_STATUS.HUMAN_CONFLICT, PREFLIGHT_STATUS.NEEDS_NEW_ROUND, PREFLIGHT_STATUS.UNSUPPORTED]
                .find((value) => statuses.includes(value)) || PREFLIGHT_STATUS.UNSUPPORTED;
        }
        const messages = [...new Set(childResults.map((result) => result.message).filter(Boolean))];
        const summary = {
            suggestionIndex: index,
            title: suggestionTitle(item, index),
            status,
            label: preflightStatusLabel(status),
            message: messages.join('；') || preflightDefaultMessage(status),
            results: childResults,
        };
        item._revisionPreflight = summary;
        delete item._revisionApplyError;
        return summary;
    });

    const preflightReviewSuggestions = async (pendingItems, { save = true } = {}) => {
        if (!pendingItems.length) return [];
        if (reviewApplyMode.value !== 'review') {
            const entries = pendingItems.flatMap(({ item, index }) => revisionPreflightEntries(item, index));
            return collapsePreflightResults(entries.map((entry, requestIndex) => ({
                ...entry,
                requestIndex,
                status: PREFLIGHT_STATUS.SAFE_NEW,
                message: preflightDefaultMessage(PREFLIGHT_STATUS.SAFE_NEW),
            })), pendingItems);
        }
        if (!await ensureReviewApplyMode()) throw new Error('EDITOR_REVIEW_MODE_NOT_READY');
        if (save) {
            const saveAck = await forceSaveCurrentDocument(true);
            if (!saveAck?.saved) throw new Error('ONLYOFFICE_SAVE_NOT_CONFIRMED');
        }
        const entries = pendingItems.flatMap(({ item, index }) => revisionPreflightEntries(item, index));
        const response = await api.preflightContractRevisions(contract.id, {
            suggestions: entries,
            mode: 'review',
            expectedDocumentKey: contract.editorConfig?.document?.key,
            expectedSha256: contract.confirmedOssSha256 || undefined,
        });
        const results = normalizePreflightResults(response.data, entries);
        if (results.length !== entries.length) {
            throw new Error('REVISION_PREFLIGHT_INCOMPLETE');
        }
        return collapsePreflightResults(results, pendingItems);
    };

    const preflightAllSuggestions = async () => {
        const pendingItems = (reviewData.modification_suggestions || [])
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item && !isSuggestionEffective(item));
        batchPreflightLoading.value = true;
        try {
            batchPreflightResults.value = await preflightReviewSuggestions(pendingItems);
            return batchPreflightResults.value;
        } catch (error) {
            const message = error.response?.data?.error || error.response?.data?.message
                || (error.message === 'ONLYOFFICE_SAVE_NOT_CONFIRMED'
                    ? '文档尚未保存完成，本次预检已停止。'
                    : '修订预检服务失败，本次不会改动合同。');
            batchPreflightResults.value = pendingItems.map(({ item, index }) => {
                const result = {
                    suggestionIndex: index,
                    title: suggestionTitle(item, index),
                    status: PREFLIGHT_STATUS.FAILED,
                    label: preflightStatusLabel(PREFLIGHT_STATUS.FAILED),
                    message,
                    results: [],
                };
                item._revisionPreflight = result;
                return result;
            });
            return batchPreflightResults.value;
        } finally {
            batchPreflightLoading.value = false;
        }
    };

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
    // Pending system revisions remain actionable: preflight decides whether the
    // latest proposal can safely supersede the current same-round revision.
    const isSuggestionApplied = (item) => isSuggestionEffective(item);

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
        const plannedEntries = revisionPreflightEntries(item, suggestionIndex);
        const linkedChanges = plannedEntries.filter((entry) => entry.operation === 'replace');
        const appendEntries = plannedEntries.filter((entry) => entry.operation === 'append');

        if ((linkedChanges.length && appendEntries.length) || appendEntries.length > 1) {
            ElMessage.warning('同一风险同时包含多类写入，当前不支持拆分提交，请先合并建议。');
            return;
        }

        if (!plannedEntries.length || plannedEntries.some((entry) => !entry.suggestedText
            || (entry.operation === 'replace' && !entry.originalText))) {
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

        let reviewPreflightConfirmed = false;
        if (reviewApplyMode.value === 'review') {
            previewSuggestion(item, '正在检查当前条款的修订状态');
            try {
                const [preflight] = await preflightReviewSuggestions([{ item, index: suggestionIndex }]);
                if (!isRevisionPreflightSafe(preflight)) {
                    const status = `${preflight.label}：${preflight.message}`;
                    markFailed(status);
                    ElMessage.warning(status);
                    return;
                }
                reviewPreflightConfirmed = true;
                selectedSuggestionPreview.value.status = `${preflight.label}，正在写入审阅修订`;
            } catch (error) {
                const message = error.response?.data?.error || error.response?.data?.message
                    || (error.message === 'ONLYOFFICE_SAVE_NOT_CONFIRMED'
                        ? '文档保存尚未确认，已停止修订。'
                        : '修订预检失败，已停止写入。');
                item._revisionPreflight = {
                    suggestionIndex,
                    title: suggestionTitle(item, suggestionIndex),
                    status: PREFLIGHT_STATUS.FAILED,
                    label: preflightStatusLabel(PREFLIGHT_STATUS.FAILED),
                    message,
                    results: [],
                };
                markFailed(message);
                ElMessage.error(message);
                return;
            }
        }

        if (linkedChanges.length > 0) {
            previewSuggestion(item, '正在原子写入关联条款');
            try {
                if (!reviewPreflightConfirmed) {
                    if (!await ensureReviewApplyMode()) throw new Error('EDITOR_REVIEW_MODE_NOT_READY');
                    const saveAck = await forceSaveCurrentDocument(true);
                    if (!saveAck?.saved) throw new Error('ONLYOFFICE_SAVE_NOT_CONFIRMED');
                }
                const response = await api.batchReplaceContractText(contract.id, {
                    suggestions: linkedChanges,
                    mode: reviewApplyMode.value,
                    expectedDocumentKey: contract.editorConfig?.document?.key,
                    expectedSha256: contract.confirmedOssSha256 || undefined,
                });
                const results = response.data.results || [];
                item.revision_groups = results.map((result) => result.revisionGroup).filter(Boolean);
                applyResultToSuggestion(item, originalText, suggestedText, {
                    ...(results[0] || {}),
                    applicationStatus: response.data.applicationStatus,
                });
                selectedSuggestionPreview.value.status = `已原子写入 ${results.length} 处关联条款，等待统一审阅`;
                await reloadEditorConfig(response.data.editorConfig, undefined, {
                    text: results[0]?.replacementText || linkedChanges[0].suggestedText,
                });
                item._applying = false;
            } catch (error) {
                const details = error.response?.data?.results || error.response?.data?.failures || error.response?.data?.details || [];
                const detailText = Array.isArray(details)
                    ? details.map((failure, index) => `第 ${Number(failure.suggestionIndex ?? failure.suggestion_index ?? failure.index ?? index) + 1} 处：${failure.message || failure.error || failure.reason || '无法安全写入'}`).join('；')
                    : '';
                const message = detailText || error.response?.data?.error || '关联条款未全部写入，文档保持原状。';
                item._revisionApplyError = message;
                markFailed(message);
                ElMessage.error(message);
            }
            return;
        }

        if (appendEntries.length === 1) {
            const appendEntry = appendEntries[0];
            previewSuggestion(item, '正在新增条款');
            if (reviewPreflightConfirmed) {
                try {
                    const response = await api.appendContractClause(contract.id, {
                        title: appendEntry.title,
                        content: appendEntry.suggestedText,
                        mode: 'review',
                        suggestionIndex,
                        suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                        anchorHint: appendEntry.anchorHint,
                        currentClause: appendEntry.originalText,
                        targetClauseNo: appendEntry.targetClauseNo,
                        targetHeading: appendEntry.targetHeading,
                        expectedDocumentKey: contract.editorConfig?.document?.key,
                        expectedSha256: contract.confirmedOssSha256 || undefined,
                    });
                    await reloadEditorConfig(response.data?.editorConfig, undefined, {
                        text: response.data?.insertedText || appendEntry.suggestedText,
                    });
                    markAdopted({ appended: true, ...response.data });
                } catch (error) {
                    const message = error.response?.data?.error || error.response?.data?.message || '新增条款失败，文档未发生变化。';
                    item._revisionApplyError = message;
                    ElMessage.error(message);
                    markFailed(message);
                }
                return;
            }
            await appendClauseInEditorFinal(
                appendEntry.title,
                appendEntry.suggestedText,
                markAdopted,
                markFailed,
                {
                    mode: reviewApplyMode.value,
                    suggestionIndex,
                    anchorHint: appendEntry.anchorHint,
                    currentClause: appendEntry.originalText,
                    targetClauseNo: appendEntry.targetClauseNo,
                    targetHeading: appendEntry.targetHeading,
                    suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                },
            );
            return;
        }

        previewSuggestion(item, '正在采纳');
        if (reviewPreflightConfirmed) {
            try {
                const result = await replaceTextOnServer(originalText, suggestedText, item, {
                    mode: 'review',
                    suggestionIndex,
                    suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                });
                await reloadEditorConfig(result.editorConfig, undefined, {
                    text: result.replacementText || suggestedText,
                });
                markAdopted(result);
            } catch (error) {
                const message = error.response?.data?.error || error.response?.data?.message || '替换失败，文档未发生变化。';
                item._revisionApplyError = message;
                ElMessage.error(message);
                markFailed(message);
            }
            return;
        }
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

    const applyAllSuggestions = async (allowedIndexes = null, { skipForceSave = false } = {}) => {
        const allowed = Array.isArray(allowedIndexes) ? new Set(allowedIndexes.map(Number)) : null;
        const indexes = (reviewData.modification_suggestions || []).map((_, index) => index);
        const pendingItems = indexes.map((index) => ({
            index,
            item: reviewData.modification_suggestions[index],
        })).filter(({ item, index }) => item && !isSuggestionApplied(item) && (!allowed || allowed.has(index)));
        if (!pendingItems.length) {
            ElMessage.info('全部风险建议均已处理。');
            return;
        }
        batchApplying.value = true;
        try {
            if (!await ensureReviewApplyMode()) return;
            const plannedItems = pendingItems.flatMap(({ item, index }) => revisionPreflightEntries(item, index)
                .map((entry) => ({ item, index, entry })));
            const appendItems = plannedItems.filter(({ entry }) => entry.operation === 'append');
            const replacementItems = plannedItems.filter(({ entry }) => entry.operation === 'replace');
            let succeededCount = 0;
            let failedCount = 0;
            let totalReplacements = 0;
            let latestEditorConfig = null;
            let latestDocumentKey = contract.editorConfig?.document?.key;
            let latestDocumentSha256 = contract.confirmedOssSha256 || undefined;
            let restoreTarget = null;

            // Serialize the whole batch behind one editor save. Re-saving the
            // stale browser session after the server has already produced a new
            // DOCX version can overwrite accepted revisions.
            if (pendingItems.length && !skipForceSave) {
                const saveAck = await forceSaveCurrentDocument(true);
                if (!saveAck?.saved) throw new Error('ONLYOFFICE_SAVE_NOT_CONFIRMED');
            }

            if (replacementItems.length) {
                const suggestions = replacementItems.map(({ entry }) => entry);
                const response = await api.batchReplaceContractText(contract.id, {
                    suggestions,
                    mode: reviewApplyMode.value,
                    expectedDocumentKey: latestDocumentKey,
                    expectedSha256: latestDocumentSha256,
                });
                latestEditorConfig = response.data.editorConfig;
                latestDocumentKey = response.data.editorConfig?.document?.key || latestDocumentKey;
                latestDocumentSha256 = response.data.documentSha256 || response.data.document_sha256 || latestDocumentSha256;
                totalReplacements += response.data.totalReplacements || 0;
                failedCount += response.data.failedCount || 0;
                const groupedResults = new Map();
                (response.data.results || []).forEach((result) => {
                    if (result.ok) {
                        const targetEntry = replacementItems.find(({ index }) => index === Number(result.suggestionIndex ?? result.suggestion_index))
                            || replacementItems[Number(result.index)];
                        if (!targetEntry?.item) return;
                        const targetResults = groupedResults.get(targetEntry.index) || [];
                        targetResults.push(result);
                        groupedResults.set(targetEntry.index, targetResults);
                        if (!restoreTarget) {
                            restoreTarget = { text: result.replacementText || targetEntry.entry.suggestedText };
                        }
                    } else {
                        const targetEntry = replacementItems.find(({ index }) => index === Number(result.suggestionIndex ?? result.suggestion_index))
                            || replacementItems[Number(result.index)];
                        if (targetEntry?.item) {
                            targetEntry.item._revisionApplyError = result.message || result.error || result.reason || '无法安全写入该条款。';
                        }
                    }
                });
                for (const [suggestionIndex, results] of groupedResults.entries()) {
                    const target = reviewData.modification_suggestions?.[suggestionIndex];
                    if (!target) continue;
                    target.revision_groups = results.map((result) => result.revisionGroup || result.revision_group).filter(Boolean);
                    applyResultToSuggestion(target, suggestionOriginal(target), suggestionText(target), {
                        ...(results[0] || {}),
                        applicationStatus: response.data.applicationStatus || response.data.application_status,
                    });
                }
                succeededCount += groupedResults.size;
            }

            for (const { item, index, entry } of appendItems) {
                try {
                    const response = await api.appendContractClause(contract.id, {
                        title: entry.title,
                        content: entry.suggestedText,
                        mode: reviewApplyMode.value,
                        suggestionIndex: index,
                        suggestionId: item.revision_group?.suggestion_id || item.suggestion_id || item.id || '',
                        anchorHint: entry.anchorHint,
                        currentClause: entry.originalText,
                        targetClauseNo: entry.targetClauseNo,
                        targetHeading: entry.targetHeading,
                        expectedDocumentKey: latestDocumentKey,
                        expectedSha256: latestDocumentSha256,
                    });
                    latestEditorConfig = response.data.editorConfig || latestEditorConfig;
                    latestDocumentKey = response.data.editorConfig?.document?.key || latestDocumentKey;
                    latestDocumentSha256 = response.data.documentSha256 || response.data.document_sha256 || latestDocumentSha256;
                    if (!restoreTarget) {
                        restoreTarget = { text: response.data.insertedText || entry.suggestedText };
                    }
                    applyResultToSuggestion(item, suggestionOriginal(item), suggestionText(item), response.data);
                    succeededCount += 1;
                } catch (error) {
                    failedCount += 1;
                    item._revisionApplyError = error.response?.data?.error || error.response?.data?.message || '新增条款写入失败。';
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
            const failures = error.response?.data?.results || error.response?.data?.failures || error.response?.data?.details || [];
            const detailLines = Array.isArray(failures) ? failures.map((failure, resultIndex) => {
                const suggestionIndex = Number(failure.suggestionIndex ?? failure.suggestion_index ?? failure.index ?? resultIndex);
                const target = reviewData.modification_suggestions?.[suggestionIndex];
                const message = failure.message || failure.error || failure.reason || '无法安全写入';
                if (target) target._revisionApplyError = message;
                return `第 ${suggestionIndex + 1} 项：${message}`;
            }) : [];
            const message = detailLines.length
                ? detailLines.join('；')
                : (error.response?.data?.error || error.response?.data?.message || '批量采纳失败。');
            selectedSuggestionPreview.value = {
                before: '一键处理全部未处理风险建议',
                after: message,
                status: '批量修订未写入，请按下方逐项结果处理',
            };
            ElMessage.error(message);
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
        batchApplying, batchPreflightLoading, batchPreflightResults, diffItems, diffLoading, exportingDocument,
        addDocComment, adoptSuggestion, isSuggestionApplied, isSuggestionPendingReview, isSuggestionEffective,
        normalizeSuggestionApplicationStatus, suggestionApplicationStatus,
        preflightStatusLabel, isRevisionPreflightSafe, preflightAllSuggestions,
        applySuggestionStatusPayload, setSuggestionReviewDecision, downloadBlob,
        applyAllSuggestions, loadLatestDiff, exportReport, downloadPdfAnnotations, exportContractDocument,
    };
}
