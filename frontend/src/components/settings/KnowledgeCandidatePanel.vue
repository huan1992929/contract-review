<template>
  <section class="candidate-panel">
    <header class="panel-head">
      <div>
        <p class="kicker">FOREIGN MATERIAL GOVERNANCE</p>
        <h2>境外法规与案例候选审批</h2>
        <p>候选资料不参与合同审查检索。仅当官方全文、哈希、时效与版本核验完整，并由法务审批通过后，才复制到正式知识库。</p>
      </div>
      <el-button :loading="loading" @click="loadCandidates">刷新</el-button>
    </header>

    <div class="summary-row">
      <span>候选 {{ total }} 项</span>
      <span>完整性就绪 {{ summary.ready || 0 }} 项</span>
      <span>待审批 {{ summary.official_candidate || 0 }} 项</span>
      <span>已通过 {{ summary.legal_verified || 0 }} 项</span>
      <span>已驳回 {{ summary.legal_rejected || 0 }} 项</span>
    </div>

    <el-alert
      v-if="coverageGaps.length"
      type="warning"
      :closable="false"
      title="境外资料尚未完整，不得作为完整法律库对外使用"
    >
      <template #default>
        缺失：{{ missingNames || '无' }}；覆盖较薄：{{ thinNames || '无' }}。数量仅代表官方候选资料，未通过法务审批前不会进入合同审查检索。
      </template>
    </el-alert>
    <div class="coverage-grid">
      <span v-for="entry in coverage" :key="entry.code" :class="entry.status">
        {{ entry.name }} {{ entry.candidates }}
      </span>
    </div>

    <div class="filters">
      <el-input v-model="filters.jurisdiction" clearable placeholder="法域，例如 HK / SG" @keyup.enter="loadCandidates" />
      <el-select v-model="filters.status" clearable placeholder="审批状态">
        <el-option label="待审批" value="official_candidate" />
        <el-option label="已通过" value="legal_verified" />
        <el-option label="已驳回" value="legal_rejected" />
      </el-select>
      <el-select v-model="filters.type" clearable placeholder="资料类型">
        <el-option label="境外法规" value="external_law_candidate" />
        <el-option label="境外案例" value="external_case_candidate" />
      </el-select>
      <el-button type="primary" @click="loadCandidates">筛选</el-button>
    </div>

    <el-alert
      v-if="!canReview"
      type="warning"
      :closable="false"
      title="当前账号没有法务审批权限；可查看候选资料，但不能转入正式知识库。"
    />

    <el-empty v-if="!loading && items.length === 0" description="暂无候选资料" />
    <article v-for="item in items" :key="item.source_id" class="candidate-card">
      <div class="candidate-title">
        <div>
          <span class="jurisdiction">{{ item.metadata?.jurisdiction || '未标注法域' }}</span>
          <h3>{{ item.title }}</h3>
          <p>{{ item.source_name }} · {{ item.metadata?.official_version_date || '版本日期待补充' }}</p>
        </div>
        <span :class="['ready-tag', { ready: item.readiness?.ready }]">
          {{ item.readiness?.ready ? '完整性已就绪' : '完整性未通过' }}
        </span>
      </div>

      <div class="check-grid">
        <span v-for="(ok, key) in item.readiness?.checks" :key="key" :class="{ ok }">
          {{ ok ? '✓' : '×' }} {{ checkLabels[key] || key }}
        </span>
      </div>

      <p class="preview">{{ item.content_preview }}</p>
      <a v-if="item.source_url" :href="item.source_url" target="_blank" rel="noopener noreferrer">打开官方来源</a>

      <div class="verification-form">
        <el-select v-model="drafts[item.source_id].translation_status" placeholder="翻译使用情况">
          <el-option label="仅使用官方原文" value="official_original_only" />
          <el-option label="使用译文" value="translated" />
        </el-select>
        <el-input
          v-model="drafts[item.source_id].translation_provenance"
          :disabled="drafts[item.source_id].translation_status !== 'translated'"
          placeholder="译文来源/译者/审核记录"
        />
        <el-input v-model="drafts[item.source_id].official_version_date" type="date" title="官方版本日期" />
        <el-input v-model="drafts[item.source_id].source_language" placeholder="官方原文语言，例如 en / ja" />
        <el-checkbox v-model="drafts[item.source_id].currentness_verified">已核对现行有效性</el-checkbox>
        <el-input v-model="drafts[item.source_id].currentness_basis" placeholder="时效核验依据（官方页面/版本说明）" />
        <el-input v-model="drafts[item.source_id].note" placeholder="法务审批意见（必填）" />
      </div>
      <div class="actions">
        <el-button :disabled="!canReview" :loading="deciding === item.source_id" @click="decide(item, 'reject')">驳回</el-button>
        <el-button type="primary" :disabled="!canReview" :loading="deciding === item.source_id" @click="decide(item, 'approve')">通过并转入正式库</el-button>
      </div>
    </article>

    <el-pagination
      v-if="total > pageSize"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="total"
      layout="prev, pager, next"
      @current-change="loadCandidates"
    />
  </section>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../../api';
import { authState } from '../../auth';

const legalRoles = new Set(['admin', 'knowledge_admin', 'legal_reviewer']);
const canReview = computed(() => legalRoles.has(String(authState.user?.role || '')));
const loading = ref(false);
const deciding = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const summary = ref({});
const coverage = ref([]);
const items = ref([]);
const drafts = reactive({});
const filters = reactive({ jurisdiction: '', status: '', type: '' });
const coverageGaps = computed(() => coverage.value.filter((item) => item.status !== 'candidate'));
const missingNames = computed(() => coverage.value.filter((item) => item.status === 'missing').map((item) => item.name).join('、'));
const thinNames = computed(() => coverage.value.filter((item) => item.status === 'thin').map((item) => item.name).join('、'));
const checkLabels = {
  official_source: '官方来源', full_text: '官方全文', content_hash: '正文哈希', jurisdiction: '法域',
  validity: '现行有效性', currentness_basis: '时效核验依据', version: '官方版本',
  source_language: '原文语言', translation_provenance: '翻译来源',
};

function initDraft(item) {
  if (drafts[item.source_id]) return;
  const metadata = item.metadata || {};
  drafts[item.source_id] = {
    translation_status: metadata.translation_status || 'official_original_only',
    translation_provenance: metadata.translation_provenance || '',
    official_version_date: metadata.official_version_date || '',
    currentness_verified: metadata.currentness_verified === true,
    currentness_basis: metadata.currentness_basis || '',
    source_language: metadata.source_language || '',
    note: metadata.legal_review_note || '',
  };
}

async function loadCandidates() {
  loading.value = true;
  try {
    const { data } = await api.listKnowledgeCandidates({ page: page.value, pageSize, ...filters });
    items.value = data.items || [];
    total.value = data.total || 0;
    summary.value = data.summary || {};
    coverage.value = data.coverage || [];
    items.value.forEach(initDraft);
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '候选资料加载失败');
  } finally {
    loading.value = false;
  }
}

async function decide(item, decision) {
  const draft = drafts[item.source_id];
  if (!draft.note.trim()) return ElMessage.warning('请填写法务审批意见');
  deciding.value = item.source_id;
  try {
    await api.decideKnowledgeCandidate({
      source_id: item.source_id,
      decision,
      note: draft.note,
      verification: {
        translation_status: draft.translation_status,
        translation_provenance: draft.translation_provenance,
        official_version_date: draft.official_version_date,
        currentness_verified: draft.currentness_verified,
        currentness_basis: draft.currentness_basis,
        source_language: draft.source_language,
      },
    });
    ElMessage.success(decision === 'approve' ? '已通过并转入正式知识库' : '已驳回，仍保留在候选区');
    delete drafts[item.source_id];
    await loadCandidates();
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '审批失败');
  } finally {
    deciding.value = '';
  }
}

loadCandidates();
</script>

<style scoped>
.candidate-panel { padding: 4px 0 24px; }
.panel-head, .candidate-card { border: 1px solid var(--za-line); background: #fff; }
.panel-head { display: flex; justify-content: space-between; gap: 24px; padding: 18px 20px; border-top: 3px solid var(--za-teal); }
.panel-head h2, .candidate-title h3 { margin: 0; color: var(--za-ink); }
.panel-head p, .candidate-title p { margin: 6px 0 0; color: var(--za-muted); line-height: 1.55; }
.kicker { color: var(--za-gold-ink) !important; font: 700 9px Georgia, serif; letter-spacing: .16em; }
.summary-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.summary-row span { padding: 6px 10px; background: #f5faf8; border: 1px solid #d8e8e4; color: var(--za-teal-deep); }
.coverage-grid { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0 14px; }
.coverage-grid span { padding: 5px 8px; border: 1px solid #d8e8e4; background: #f5faf8; color: var(--za-teal-deep); }
.coverage-grid span.thin { border-color: #e4bd72; background: #fff8e8; color: #8b5b00; }
.coverage-grid span.missing { border-color: #ebb4b0; background: #fff1f0; color: #ad3834; }
.filters { display: grid; grid-template-columns: 1fr 180px 180px auto; gap: 10px; margin-bottom: 12px; }
.candidate-card { margin-top: 12px; padding: 18px; box-shadow: 0 8px 24px rgba(23,53,51,.04); }
.candidate-title { display: flex; justify-content: space-between; gap: 16px; }
.jurisdiction { display: inline-block; margin-bottom: 7px; color: var(--za-gold-ink); font-weight: 700; }
.ready-tag { height: fit-content; padding: 5px 8px; background: #fff4e5; color: #9b6300; }
.ready-tag.ready { background: #eaf8f0; color: #227748; }
.check-grid { display: flex; flex-wrap: wrap; gap: 7px; margin: 14px 0; }
.check-grid span { padding: 4px 7px; background: #fff1f0; color: #b13b37; }
.check-grid span.ok { background: #edf8f2; color: #28794d; }
.preview { max-height: 84px; overflow: auto; padding: 10px; background: #f7f9f8; color: #50615f; line-height: 1.6; }
.verification-form { display: grid; grid-template-columns: 190px 1fr 180px; gap: 10px; margin-top: 14px; align-items: center; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
@media (max-width: 900px) { .filters, .verification-form { grid-template-columns: 1fr; } }
</style>
