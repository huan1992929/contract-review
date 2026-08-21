<template>
  <div class="review-workspace flex-grow min-h-0 flex gap-4">
    <!-- Left Side: OnlyOffice Editor -->
    <div class="document-panel basis-0 flex-[3] min-w-0 bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
      <div class="document-workbar px-3 py-2 border-b border-border-color bg-bg-subtle flex items-center justify-between gap-4">
        <div class="min-w-0 flex items-center gap-5">
          <StepHeader :activeStep="2" compact />
          <div class="document-context border-l border-border-color pl-4">
            <p class="text-xs font-semibold text-text-dark whitespace-nowrap">合同协同区</p>
            <p class="mt-0.5 text-xs text-text-light whitespace-nowrap">选中文本可进行专项审查</p>
          </div>
        </div>
        <div class="flex-shrink-0 flex items-center gap-3">
          <el-dropdown trigger="click" @command="exportContractDocument">
            <button class="contract-export-button" :disabled="exportingDocument" aria-label="导出合同文件">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>
              {{ exportingDocument ? '正在导出' : '一键导出' }}
              <span class="contract-export-caret">⌄</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="review-docx">审阅版 · Word（保留修订）</el-dropdown-item>
                <el-dropdown-item divided command="final-docx">最终版 · Word（接受全部修订）</el-dropdown-item>
                <el-dropdown-item command="final-pdf">最终版 · PDF</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <div
            :class="['apply-mode-switch', editorModeSyncing ? 'is-syncing' : '']"
            aria-label="AI 建议采纳方式"
            :aria-busy="editorModeSyncing"
          >
            <button
              @click="setReviewApplyMode('review')"
              :disabled="editorModeSyncing || !isEditorReady"
              :class="reviewApplyMode === 'review' ? 'is-active' : ''"
              :aria-pressed="reviewApplyMode === 'review'"
              :title="editorModeSyncError ? '编辑器模式尚未同步，请重试' : '生成可接受或拒绝的修订记录'"
            >审阅修订</button>
            <button
              @click="setReviewApplyMode('edit')"
              :disabled="editorModeSyncing || !isEditorReady"
              :class="reviewApplyMode === 'edit' ? 'is-active' : ''"
              :aria-pressed="reviewApplyMode === 'edit'"
              :title="editorModeSyncError ? '编辑器模式尚未同步，请重试' : '直接替换合同正文'"
            >直接编辑</button>
          </div>
          <button @click="prepareFocusedReviewFromSelection" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
            读取选中文本审查
          </button>
        </div>
      </div>
      <div v-if="editorModeSyncError" class="document-sync-alert" role="alert">
        <span aria-hidden="true">!</span>
        <p><strong>文档版本未同步</strong>{{ editorModeSyncError }}。请暂停修订并在“工作台”刷新版本。</p>
        <button type="button" @click="activeAiTab = 'workspace'">查看版本</button>
      </div>
      <OnlyOfficeEditor
        v-if="contract.editorConfig"
        id="docEditorComponent"
        ref="docEditorComponent"
        class="flex-grow min-h-0"
        :documentServerUrl="onlyOfficeUrl"
        :config="contract.editorConfig"
        :onDocumentReady="onDocumentReady"
        :onDocumentStateChange="onDocumentStateChange"
        :onError="onEditorError"
      />
      <div v-else-if="editorReloading" class="editor-reload-state flex-grow min-h-0">
        <span class="editor-reload-spinner" aria-hidden="true"></span>
        <p>{{ editorReloadMessage }}</p>
      </div>
      <div v-if="selectedSuggestionPreview" class="border-t border-border-color bg-white p-3 max-h-44 overflow-y-auto">
        <div class="flex items-center justify-between">
          <p class="text-sm font-semibold text-text-dark">最近采纳预览</p>
          <span class="text-xs text-green-700">{{ selectedSuggestionPreview.status }}</span>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-3 text-xs">
          <div>
            <p class="text-gray-500 font-medium">采纳前原文</p>
            <p class="mt-1 p-2 bg-red-50 text-red-800 border border-red-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.before }}</p>
          </div>
          <div>
            <p class="text-gray-500 font-medium">采纳后文本</p>
            <p class="mt-1 p-2 bg-green-50 text-green-800 border border-green-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.after }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Side: AI Review Panel -->
    <div class="review-panel basis-0 flex-[2] min-w-0 bg-white rounded-lg shadow-md flex flex-col h-full">
      <!-- Panel Header -->
      <div class="p-3 border-b border-border-color flex flex-col gap-3 flex-shrink-0">
        <div class="flex items-center">
          <h3 class="text-lg font-semibold text-text-dark">AI 审查报告</h3>
          <div class="ml-4 flex items-center">
            <span class="text-xs text-text-light mr-1">大白话模式</span>
            <el-switch v-model="showPlainLanguage" size="small"></el-switch>
          </div>
        </div>
        <div class="flex items-center flex-wrap gap-x-3 gap-y-2">
          <button @click="exportReport('html')" class="text-sm font-medium text-primary hover:text-primary-dark whitespace-nowrap">导出HTML</button>
          <button @click="exportReport('word')" class="text-sm font-medium text-primary hover:text-primary-dark whitespace-nowrap">导出Word</button>
          <button @click="downloadPdfAnnotations" class="text-sm font-medium text-primary hover:text-primary-dark whitespace-nowrap">PDF批注</button>
          <template v-if="cameFromHistory">
            <button @click="goBackToUpload" class="text-sm font-medium text-primary hover:text-primary-dark">重新上传</button>
            <button @click="goBackSmart" class="text-sm font-medium text-primary hover:text-primary-dark">返回历史</button>
          </template>
          <template v-else>
            <button @click="goBackSmart" class="text-sm font-medium text-primary hover:text-primary-dark">返回上一步</button>
          </template>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="px-4 border-b border-border-color flex-shrink-0">
        <nav class="-mb-px grid grid-cols-4 gap-2">
          <button @click="activeAiTab = 'summary'" :class="[activeAiTab === 'summary' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">总览</button>
          <button @click="activeAiTab = 'suggestions'" :class="[activeAiTab === 'suggestions' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">修改</button>
          <button @click="activeAiTab = 'knowledge'" :class="[activeAiTab === 'knowledge' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">依据</button>
          <button @click="activeAiTab = 'workspace'" :class="[activeAiTab === 'workspace' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">工作台</button>
        </nav>
      </div>

      <!-- Tab Content -->
      <div class="p-3 overflow-y-auto flex-grow">
        <ZhongAnReviewReport v-if="activeAiTab === 'summary'" />
        <ReviewSuggestionsTab v-if="activeAiTab === 'suggestions'" />
        <!-- Relevant Laws (Knowledge tab) -->
        <div v-if="activeAiTab === 'knowledge'">
          <div v-if="reviewData.relevant_laws && reviewData.relevant_laws.length > 0" class="space-y-4">
            <div v-for="(item, index) in reviewData.relevant_laws" :key="'law-' + index" :class="['p-4 rounded-md border', isLawOutdated(item) ? 'bg-red-50 border-red-200 border-l-4 border-l-red-500' : 'bg-blue-50 border-blue-100']">
              <div class="flex justify-between gap-3">
                <p class="font-bold text-blue-900">【{{ item.law }}】{{ item.clause }}</p>
                <el-tag v-if="isLawOutdated(item)" type="danger" size="small">{{ item.law_status === '已废止' ? '已废止' : '已修订' }}</el-tag>
                <el-tag v-else type="success" size="small">现行</el-tag>
              </div>
              <p class="mt-2 text-sm text-blue-900 leading-6">{{ item.content }}</p>
              <p v-if="isLawOutdated(item)" class="mt-2 text-xs text-red-700">{{ item.updateNotice || '该条文已被修订，仅作历史参考' }}</p>
            </div>
          </div>
          <div v-else class="text-center text-text-light py-8">未命中相关法条</div>
        </div>
        <ReviewWorkspaceTab v-if="activeAiTab === 'workspace'" />
      </div>
    </div>
  </div>
</template>

<script>
import { inject } from 'vue';
import { ElSwitch, ElTag, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus';
import StepHeader from './StepHeader.vue';
import OnlyOfficeEditor from './OnlyOfficeEditor.vue';
import ZhongAnReviewReport from './ZhongAnReviewReport.vue';
import ReviewSuggestionsTab from './ReviewSuggestionsTab.vue';
import ReviewWorkspaceTab from './ReviewWorkspaceTab.vue';

export default {
  name: 'ReviewStep',
  components: {
    OnlyOfficeEditor, ElSwitch, ElTag, ElDropdown, ElDropdownMenu, ElDropdownItem, StepHeader,
    ZhongAnReviewReport, ReviewSuggestionsTab, ReviewWorkspaceTab,
  },
  setup() {
    const review = inject('review');
    const {
      contract, onlyOfficeUrl, onDocumentReady, onDocumentStateChange, onEditorError,
      editorReloading, editorReloadMessage,
      isEditorReady, editorModeSyncing, editorModeSyncError, setReviewApplyMode,
      docEditorComponent, selectedSuggestionPreview,
      prepareFocusedReviewFromSelection,
      showPlainLanguage, reviewApplyMode, exportReport, downloadPdfAnnotations,
      exportContractDocument, exportingDocument,
      cameFromHistory, goBackToUpload, goBackSmart,
      activeAiTab, reviewData, isLawOutdated,
    } = review;

    return {
      contract, onlyOfficeUrl, onDocumentReady, onDocumentStateChange, onEditorError,
      editorReloading, editorReloadMessage,
      isEditorReady, editorModeSyncing, editorModeSyncError, setReviewApplyMode,
      docEditorComponent, selectedSuggestionPreview,
      prepareFocusedReviewFromSelection,
      showPlainLanguage, reviewApplyMode, exportReport, downloadPdfAnnotations,
      exportContractDocument, exportingDocument,
      cameFromHistory, goBackToUpload, goBackSmart,
      activeAiTab, reviewData, isLawOutdated,
    };
  },
};
</script>

<style scoped>
.review-workspace {
  padding: 0 clamp(12px, 1.5vw, 22px) 18px;
}

.document-panel,
.review-panel {
  border: 1px solid var(--tp-line);
  border-radius: 16px;
  box-shadow: var(--tp-shadow-sm);
}

.document-workbar {
  min-height: 58px;
  background: var(--tp-bg-muted);
}

.document-sync-alert {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  border-bottom: 1px solid #e8c36b;
  background: var(--tp-warning-bg);
  color: #795300;
  font-size: 11px;
}

.document-sync-alert > span {
  display: grid;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  place-items: center;
  border: 1px solid #d4a441;
  border-radius: 50%;
  font-weight: 900;
}

.document-sync-alert p { min-width: 0; flex: 1; margin: 0; }
.document-sync-alert strong { margin-right: 7px; }
.document-sync-alert button { flex: none; border: 0; background: transparent; color: #795300; font-size: 11px; font-weight: 800; text-decoration: underline; }

.document-context {
  flex: 0 0 148px;
}

.apply-mode-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--tp-line);
  border-radius: 10px;
  background: #fff;
}

.apply-mode-switch button {
  padding: 4px 9px;
  border-radius: 8px;
  color: var(--tp-text-muted);
  font-size: 12px;
  line-height: 1.25;
}

.apply-mode-switch button.is-active {
  color: #fff;
  background: var(--tp-accent);
}

.apply-mode-switch button:disabled {
  cursor: wait;
  opacity: .56;
}

.apply-mode-switch.is-syncing {
  border-color: var(--tp-accent-muted);
  box-shadow: 0 0 0 3px rgba(214, 0, 46, .09);
}

.contract-export-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--tp-line-strong);
  border-radius: 10px;
  background: #fff;
  color: var(--tp-text-body);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
}

.contract-export-button:hover:not(:disabled) {
  border-color: var(--tp-accent-muted);
  background: var(--tp-accent-subtle);
  color: var(--tp-accent-active);
}

.contract-export-button:disabled {
  cursor: wait;
  opacity: .62;
}

.contract-export-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.contract-export-caret {
  margin-left: 1px;
  color: var(--tp-text-subtle);
}

.editor-reload-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--tp-bg-muted);
  color: var(--tp-text-muted);
  font-size: 13px;
}

.editor-reload-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid #f8c2ce;
  border-top-color: var(--tp-accent);
  border-radius: 50%;
  animation: editor-reload-spin 0.8s linear infinite;
}

@keyframes editor-reload-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1280px) {
  .document-context {
    display: none;
  }
}

@media (max-width: 1024px) {
  .document-workbar {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 900px) {
  .review-workspace {
    height: auto;
    min-height: 0;
    flex-direction: column;
    overflow-y: auto;
  }

  .document-panel,
  .review-panel {
    flex-basis: auto;
    min-height: 680px;
  }
}
</style>
