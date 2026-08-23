<template>
  <div class="confirm-step w-full max-w-5xl mx-auto py-8">
    <div v-if="preAnalysisData.contract_type">
      <div class="text-center mb-10">
        <p class="text-lg text-text-main">文件 <span class="font-semibold text-primary">{{ contract.original_filename }}</span> 已上传成功。</p>
        <div class="mt-2 flex items-center justify-center gap-2">
          <p class="text-md text-text-light">AI初步识别该合同为：</p>
          <el-input
            v-model="preAnalysisData.contract_type"
            class="contract-type-edit"
            size="small"
            style="width: 240px;"
            placeholder="可修改合同类型"
          />
        </div>
        <button @click="showContractPreview = !showContractPreview" class="mt-3 text-sm font-medium text-primary hover:text-primary-dark inline-flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 transition-transform" :class="{ 'rotate-180': showContractPreview }" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
          {{ showContractPreview ? '收起合同预览' : '查看合同预览' }}
          <span v-if="preAnalysisData.text_stats" class="text-xs text-text-light font-normal">（{{ preAnalysisData.text_stats.charCount }} 字）</span>
        </button>
        <div v-if="showContractPreview" class="mt-3 mx-auto max-w-3xl text-left bg-white border border-border-color rounded-lg p-4 max-h-60 overflow-y-auto">
          <p class="text-sm text-text-main leading-relaxed whitespace-pre-line">{{ contractPreviewText }}</p>
          <p v-if="preAnalysisData.text_stats && preAnalysisData.text_stats.charCount > 200" class="mt-2 pt-2 border-t border-border-color text-xs text-text-light text-center">仅展示前 200 字，完整内容将在审查后显示</p>
        </div>
      </div>

      <section class="recognition-panel" aria-labelledby="recognition-heading">
        <div class="recognition-panel__heading">
          <div>
            <p class="recognition-panel__eyebrow">PRE-REVIEW TRACE</p>
            <h2 id="recognition-heading">审查基线确认</h2>
            <p>系统先确认思库立场、业务场景与参考模板，再执行风险规则。</p>
          </div>
          <span :class="['recognition-panel__status', { 'recognition-panel__status--warning': preAnalysisConfirmation.requiresConfirmation }]">
            {{ preAnalysisConfirmation.requiresConfirmation ? '需人工确认' : '已自动识别' }}
          </span>
        </div>

        <div class="recognition-grid">
          <article class="recognition-card">
            <span class="recognition-card__number">01</span>
            <p class="recognition-card__label">我方主体与立场</p>
            <strong>{{ preAnalysisConfirmation.ourParty || '未识别到思库关联主体' }}</strong>
            <div class="recognition-card__meta">
              <span>{{ preAnalysisConfirmation.roleLabel || '甲乙方待确认' }}</span>
              <span>{{ confidenceLabel(preAnalysisConfirmation.confidence, preAnalysisConfirmation.confidenceScore) }}</span>
            </div>
            <p v-if="preAnalysisConfirmation.evidence[0]?.snippet" class="recognition-card__evidence">
              证据：{{ preAnalysisConfirmation.evidence[0].snippet }}
            </p>
            <p v-else class="recognition-card__evidence">兼容历史记录：请以下方立场选择为准。</p>
          </article>

          <article class="recognition-card">
            <span class="recognition-card__number">02</span>
            <p class="recognition-card__label">业务场景</p>
            <strong>{{ scenarioName(preAnalysisConfirmation.primaryScenario) || preAnalysisData.contract_type || '待确认' }}</strong>
            <div class="recognition-card__meta">
              <span>{{ confidenceLabel(preAnalysisConfirmation.scenario.confidence || 'unknown', preAnalysisConfirmation.scenario.confidence_score) }}</span>
            </div>
            <div v-if="preAnalysisConfirmation.secondaryScenarios.length" class="recognition-card__chips">
              <span v-for="item in preAnalysisConfirmation.secondaryScenarios" :key="item.id || item.name || item">
                {{ scenarioName(item) }}
              </span>
            </div>
            <p v-else class="recognition-card__evidence">当前未识别到次场景。</p>
          </article>

          <article class="recognition-card">
            <span class="recognition-card__number">03</span>
            <p class="recognition-card__label">知识库参考模板</p>
            <strong>{{ templateName(preAnalysisConfirmation.templateCandidates[0]) || preAnalysisData.template_name || '通用合同审查模板' }}</strong>
            <div v-if="preAnalysisConfirmation.templateCandidates[0]?.confidence" class="recognition-card__meta">
              <span>{{ confidenceLabel(preAnalysisConfirmation.templateCandidates[0].confidence) }}</span>
            </div>
            <p v-if="templateReason(preAnalysisConfirmation.templateCandidates[0])" class="recognition-card__evidence">
              {{ templateReason(preAnalysisConfirmation.templateCandidates[0]) }}
            </p>
            <p v-else class="recognition-card__evidence">可在下方审查范围中人工更换。</p>
          </article>
        </div>
        <p v-if="preAnalysisConfirmation.requiresConfirmation" class="recognition-panel__notice">
          {{ preAnalysisConfirmation.confirmationReason || '当前识别置信度不足，请确认审查立场和参考模板后再开始分析。' }}
        </p>
      </section>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div class="bg-white rounded-lg shadow-md p-6">
          <h3 class="text-lg font-semibold text-text-dark">1. 选择您的审查立场</h3>
          <p class="text-sm text-text-light mt-1">AI将基于您的立场进行侧重分析。</p>
          <div class="mt-4">
            <el-select v-model="perspective" placeholder="请选择您的立场" class="w-full" filterable allow-create>
              <el-option
                v-for="party in allPotentialParties"
                :key="party"
                :label="party"
                :value="party"
              ></el-option>
            </el-select>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow-md p-6 flex flex-col justify-between">
          <div>
            <h3 class="text-lg font-semibold text-text-dark">2. 确认审查范围</h3>
            <p class="text-sm text-text-light mt-1">默认已全选AI建议的审查点。</p>
            <div class="mt-4">
              <label class="block text-sm font-medium text-text-main mb-1">审查模板</label>
              <el-select v-model="selectedTemplateId" placeholder="选择审查模板" class="w-full" @change="handleTemplateChange">
                <el-option
                  v-for="template in reviewTemplates"
                  :key="template.id"
                  :label="template.name"
                  :value="template.id"
                />
              </el-select>
            </div>
          </div>
          <div class="mt-6 flex justify-end space-x-3">
            <button @click="goBackToUpload" class="px-4 py-2 text-sm font-medium text-text-main bg-white border border-border-color rounded-md hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary">
              重新上传
            </button>
            <button @click="startAnalysis" :disabled="!perspective" class="px-6 py-2 text-sm font-medium text-white bg-primary border border-transparent rounded-md shadow-sm hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed">
              开始分析
            </button>
          </div>
        </div>
      </div>

      <div class="review-options-panel bg-white rounded-lg shadow-md p-6 mt-8">
        <h3 class="text-lg font-semibold text-text-dark mb-4">审查点及核心目的</h3>
        <div class="mb-6">
          <h4 class="text-md font-medium text-text-dark mb-2">审查点选择 (可多选)</h4>
          <el-checkbox-group v-model="selectedReviewPoints" class="review-points-group flex flex-wrap gap-3">
            <el-checkbox
              v-for="point in allSuggestedReviewPoints"
              :key="point"
              :label="point"
              :value="point"
              border
            ></el-checkbox>
          </el-checkbox-group>
        </div>
        <div>
          <h4 class="text-md font-medium text-text-dark mb-2">审查核心目的 (可自定义)</h4>
          <div v-for="(purpose, index) in customPurposes" :key="index" class="purpose-row flex items-center mb-2">
            <el-autocomplete
              v-model="purpose.value"
              :fetch-suggestions="querySearchCorePurposes"
              placeholder="搜索或输入新目的"
              class="w-full"
              trigger-on-focus
            ></el-autocomplete>
            <button @click="removePurpose(index)" class="ml-2 text-gray-400 hover:text-danger">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>
          </div>
          <button @click="addPurpose" class="mt-2 text-sm font-medium text-primary hover:text-primary-dark flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            添加目的
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { inject } from 'vue';
import { ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElInput, ElAutocomplete } from 'element-plus';

export default {
  name: 'SettingsStep',
  components: { ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElInput, ElAutocomplete },
  setup() {
    const review = inject('review');
    const {
      contract, preAnalysisData, preAnalysisConfirmation, perspective, showContractPreview,
      contractPreviewText, allPotentialParties, reviewTemplates,
      selectedTemplateId, selectedReviewPoints, allSuggestedReviewPoints,
      customPurposes, querySearchCorePurposes, goBackToUpload,
      startAnalysis, addPurpose, removePurpose, handleTemplateChange,
    } = review;

    const confidenceLabel = (confidence, score) => {
      const labels = { high: '高置信度', medium: '中置信度', low: '低置信度', unknown: '置信度未记录' };
      const suffix = typeof score === 'number' ? ` · ${Math.round(score * 100)}%` : '';
      return `${labels[confidence] || labels.unknown}${suffix}`;
    };
    const scenarioName = (item) => (typeof item === 'string' ? item : item?.name || item?.label || '');
    const templateName = (item) => item?.template_name || item?.name || item?.title || '';
    const templateReason = (item) => {
      if (!item) return '';
      if (Array.isArray(item.reasons)) return item.reasons.slice(0, 2).join('；');
      return item.reason || item.match_reason || '';
    };

    return {
      contract, preAnalysisData, preAnalysisConfirmation, perspective, showContractPreview,
      contractPreviewText, allPotentialParties, reviewTemplates,
      selectedTemplateId, selectedReviewPoints, allSuggestedReviewPoints,
      customPurposes, querySearchCorePurposes, goBackToUpload,
      startAnalysis, addPurpose, removePurpose, handleTemplateChange,
      confidenceLabel, scenarioName, templateName, templateReason,
    };
  },
};
</script>

<style scoped>
.confirm-step {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  padding-left: 16px;
  padding-right: 16px;
  padding-bottom: 28px !important;
}

.confirm-step > div > .text-center {
  max-width: 760px;
  margin-right: auto;
  margin-left: auto;
  padding: 22px 24px;
  border: 1px solid var(--tp-line);
  border-radius: 16px;
  background: linear-gradient(135deg, #fff 0%, var(--tp-accent-subtle) 145%);
  box-shadow: var(--tp-shadow-sm);
}

.confirm-step :deep(.bg-white) {
  border: 1px solid var(--tp-line);
  border-radius: 16px;
  box-shadow: var(--tp-shadow-sm);
}

.recognition-panel {
  margin-bottom: 28px;
  padding: 22px;
  border: 1px solid var(--tp-line);
  border-radius: 16px;
  background: #fff;
  box-shadow: var(--tp-shadow-sm);
}

.recognition-panel__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--tp-line);
}

.recognition-panel__heading h2 {
  margin: 2px 0 4px;
  color: var(--tp-text-strong);
  font-size: 20px;
  font-weight: 700;
}

.recognition-panel__heading > div > p:last-child,
.recognition-card__evidence {
  color: var(--tp-text-muted);
  font-size: 12px;
  line-height: 1.65;
}

.recognition-panel__eyebrow {
  color: var(--tp-accent);
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .16em;
}

.recognition-panel__status {
  flex: 0 0 auto;
  padding: 6px 10px;
  border: 1px solid #b8e1c8;
  border-radius: 999px;
  color: #14763d;
  background: #eef9f2;
  font-size: 11px;
  font-weight: 700;
}

.recognition-panel__status--warning {
  border-color: #f0cf87;
  color: #8a5a00;
  background: #fff8e8;
}

.recognition-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.recognition-card {
  position: relative;
  min-height: 150px;
  padding: 18px;
  overflow: hidden;
  border: 1px solid #e3e6e8;
  border-radius: 12px;
  background: linear-gradient(160deg, #fff 50%, #f6f7f7 100%);
}

.recognition-card__number {
  position: absolute;
  right: 12px;
  top: 8px;
  color: rgba(214, 0, 46, .09);
  font-family: Georgia, serif;
  font-size: 38px;
  font-weight: 700;
}

.recognition-card__label {
  margin-bottom: 18px;
  color: var(--tp-accent);
  font-size: 11px;
  font-weight: 700;
}

.recognition-card strong {
  display: block;
  padding-right: 18px;
  color: #202426;
  font-size: 15px;
  line-height: 1.5;
}

.recognition-card__meta,
.recognition-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.recognition-card__meta span,
.recognition-card__chips span {
  padding: 3px 7px;
  border-radius: 6px;
  color: #596168;
  background: #f0f2f3;
  font-size: 10px;
}

.recognition-card__evidence {
  margin-top: 10px;
}

.recognition-panel__notice {
  margin-top: 14px;
  padding: 10px 12px;
  border-left: 3px solid #d99b16;
  color: #7b5100;
  background: #fff9ec;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 900px) {
  .recognition-grid { grid-template-columns: 1fr; }
  .recognition-card { min-height: 0; }
}

.confirm-step :deep(button) {
  border-radius: var(--tp-radius-control);
}

.confirm-step :deep(.el-checkbox.is-bordered) {
  border-radius: 10px;
}

.confirm-step :deep(.el-input__wrapper),
.confirm-step :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--tp-line) inset;
}

.confirm-step :deep(.el-input__wrapper.is-focus),
.confirm-step :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--tp-accent) inset, 0 0 0 3px rgba(214, 0, 46, .11);
}

.review-options-panel {
  overflow: visible;
}

.review-points-group {
  max-height: none;
  overflow: visible;
  align-items: flex-start;
}

.purpose-row {
  min-width: 0;
}

.purpose-row :deep(.el-autocomplete) {
  min-width: 0;
}
</style>
