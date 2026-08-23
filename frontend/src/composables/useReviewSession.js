// Review.vue 会话持久化与合同加载
import { ElMessage } from 'element-plus';
import api from '../api';
import { resolveRecommendedPerspective } from '../utils/reviewPerspective';

export function useReviewSession(state, deps) {
    const {
        activeStep, loading, loadingMessage, sessionLoadFailed,
        contract, perspective, preAnalysisData, reviewData,
        activeAiTab, cameFromHistory, selectedTemplateId,
        allSuggestedReviewPoints, allPotentialParties, allSuggestedCorePurposes,
        selectedReviewPoints, customPurposes, reviewApplyMode,
        saveState, resetState,
    } = state;
    const {
        route, router, setupSocket, loadFocusedReviewHistory,
        forceSaveCurrentDocument, goBackToConfirm, scrollQaToBottom, qaPanelOpen,
    } = deps;

    const loadContractFromServer = async (contractId) => {
        loading.value = true;
        loadingMessage.value = '正在从历史记录加载合同...';
        try {
            const response = await api.getContractDetails(contractId);
            const contractData = response.data;

            Object.assign(contract, contractData.contract);
            setupSocket(contract.id);
            Object.assign(preAnalysisData, contractData.preAnalysisData || {});
            const workflowStatus = String(contractData.workflowStatus || contractData.contract?.status || '').toLowerCase();
            const normalizedStatus = String(contractData.analysisStatus || '').toLowerCase();
            activeStep.value = workflowStatus === 'preanalyzed' || normalizedStatus === 'pre_analyzed' ? 1 : 2;
            perspective.value = contractData.perspective || resolveRecommendedPerspective(preAnalysisData);
            selectedTemplateId.value = preAnalysisData.template_id || '';
            allSuggestedReviewPoints.value = contractData.preAnalysisData?.suggested_review_points || [];
            allPotentialParties.value = contractData.preAnalysisData?.potential_parties || [];
            if (perspective.value && !allPotentialParties.value.includes(perspective.value)) {
                allPotentialParties.value.unshift(perspective.value);
            }
            allSuggestedCorePurposes.value = contractData.preAnalysisData?.suggested_core_purposes || [];
            selectedReviewPoints.value = contractData.selectedReviewPoints || [];
            customPurposes.value = contractData.customPurposes || [{ value: '' }];
            Object.assign(reviewData, contractData.reviewData || {});

            saveState();
            loadFocusedReviewHistory();
        } catch (error) {
            console.error(`Failed to load contract ${contractId} from server:`, error);
            ElMessage.error('加载历史记录失败，将返回首页。');
            router.push('/');
            resetState();
        } finally {
            loading.value = false;
        }
    };

    const querySearchCorePurposes = (queryString, cb) => {
        const results = queryString
            ? allSuggestedCorePurposes.value.filter(p => p.toLowerCase().includes(queryString.toLowerCase()))
            : allSuggestedCorePurposes.value;
        cb(results.map(p => ({ value: p })));
    };

    const restoreSessionFromSavedState = async (savedState) => {
        const response = await api.getContractDetails(savedState.contract.id);
        const serverEditorConfig = response.data.contract.editorConfig;

        activeStep.value = savedState.activeStep;
        activeAiTab.value = savedState.activeAiTab || 'suggestions';
        if (savedState.reviewApplyMode === 'edit' || savedState.reviewApplyMode === 'review') {
            reviewApplyMode.value = savedState.reviewApplyMode;
            localStorage.setItem('contract_apply_mode', reviewApplyMode.value);
        }
        if (!['summary', 'suggestions', 'knowledge', 'workspace'].includes(activeAiTab.value)) {
            activeAiTab.value = 'summary';
        }

        Object.assign(contract, savedState.contract);
        contract.editorConfig = serverEditorConfig;
        setupSocket(contract.id);

        perspective.value = savedState.perspective;
        Object.assign(preAnalysisData, savedState.preAnalysisData || {});
        selectedTemplateId.value = savedState.selectedTemplateId || preAnalysisData.template_id || '';
        // The server is authoritative for applied/pending-review suggestion
        // states. Keeping the browser's older reviewData after a document write
        // makes resolved risk boxes revert to red/yellow on reload.
        Object.assign(reviewData, {
            ...(savedState.reviewData || {}),
            ...(response.data.reviewData || {}),
        });

        selectedReviewPoints.value = savedState.selectedReviewPoints || [];
        customPurposes.value = savedState.customPurposes || [{ value: '' }];
        allSuggestedReviewPoints.value = savedState.allSuggestedReviewPoints || [];
        allPotentialParties.value = savedState.allPotentialParties || [];
        allSuggestedCorePurposes.value = savedState.allSuggestedCorePurposes || [];

        loadFocusedReviewHistory();
    };

    const loadState = async () => {
        const savedStateJSON = localStorage.getItem('review_session');
        if (savedStateJSON) {
            try {
                const savedState = JSON.parse(savedStateJSON);
                if (savedState.contract && savedState.contract.id) {
                    loading.value = true;
                    loadingMessage.value = '正在恢复您的会话...';
                    sessionLoadFailed.value = false;

                    try {
                        await restoreSessionFromSavedState(savedState);
                    } catch (error) {
                        console.error(`Failed to refresh session for contract ${savedState.contract.id}:`, error);
                        sessionLoadFailed.value = true;
                        ElMessage.error('恢复会话失败（可能是网络问题）。可点击"重试"重新加载，您的工作进度已保留。');
                    } finally {
                        loading.value = false;
                    }
                }
            } catch (e) {
                console.error("Failed to parse saved state, clearing invalid session.", e);
                localStorage.removeItem('review_session');
            }
        }
    };

    const retryLoadSession = async () => {
        const savedStateJSON = localStorage.getItem('review_session');
        if (!savedStateJSON) {
            sessionLoadFailed.value = false;
            return;
        }
        loading.value = true;
        loadingMessage.value = '正在重试恢复会话...';
        try {
            const savedState = JSON.parse(savedStateJSON);
            await restoreSessionFromSavedState(savedState);
            sessionLoadFailed.value = false;
            ElMessage.success('会话恢复成功。');
        } catch (error) {
            ElMessage.error('重试失败，请检查网络后再次点击重试。');
        } finally {
            loading.value = false;
        }
    };

    const goBackSmart = () => {
        if (cameFromHistory.value) {
            forceSaveCurrentDocument(true);
            router.push('/history');
        } else {
            forceSaveCurrentDocument(true);
            goBackToConfirm();
        }
    };

    const goToQnA = () => {
        forceSaveCurrentDocument(true);
        qaPanelOpen.value = true;
        scrollQaToBottom();
    };

    return {
        loadContractFromServer, querySearchCorePurposes,
        restoreSessionFromSavedState, loadState, retryLoadSession,
        goBackSmart, goToQnA,
    };
}
