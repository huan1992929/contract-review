<template>
  <div class="space-y-6">
    <section class="version-ledger" aria-labelledby="version-ledger-title">
      <div class="version-ledger__head">
        <div>
          <p class="version-ledger__kicker">DOCUMENT HISTORY</p>
          <h4 id="version-ledger-title">合同版本与保存状态</h4>
        </div>
        <button type="button" :disabled="versionsLoading" @click="loadVersions">
          {{ versionsLoading ? '正在同步…' : '刷新版本' }}
        </button>
      </div>
      <div v-if="versionsError" class="version-alert is-error">
        <strong>版本记录加载失败</strong>
        <span>{{ versionsError }}</span>
      </div>
      <div v-else-if="versions.length" class="version-list">
        <article v-for="(version, index) in versions" :key="version.id || version.version_no" :class="['version-item', index === 0 ? 'is-current' : '']">
          <span class="version-node"></span>
          <div class="version-item__copy">
            <strong>版本 {{ version.version_no || version.version || versions.length - index }}</strong>
            <span>{{ versionActionLabel(version.source_action) }}</span>
          </div>
          <time>{{ formatVersionTime(version.created_at) }}</time>
          <span v-if="index === 0" class="version-current">当前</span>
        </article>
      </div>
      <div v-else-if="!versionsLoading" class="version-empty">
        当前尚无修订快照。首次写入修订后，系统会在这里保留可追溯版本。
      </div>
      <div v-if="editorModeSyncError" class="version-alert is-warning">
        <strong>编辑器状态同步失败</strong>
        <span>{{ editorModeSyncError }}。请刷新版本并重新打开文档，避免在旧版本上继续修改。</span>
      </div>
    </section>

    <!-- Focused Review -->
    <div class="space-y-4">
      <div class="p-4 bg-white rounded-md border border-border-color">
        <div class="flex items-center justify-between">
          <h4 class="font-semibold text-text-dark">合同版本对比</h4>
          <button @click="loadLatestDiff" :disabled="diffLoading" class="px-3 py-1.5 text-xs font-medium text-primary bg-white border border-primary rounded hover:bg-primary-light">
            {{ diffLoading ? '加载中...' : '查看最近变更' }}
          </button>
        </div>
        <div v-if="diffItems.length" class="mt-3 p-3 bg-bg-subtle rounded text-xs leading-6 max-h-56 overflow-y-auto whitespace-pre-wrap">
          <template v-for="(part, index) in diffItems" :key="'diff-' + index">
            <span v-if="part.type === 'insert'" class="diff-insert">{{ part.text }}</span>
            <span v-else-if="part.type === 'delete'" class="diff-delete">{{ part.text }}</span>
            <span v-else>{{ part.text }}</span>
          </template>
        </div>
        <p v-else class="mt-2 text-xs text-text-light">采纳修改后会自动保存原始快照，可在这里查看新增和删除文本。</p>
      </div>
      <div class="p-4 bg-bg-subtle rounded-md border border-border-color">
        <div class="flex justify-between items-center">
          <h4 class="font-semibold text-text-dark">选中文本专项审查</h4>
          <button @click="prepareFocusedReviewFromSelection" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
            从左侧读取选中文本
          </button>
        </div>
        <el-input
          v-model="focusedReviewText"
          class="mt-3"
          type="textarea"
          :rows="6"
          placeholder="可从左侧 OnlyOffice 选中文本后读取，也可手动粘贴某一条款或段落"
        />
        <el-input
          v-model="focusedReviewQuestion"
          class="mt-3"
          placeholder="专项问题，例如：审查这段试用期条款是否合法，并给出可替换文本"
        />
        <div class="mt-3 flex justify-end">
          <button @click="submitFocusedReview" :disabled="focusedReviewLoading || !focusedReviewText.trim()" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded hover:bg-primary-dark disabled:opacity-50">
            {{ focusedReviewLoading ? '审查中...' : '开始专项审查' }}
          </button>
        </div>
      </div>

      <div v-if="focusedReviewResult" class="p-4 bg-white rounded-md border border-border-color">
        <p class="font-semibold text-text-dark">专项审查结论</p>
        <p class="mt-2 text-sm text-text-main whitespace-pre-line">{{ focusedReviewResult.risk_summary }}</p>
        <div v-if="focusedReviewResult.plain_language" class="mt-3 p-3 bg-blue-50 text-blue-800 border-l-4 border-blue-400 rounded">
          <p class="text-xs font-bold mb-1">大白话说明</p>
          <p class="text-sm">{{ focusedReviewResult.plain_language }}</p>
        </div>
        <div v-if="focusedReviewResult.suggested_text" class="mt-3">
          <p class="text-xs text-gray-500 font-medium">建议替换文本</p>
          <p class="mt-1 p-2 bg-green-50 text-green-800 border border-green-100 rounded whitespace-pre-line">{{ focusedReviewResult.suggested_text }}</p>
          <button @click="applyFocusedSuggestion" class="mt-3 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
            替换左侧选中文本
          </button>
        </div>
        <div v-if="focusedReviewResult.relevant_laws && focusedReviewResult.relevant_laws.length" class="mt-3">
          <p class="text-xs text-gray-500 font-medium">检索依据</p>
          <div v-for="(item, index) in focusedReviewResult.relevant_laws" :key="'fr-law-' + index" class="mt-2 p-2 bg-bg-subtle rounded text-xs">
            【{{ item.law }}】{{ item.clause }}：{{ item.content }}
          </div>
        </div>
      </div>

      <!-- 专项审查历史 -->
      <div v-if="focusedReviewHistory.length" class="p-4 bg-white rounded-md border border-border-color">
        <div class="flex justify-between items-center">
          <p class="font-semibold text-text-dark text-sm">历史专项审查（已持久化，刷新不丢失）</p>
          <span class="text-xs text-text-light">{{ focusedReviewHistory.length }} 条</span>
        </div>
        <div class="mt-2 space-y-2 max-h-72 overflow-y-auto">
          <div v-for="item in focusedReviewHistory" :key="'fr-h-' + item.id" class="p-2 bg-bg-subtle rounded text-xs border border-transparent hover:border-primary transition-colors">
            <div class="flex justify-between items-start gap-2">
              <div class="flex-1 min-w-0">
                <p class="text-text-main font-medium truncate">{{ item.question || '（无专项问题）' }}</p>
                <p class="text-text-light mt-0.5 truncate">原文：{{ item.source_text }}</p>
                <p class="text-text-light mt-0.5">{{ formatHistoryTime(item.created_at) }}</p>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button @click="loadFocusedReviewFromHistory(item)" class="px-2 py-1 text-xs text-primary border border-primary rounded hover:bg-primary hover:text-white">查看</button>
                <button @click="deleteFocusedReviewFromHistory(item.id)" class="px-2 py-1 text-xs text-red-500 border border-red-300 rounded hover:bg-red-500 hover:text-white">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Re-review Form -->
    <div class="space-y-6">
      <div>
        <label class="block text-sm font-medium text-text-main">合同类型</label>
        <el-input v-model="preAnalysisData.contract_type" class="mt-1"></el-input>
      </div>
      <div>
         <label class="block text-sm font-medium text-text-main">审查立场</label>
         <el-select v-model="perspective" placeholder="请选择或输入您的立场" class="w-full mt-1" filterable allow-create>
            <el-option v-for="party in allPotentialParties" :key="party" :label="party" :value="party"></el-option>
         </el-select>
      </div>
      <div>
        <label class="block text-sm font-medium text-text-main">审查点选择</label>
         <div class="mt-2 p-3 bg-bg-subtle rounded-md">
            <el-checkbox-group v-model="selectedReviewPoints" class="flex flex-wrap gap-2">
                <el-checkbox v-for="point in allSuggestedReviewPoints" :key="point" :label="point" :value="point" border></el-checkbox>
            </el-checkbox-group>
         </div>
      </div>
      <div>
        <label class="block text-sm font-medium text-text-main">审查核心目的</label>
         <div v-for="(purpose, index) in customPurposes" :key="index" class="flex items-center mt-1">
            <el-autocomplete
                v-model="purpose.value"
                :fetch-suggestions="querySearchCorePurposes"
                placeholder="搜索或输入新目的"
                class="w-full"
                trigger-on-focus
            ></el-autocomplete>
            <button @click="removePurpose(index)" class="ml-2 text-gray-400 hover:text-danger"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></button>
        </div>
        <button @click="addPurpose" class="mt-2 text-sm font-medium text-primary hover:text-primary-dark flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            添加目的
        </button>
      </div>
      <div class="pt-4">
        <button
          @click="startReAnalysis"
          :disabled="!perspective || selectedReviewPoints.length === 0 || reAnalyzing"
          class="w-full px-4 py-2 text-sm font-medium text-white bg-primary border border-transparent rounded-md shadow-sm hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ reAnalyzing ? '正在重审...' : '确认重审' }}
        </button>
      </div>
      <!-- 重审进度面板 -->
      <div v-if="reAnalyzing || analysisActive" class="reanalysis-progress p-4 bg-white rounded-md border border-border-color">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-semibold text-text-dark">{{ loadingMessage || '正在重新审查合同...' }}</span>
          <span v-if="analysisPercent > 0" class="text-lg font-bold text-primary">{{ analysisPercent }}%</span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden mb-2">
          <div class="bg-primary h-2 rounded-full transition-all duration-500 ease-out" :style="{ width: analysisPercent + '%' }"></div>
        </div>
        <div class="flex justify-between text-xs text-text-light mb-3">
          <span>已用时：{{ formatDuration(analysisElapsed) }}</span>
          <span v-if="analysisEta > 0">预计剩余：{{ formatDuration(analysisEta) }}</span>
          <span v-else>仍在处理中，超时会自动结束</span>
        </div>
        <div v-if="analysisSteps.length" class="analysis-progress mt-2 w-full">
          <div
            v-for="(step, index) in analysisSteps"
            :key="'re-step-' + index"
            class="analysis-progress__item"
            :class="[`analysis-progress__item--${progressStatusClass(step.status)}`]"
          >
            <div class="analysis-progress__marker">
              <span v-if="step.status === 'completed'">✓</span>
              <span v-else-if="step.status === 'failed'">!</span>
              <span v-else-if="step.status === 'running'" class="analysis-progress__spinner"></span>
              <span v-else>{{ index + 1 }}</span>
            </div>
            <div class="analysis-progress__content">
              <div class="analysis-progress__title">
                <span>{{ step.label }}</span>
                <span class="analysis-progress__status">{{ progressStatusLabel(step.status) }}</span>
              </div>
              <p v-if="step.message" class="analysis-progress__message">{{ step.message }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { inject, onMounted, ref, watch } from 'vue';
import { ElInput, ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElAutocomplete } from 'element-plus';
import api from '../../api';

export default {
  name: 'ReviewWorkspaceTab',
  components: { ElInput, ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElAutocomplete },
  setup() {
    const review = inject('review');
    const {
      diffItems, diffLoading, loadLatestDiff,
      prepareFocusedReviewFromSelection,
      focusedReviewText, focusedReviewQuestion, focusedReviewResult, focusedReviewLoading,
      submitFocusedReview, applyFocusedSuggestion,
      focusedReviewHistory, formatHistoryTime, loadFocusedReviewFromHistory, deleteFocusedReviewFromHistory,
      preAnalysisData, perspective, allPotentialParties,
      selectedReviewPoints, allSuggestedReviewPoints,
      customPurposes, querySearchCorePurposes, removePurpose, addPurpose,
      startReAnalysis, reAnalyzing,
      analysisActive, loadingMessage, analysisPercent, analysisElapsed, analysisEta,
      formatDuration, analysisSteps, progressStatusClass, progressStatusLabel,
      contract, editorModeSyncError,
    } = review;
    const versions = ref([]);
    const versionsLoading = ref(false);
    const versionsError = ref('');
    const loadVersions = async () => {
      if (!contract.id || versionsLoading.value) return;
      versionsLoading.value = true;
      versionsError.value = '';
      try {
        const response = await api.getContractVersions(contract.id);
        versions.value = Array.isArray(response.data?.versions) ? response.data.versions : [];
      } catch (error) {
        versionsError.value = error.response?.data?.error || '无法连接版本服务，请稍后重试。';
      } finally {
        versionsLoading.value = false;
      }
    };
    const versionActionLabel = (action) => ({
      upload: '原始上传',
      'replace-text': '单条修订前快照',
      'batch-replace-text': '批量修订前快照',
      'review-batch-replace-text': '审阅修订前快照',
      'append-clause': '新增条款前快照',
      incremental_review: '增量复审快照',
    }[action] || action || '合同快照');
    const formatVersionTime = (value) => value
      ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '时间待同步';
    watch(() => contract.id, loadVersions);
    onMounted(loadVersions);
    return {
      versions, versionsLoading, versionsError, loadVersions, versionActionLabel, formatVersionTime,
      editorModeSyncError,
      diffItems, diffLoading, loadLatestDiff,
      prepareFocusedReviewFromSelection,
      focusedReviewText, focusedReviewQuestion, focusedReviewResult, focusedReviewLoading,
      submitFocusedReview, applyFocusedSuggestion,
      focusedReviewHistory, formatHistoryTime, loadFocusedReviewFromHistory, deleteFocusedReviewFromHistory,
      preAnalysisData, perspective, allPotentialParties,
      selectedReviewPoints, allSuggestedReviewPoints,
      customPurposes, querySearchCorePurposes, removePurpose, addPurpose,
      startReAnalysis, reAnalyzing,
      analysisActive, loadingMessage, analysisPercent, analysisElapsed, analysisEta,
      formatDuration, analysisSteps, progressStatusClass, progressStatusLabel,
    };
  },
};
</script>

<style scoped>
.version-ledger {
  padding: 16px;
  border: 1px solid var(--tp-line);
  border-radius: 14px;
  background: linear-gradient(135deg, #fff 0%, var(--tp-bg-muted) 145%);
}

.version-ledger__head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.version-ledger__head h4 { margin: 3px 0 0; color: var(--tp-text-primary); font-size: 14px; }
.version-ledger__kicker { margin: 0; color: var(--tp-accent); font-family: ui-monospace, "SFMono-Regular", monospace; font-size: 9px; font-weight: 800; letter-spacing: .14em; }
.version-ledger__head button { padding: 6px 10px; border: 1px solid var(--tp-line); border-radius: 9px; background: #fff; color: var(--tp-text-muted); font-size: 11px; font-weight: 700; }
.version-list { position: relative; display: grid; margin-top: 14px; }
.version-list::before { content: ''; position: absolute; top: 15px; bottom: 15px; left: 5px; width: 1px; background: var(--tp-line-strong); }
.version-item { position: relative; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto; align-items: center; gap: 9px; min-height: 38px; color: var(--tp-text-muted); font-size: 11px; }
.version-node { position: relative; z-index: 1; width: 11px; height: 11px; border: 2px solid #fff; border-radius: 50%; background: var(--tp-line-strong); box-shadow: 0 0 0 1px var(--tp-line-strong); }
.version-item.is-current .version-node { background: var(--tp-accent); box-shadow: 0 0 0 1px var(--tp-accent), 0 0 0 5px var(--tp-accent-subtle); }
.version-item__copy { display: flex; min-width: 0; gap: 8px; align-items: baseline; }
.version-item__copy strong { color: var(--tp-text-primary); font-size: 12px; }
.version-item__copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.version-current { padding: 2px 6px; border-radius: 999px; background: var(--tp-accent-subtle); color: var(--tp-accent-active); font-size: 9px; font-weight: 800; }
.version-empty { margin-top: 13px; padding: 12px; border-radius: 10px; background: var(--tp-bg-muted); color: var(--tp-text-subtle); font-size: 11px; line-height: 1.6; }
.version-alert { display: grid; gap: 3px; margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 11px; line-height: 1.55; }
.version-alert.is-error { background: #fde8e8; color: #a82b2b; }
.version-alert.is-warning { background: var(--tp-warning-bg); color: #8a5b00; }
.version-alert strong { font-size: 12px; }

.reanalysis-progress .analysis-progress {
  max-height: 280px;
  overflow-y: auto;
}
</style>
