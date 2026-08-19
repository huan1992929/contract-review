<template>
  <div>
    <div v-if="suggestions.length" class="mb-3 flex items-center justify-between gap-2">
      <div class="suggestion-indexes" role="group" aria-label="修改建议快速定位与处理状态">
        <button
          v-for="(item, index) in suggestions"
          :key="'select-ms-' + index"
          type="button"
          :class="['suggestion-index', suggestionIndexClass(item, index)]"
          :title="suggestionIndexLabel(item, index)"
          :aria-label="suggestionIndexLabel(item, index)"
          :aria-pressed="isSuggestionExpanded(index)"
          :aria-controls="`suggestion-card-${index}`"
          @click="activateSuggestion(item, index)"
        >
          <span>{{ index + 1 }}</span>
        </button>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="isPdfContract" class="text-xs text-amber-600">PDF 不支持采纳</span>
        <button @click="applyAllSuggestions" :disabled="batchApplying || isPdfContract || !hasUnresolvedSuggestions" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed">
          {{ batchApplying ? (reviewApplyMode === 'review' ? '正在修订全部风险...' : '正在编辑全部风险...') : (reviewApplyMode === 'review' ? '一键修订全部风险' : '一键编辑全部风险') }}
        </button>
      </div>
    </div>
    <div v-if="suggestions.length" class="space-y-3">
      <article
        v-for="(item, index) in suggestions"
        :id="`suggestion-card-${index}`"
        :key="'ms-' + index"
        :class="['suggestion-card', isSuggestionExpanded(index) ? 'is-expanded' : '', isSuggestionResolved(item) ? 'is-resolved' : '']"
      >
        <div class="suggestion-card__header">
          <button
            type="button"
            class="suggestion-card__toggle"
            :aria-expanded="isSuggestionExpanded(index)"
            :aria-controls="`suggestion-body-${index}`"
            @click="toggleSuggestion(item, index)"
          >
            <span :class="['suggestion-card__number', suggestionIndexClass(item, index)]" aria-hidden="true">{{ index + 1 }}</span>
            <span class="suggestion-card__heading">
              <span class="suggestion-card__title">{{ suggestionTitle(item, index) }}</span>
              <span class="suggestion-card__status">{{ suggestionStatusLabel(item, index) }}</span>
            </span>
            <svg :class="['suggestion-card__chevron', isSuggestionExpanded(index) ? 'is-open' : '']" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div class="flex space-x-1 flex-shrink-0">
            <el-tooltip v-if="!isMissingClauseSuggestion(item)" content="在文档中定位" placement="top">
              <button type="button" @click="locateText(suggestionOriginal(item), item)" class="p-1 text-gray-400 hover:text-primary transition-colors" :aria-label="`定位第 ${index + 1} 项原文`">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              </button>
            </el-tooltip>
            <el-tooltip v-if="!isMissingClauseSuggestion(item)" content="添加批注" placement="top">
              <button type="button" @click="addDocComment(suggestionOriginal(item), suggestionReason(item), item)" class="p-1 text-gray-400 hover:text-primary transition-colors" :aria-label="`为第 ${index + 1} 项添加批注`">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
              </button>
            </el-tooltip>
          </div>
        </div>

        <div v-show="isSuggestionExpanded(index)" :id="`suggestion-body-${index}`" class="suggestion-card__body">
        <div v-if="showPlainLanguage" class="mt-3 p-3 bg-green-50 text-green-800 rounded-md border-l-4 border-green-400">
          <p class="text-xs font-bold mb-1">📢 大白话建议：</p>
          <p class="text-sm">{{ item.plain_language || suggestionReason(item) }}</p>
        </div>

        <div v-else class="space-y-3 mt-3">
          <div class="text-xs">
            <p class="text-gray-500 font-medium">原文：</p>
            <blockquote class="mt-1 p-2 bg-red-50 text-red-800 border-l-4 border-red-400 break-all">
              {{ suggestionOriginal(item) || 'AI 未返回可直接定位的原文，请参考建议条款手动核对。' }}
            </blockquote>
          </div>
          <div class="text-xs">
            <p class="text-gray-500 font-medium">建议：</p>
            <blockquote
              :title="item.adopted ? `采纳前原文：${item.adopted_original || suggestionOriginal(item)}` : ''"
              :class="[
                'mt-1 p-2 text-green-800 border-l-4 border-green-400 break-all',
                item.adopted ? 'adopted-suggestion-text' : 'bg-green-50'
              ]"
            >
              {{ suggestionText(item) }}
            </blockquote>
          </div>
          <div class="text-xs">
            <p class="text-gray-500 font-medium">理由：</p>
            <p class="mt-1 text-text-main">{{ suggestionReason(item) }}</p>
          </div>
          <div v-if="suggestionCitations(item).length" class="text-xs">
            <p class="text-gray-500 font-medium">法律依据：</p>
            <div v-for="(cite, cIndex) in suggestionCitations(item)" :key="'cite-' + index + '-' + cIndex" class="mt-1 p-2 bg-blue-50 border-l-4 border-blue-300 rounded">
              <p class="font-medium text-blue-800">【{{ cite.source_type || '依据' }}】{{ cite.title || '' }}{{ cite.clause ? ' ' + cite.clause : '' }}</p>
              <p v-if="cite.content" class="mt-0.5 text-blue-700">{{ cite.content }}</p>
            </div>
          </div>
        </div>

        <div class="mt-4 pt-3 border-t border-gray-100 flex justify-end items-center">
          <span v-if="isPdfContract" class="mr-2 text-xs text-amber-600">PDF 文件不支持原文改写，请使用审查报告导出或 PDF 批注</span>
          <button
            @click="toggleNegotiation(item)"
            :disabled="item._negotiationLoading"
            :class="[
              'mr-2 px-3 py-1.5 text-xs font-medium border rounded transition-colors flex items-center disabled:opacity-50',
              item._negotiation
                ? 'text-green-700 bg-green-50 border-green-300 hover:bg-green-100'
                : 'text-purple-700 bg-purple-50 border-purple-300 hover:bg-purple-100'
            ]"
            :title="item._negotiationError ? '上次推演失败，点击重试' : (item._negotiation ? '已推演过，点击查看或收起' : '点击进行谈判推演')"
          >
            <svg v-if="item._negotiationLoading" class="animate-spin h-3.5 w-3.5 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            <svg v-else-if="item._negotiation" class="h-3.5 w-3.5 mr-1 text-green-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
            {{ item._negotiationLoading ? '推演中...' : (item._negotiationError ? '重新推演' : (item._showNegotiation && item._negotiation ? '收起推演' : (item._negotiation ? '已推演·查看' : '谈判推演'))) }}
          </button>
          <button @click="previewSuggestion(item)" class="mr-2 px-3 py-1.5 text-xs font-medium text-primary bg-white border border-primary rounded hover:bg-primary-light transition-colors">
            {{ item._showPreview ? '收起变更' : '查看变更' }}
          </button>
          <button @click="adoptSuggestion(item, index)" :disabled="isPdfContract || isSuggestionApplied(item) || item._applying" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
            {{ suggestionActionLabel(item) }}
          </button>
        </div>
        <div v-if="item._showPreview" class="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-3 text-xs">
          <div class="rounded border border-red-100 bg-red-50 p-3">
            <p class="font-semibold text-red-700">修改前</p>
            <p class="mt-1 whitespace-pre-line leading-5 text-red-800">{{ suggestionOriginal(item) || '暂无可展示原文' }}</p>
          </div>
          <div class="rounded border border-green-100 bg-green-50 p-3">
            <p class="font-semibold text-green-700">修改后</p>
            <p class="mt-1 whitespace-pre-line leading-5 text-green-800">{{ suggestionText(item) || '暂无可展示建议' }}</p>
          </div>
        </div>
        <!-- 4.1 谈判推演面板 -->
        <div v-if="item._showNegotiation && item._negotiation" class="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-md space-y-3">
          <div class="flex items-center gap-2 text-xs text-purple-800 font-semibold">
            <span>对方立场:{{ item._negotiation.counterparty_perspective }}</span>
          </div>
          <!-- 对方反驳 -->
          <div>
            <p class="text-xs font-bold text-red-700 mb-1">对方可能反驳:</p>
            <div v-for="(obj, oi) in item._negotiation.likely_objections" :key="'obj-' + oi" class="text-xs mb-1 p-2 bg-white border border-red-100 rounded">
              <p class="text-text-main">{{ obj.reason }}</p>
              <p v-if="obj.legal_basis && obj.legal_basis !== '无明确依据'" class="mt-0.5 text-gray-600">依据:{{ obj.legal_basis }}</p>
              <p v-if="obj.business_concern" class="mt-0.5 text-gray-600">顾虑:{{ obj.business_concern }}</p>
            </div>
          </div>
          <!-- 折中方案 -->
          <div>
            <p class="text-xs font-bold text-amber-700 mb-1">折中方案:</p>
            <div v-for="(opt, oi) in item._negotiation.fallback_options" :key="'opt-' + oi" class="text-xs mb-2 p-2 bg-white border border-amber-100 rounded">
              <p class="text-text-main font-medium">{{ opt.text }}</p>
              <p class="mt-1 text-gray-600">让步:{{ opt.tradeoff }}</p>
              <p class="mt-0.5 text-gray-600">风险变化:{{ opt.risk_change }}</p>
              <button
                @click="adoptFallbackOption(item, opt)"
                class="mt-1 px-2 py-0.5 text-xs font-medium text-amber-700 bg-amber-100 border border-amber-300 rounded hover:bg-amber-200"
              >采纳此折中方案</button>
            </div>
          </div>
          <!-- 谈判话术 -->
          <div>
            <p class="text-xs font-bold text-blue-700 mb-1">谈判话术:</p>
            <p class="text-xs text-text-main leading-relaxed p-2 bg-white border border-blue-100 rounded whitespace-pre-line">{{ item._negotiation.negotiation_talktrack }}</p>
          </div>
        </div>
        <div v-else-if="item._showNegotiation && item._negotiationError" class="mt-3 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          谈判推演失败:{{ item._negotiationError }}
        </div>
        </div>
      </article>
    </div>
    <div v-else class="text-center text-text-light py-8">未发现修改建议</div>
  </div>
</template>

<script>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { ElTooltip } from 'element-plus';

export default {
  name: 'ReviewSuggestionsTab',
  components: { ElTooltip },
  setup() {
    const review = inject('review');
    const {
      reviewData, showPlainLanguage, reviewApplyMode, isPdfContract,
      batchApplying,
      suggestionTitle, suggestionOriginal, suggestionText, suggestionReason, suggestionCitations, isMissingClauseSuggestion,
      locateText, addDocComment, previewSuggestion, adoptSuggestion,
      applyAllSuggestions, isSuggestionApplied, suggestionApplicationStatus, toggleNegotiation, adoptFallbackOption,
      normalizeSeverity,
    } = review;

    const highRiskPattern = /(违约|解除|终止|付款|结算|价款|总价|金额|争议解决|仲裁|诉讼|保修|工期|安全|保险|单方|责任不对等)/;
    const suggestions = computed(() => Array.isArray(reviewData.modification_suggestions)
      ? reviewData.modification_suggestions
      : []);
    const expandedSuggestionIndexes = ref([]);
    const hasUnresolvedSuggestions = computed(() => suggestions.value.some((item) => !isSuggestionApplied(item)));
    const isSuggestionResolved = (item) => ['pending_review', 'accepted', 'applied'].includes(suggestionApplicationStatus(item));
    const suggestionSeverity = (item, index) => {
      const direct = item?.severity || item?.risk_level;
      if (direct) return normalizeSeverity(direct) === 'high' ? 'high' : 'medium';
      const text = [suggestionTitle(item, index), suggestionOriginal(item), suggestionReason(item)].filter(Boolean).join(' ');
      return highRiskPattern.test(text) ? 'high' : 'medium';
    };
    const suggestionIndexClass = (item, index) => {
      if (isSuggestionResolved(item)) return 'suggestion-index--resolved';
      return suggestionSeverity(item, index) === 'high'
        ? 'suggestion-index--high'
        : 'suggestion-index--medium';
    };
    const suggestionIndexLabel = (item, index) => {
      const status = suggestionStatusLabel(item, index);
      return `第 ${index + 1} 项，${status}：${suggestionTitle(item, index)}`;
    };
    const suggestionStatusLabel = (item, index) => {
      const status = suggestionApplicationStatus(item);
      if (status === 'pending_review') return '已处理·待确认';
      if (['accepted', 'applied'].includes(status)) return '已生效';
      if (status === 'rejected') return '已拒绝·待处理';
      return suggestionSeverity(item, index) === 'high' ? '高风险' : '中风险';
    };
    const suggestionActionLabel = (item) => {
      if (item?._applying) return '处理中...';
      const status = suggestionApplicationStatus(item);
      if (status === 'pending_review') return '已处理·待确认';
      if (['accepted', 'applied'].includes(status)) return '已生效';
      const retryPrefix = status === 'rejected' ? '重新' : '';
      if (isMissingClauseSuggestion(item)) {
        return reviewApplyMode.value === 'review' ? `${retryPrefix}新增修订` : `${retryPrefix}新增至合同`;
      }
      return reviewApplyMode.value === 'review' ? `${retryPrefix}加入审阅修订` : `${retryPrefix}直接编辑`;
    };
    const isSuggestionExpanded = (index) => expandedSuggestionIndexes.value.includes(index);
    const scrollSuggestionIntoView = async (index) => {
      await nextTick();
      document.getElementById(`suggestion-card-${index}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    };
    const expandAndLocateSuggestion = async (item, index) => {
      if (!isSuggestionExpanded(index)) {
        expandedSuggestionIndexes.value = [...expandedSuggestionIndexes.value, index];
      }
      await scrollSuggestionIntoView(index);
      if (isMissingClauseSuggestion(item)) {
        const suggested = suggestionText(item);
        const clauseHeading = suggested.match(/(?:^|\n)\s*(第[一二三四五六七八九十百零〇\d]+条[^\n。；]{0,24}|\d+(?:\.\d+)+\s*[^\n。；]{0,24})/)?.[1]?.trim();
        const anchor = item.anchor_hint
          || item.anchorHint
          || item.parent_clause
          || item.target_section
          || item.section_title
          || clauseHeading
          || suggestionTitle(item, index);
        if (anchor) await locateText(anchor, { ...item, anchor_hint: anchor });
      } else {
        await locateText(suggestionOriginal(item), item);
      }
    };
    const activateSuggestion = async (item, index) => {
      await expandAndLocateSuggestion(item, index);
    };
    const toggleSuggestion = async (item, index) => {
      if (isSuggestionExpanded(index)) {
        expandedSuggestionIndexes.value = expandedSuggestionIndexes.value.filter((value) => value !== index);
        return;
      }
      await expandAndLocateSuggestion(item, index);
    };

    watch(
      () => suggestions.value.length,
      (length) => {
        expandedSuggestionIndexes.value = expandedSuggestionIndexes.value.filter((index) => index < length);
      },
    );
    return {
      reviewData, suggestions, showPlainLanguage, reviewApplyMode, isPdfContract,
      batchApplying, hasUnresolvedSuggestions,
      suggestionTitle, suggestionOriginal, suggestionText, suggestionReason, suggestionCitations, isMissingClauseSuggestion,
      locateText, addDocComment, previewSuggestion, adoptSuggestion,
      applyAllSuggestions, isSuggestionApplied, isSuggestionResolved, toggleNegotiation, adoptFallbackOption,
      suggestionIndexClass, suggestionIndexLabel, suggestionStatusLabel, suggestionActionLabel,
      isSuggestionExpanded, activateSuggestion, toggleSuggestion,
    };
  },
};
</script>

<style scoped>
.suggestion-indexes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.suggestion-index {
  position: relative;
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}

.suggestion-index--high {
  border-color: #ef9a9a;
  background: #fde8e8;
  color: #a82b2b;
}

.suggestion-index--medium {
  border-color: #e8c36b;
  background: #fff3cf;
  color: #8a5b00;
}

.suggestion-index--resolved {
  border-color: #78c7a3;
  background: #e2f5e9;
  color: #20764b;
}

.suggestion-index:hover {
  transform: translateY(-1px);
}

.suggestion-index:focus-visible {
  outline: 2px solid #008f87;
  outline-offset: 2px;
}

.suggestion-card {
  overflow: hidden;
  border: 1px solid #dbe5e1;
  border-radius: 8px;
  background: #f9fbfa;
  scroll-margin-top: 12px;
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}

.suggestion-card:hover,
.suggestion-card.is-expanded {
  border-color: #b8cec6;
  box-shadow: 0 7px 22px rgba(22, 59, 55, 0.07);
}

.suggestion-card.is-resolved {
  border-color: #b9dbc9;
  background: #fbfdfc;
}

.suggestion-card__header {
  display: flex;
  align-items: center;
  min-height: 58px;
  padding: 9px 12px;
  gap: 8px;
}

.suggestion-card__toggle {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 11px;
  border-radius: 5px;
  text-align: left;
}

.suggestion-card__toggle:focus-visible {
  outline: 2px solid #008f87;
  outline-offset: 3px;
}

.suggestion-card__number {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 750;
  line-height: 1;
}

.suggestion-card__heading {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: baseline;
  gap: 9px;
}

.suggestion-card__title {
  overflow: hidden;
  color: #163b37;
  font-size: 14px;
  font-weight: 650;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion-card__status {
  flex: none;
  color: #72847e;
  font-size: 11px;
  font-weight: 500;
}

.suggestion-card__chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: #81918c;
  transition: transform 160ms ease, color 160ms ease;
}

.suggestion-card__chevron.is-open {
  color: #008f87;
  transform: rotate(180deg);
}

.suggestion-card__body {
  padding: 0 14px 14px 53px;
  border-top: 1px solid rgba(219, 229, 225, 0.72);
}

@media (max-width: 900px) {
  .suggestion-card__heading {
    display: block;
  }

  .suggestion-card__status {
    display: block;
    margin-top: 2px;
  }

  .suggestion-card__body {
    padding-left: 14px;
  }
}
</style>

<style scoped>
.adopted-suggestion-text {
  background: #fef3c7 !important;
  border-color: #f59e0b !important;
  color: #166534 !important;
  box-shadow: inset 0 0 0 1px #facc15;
  cursor: help;
}
</style>
