<template>
  <main class="home-page">
    <section class="hero-section">
      <div class="hero-architecture" aria-hidden="true">
        <span class="signal signal-one"></span>
        <span class="signal signal-two"></span>
        <span class="signal signal-three"></span>
        <span class="horizon"></span>
      </div>
      <div class="hero-content">
        <p class="eyebrow">THINK OPEN · LEGAL WORKSPACE</p>
        <h1>合同审查，从上传到终稿。</h1>
        <p class="hero-copy">基于思库法务助手所绑定的合同模板与法律知识，完成审核、修订、复审与终稿交付。</p>
        <div class="hero-actions">
          <button class="primary-button" @click="startNewReview">开始新审查 <span>→</span></button>
          <span class="knowledge-note"><i></i>法务助手知识库已绑定</span>
        </div>
      </div>
      <div class="hero-side-note">
        <strong>WEKNORA</strong>
        <span>ONLYOFFICE · DOCX</span>
      </div>
    </section>

    <section class="evidence-strip" aria-label="审查依据">
      <article>
        <span>01</span>
        <div><strong>合同范本库</strong><small>思库七类业务审查模板</small></div>
      </article>
      <article>
        <span>02</span>
        <div><strong>审查要点库</strong><small>品类要点与通用规则</small></div>
      </article>
      <article>
        <span>03</span>
        <div><strong>法律法规库</strong><small>仅引用已入库有效依据</small></div>
      </article>
      <article>
        <span>04</span>
        <div><strong>司法案例库</strong><small>实务后果与裁判逻辑</small></div>
      </article>
    </section>

    <section class="content-grid">
      <div class="workflow-panel">
        <div class="section-head">
          <p class="eyebrow">审查步骤</p>
          <h2>四步完成审查</h2>
        </div>
        <div class="workflow-list">
          <article v-for="item in workflow" :key="item.title" class="workflow-item" :style="{ '--accent': item.color }">
            <span>{{ item.step }}</span>
            <div>
              <h3>{{ item.title }}</h3>
              <p>{{ item.copy }}</p>
            </div>
          </article>
        </div>
      </div>

      <div class="history-panel">
        <div class="section-head history-head">
          <div>
            <p class="eyebrow">审查记录</p>
            <h2>最近处理的合同</h2>
          </div>
          <button class="secondary-button" @click="fetchHistory">刷新</button>
        </div>

        <!-- 搜索与筛选 -->
        <div v-if="history.length > 0" class="history-filters">
          <input
            v-model="searchKeyword"
            class="history-search-input"
            type="text"
            placeholder="按文件名搜索..."
          />
          <select v-model="statusFilter" class="history-filter-select">
            <option value="">全部状态</option>
            <option value="Reviewed">已完成</option>
            <option value="Uploaded">已上传</option>
            <option value="PreAnalyzed">待确认</option>
          </select>
          <select v-model="typeFilter" class="history-filter-select">
            <option value="">全部类型</option>
            <option v-for="t in availableContractTypes" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div v-if="loading" class="empty-block">正在加载审查记录...</div>
        <div v-else-if="error" class="empty-block danger">{{ error }}</div>
        <div v-else-if="history.length === 0" class="empty-block">
          <h3>暂无审查记录</h3>
          <p>上传第一份合同，建立可追溯的审查记录。</p>
          <button class="empty-cta" @click="startNewReview">上传合同</button>
        </div>
        <div v-else-if="filteredHistory.length === 0" class="empty-block">
          <h3>未匹配到记录</h3>
          <p>请调整搜索关键词或筛选条件。</p>
        </div>
        <HistoryTable
          v-else
          :items="pagedHistory"
          :page="historyPage"
          :total-pages="totalHistoryPages"
          @view="viewReport"
          @delete="deleteReport"
          @update:page="historyPage = $event"
        />
      </div>
    </section>

    <GroupReportModal
      :visible="groupReportVisible"
      :loading="groupReportLoading"
      :report="groupReport"
      @close="closeGroupReport"
    />
  </main>
</template>

<script>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import api from '../api';
import GroupReportModal from '../components/GroupReportModal.vue';
import HistoryTable from '../components/HistoryTable.vue';
import { useHomeHistory, formatDate, statusText } from '../composables/useHomeHistory';

export default {
  name: 'HomeView',
  components: { GroupReportModal, HistoryTable },
  setup() {
    const router = useRouter();
    const groupReportVisible = ref(false);
    const groupReportLoading = ref(false);
    const groupReport = ref(null);

    const {
      history, loading, error, historyPage,
      searchKeyword, statusFilter, typeFilter,
      availableContractTypes, filteredHistory, totalHistoryPages, pagedHistory,
      fetchHistory, deleteReport,
    } = useHomeHistory();

    const viewReport = async (item) => {
      if (item.record_type !== 'group') {
        router.push({ path: '/review', query: { contract_id: item.id } });
        return;
      }
      groupReportVisible.value = true;
      groupReportLoading.value = true;
      groupReport.value = null;
      try {
        const response = await api.getContractGroup(item.id);
        groupReport.value = response.data;
      } catch (err) {
        ElMessage.error('加载关联合同分析报告失败。');
        groupReportVisible.value = false;
      } finally {
        groupReportLoading.value = false;
      }
    };

    const closeGroupReport = () => {
      groupReportVisible.value = false;
      groupReport.value = null;
    };

    const startNewReview = () => {
      localStorage.removeItem('review_session');
      router.push({ path: '/review' });
    };

    const workflow = [
      { step: '01', title: '上传合同', color: '#d6002e', copy: '选择文件，进入合同预览。' },
      { step: '02', title: '确认范围', color: '#5e6160', copy: '确认品类、立场与审查重点。' },
      { step: '03', title: '依据对标', color: '#d6002e', copy: '核对范本、法规、案例与要点。' },
      { step: '04', title: '形成意见', color: '#5e6160', copy: '输出可用于会审的修改方案。' },
    ];

    return {
      workflow,
      history, loading, error, historyPage,
      groupReportVisible, groupReportLoading, groupReport,
      totalHistoryPages, pagedHistory,
      fetchHistory, formatDate, statusText,
      viewReport, closeGroupReport, deleteReport, startNewReview,
      searchKeyword, statusFilter, typeFilter,
      availableContractTypes, filteredHistory,
    };
  },
};
</script>

<style scoped>
.home-page {
  min-height: calc(100vh - 64px);
  overflow-x: hidden;
  background: transparent;
  color: var(--za-ink);
  font-size: 13px;
}

.hero-section {
  position: relative;
  width: calc(100% - 36px);
  max-width: 1280px;
  height: 224px;
  margin: 18px auto 0;
  border: 1px solid #2f3130;
  border-radius: 22px;
  overflow: hidden;
  display: flex;
  align-items: stretch;
  background: linear-gradient(112deg, #141514 0%, #232524 64%, #311018 100%);
  box-shadow: 0 18px 44px rgba(20, 21, 20, .16);
}

.hero-architecture {
  position: absolute;
  inset: 0;
  overflow: hidden;
  opacity: .88;
}

.hero-architecture::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 78% 32%, rgba(214, 0, 46, .28), transparent 24%),
    linear-gradient(90deg, rgba(20, 21, 20, .98) 0%, rgba(35, 37, 36, .86) 53%, rgba(214, 0, 46, .05) 86%),
    repeating-linear-gradient(90deg, transparent 0 46px, rgba(255,255,255,.045) 46px 47px),
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(255,255,255,.03) 31px 32px);
}

.signal {
  position: absolute;
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 50%;
  box-shadow: inset 0 0 0 12px rgba(255, 255, 255, .025);
}

.signal-one { right: -18px; top: -112px; width: 340px; height: 340px; }
.signal-two { right: 115px; bottom: -154px; width: 260px; height: 260px; }
.signal-three { right: 300px; top: 52px; width: 18px; height: 18px; border-color: #ec5b78; background: #d6002e; box-shadow: 0 0 0 8px rgba(214, 0, 46, .16); }

.horizon {
  position: absolute;
  right: -5%;
  bottom: 30px;
  width: 47%;
  height: 1px;
  background: rgba(236, 91, 120, .8);
  transform: rotate(-10deg);
}

.hero-content {
  position: relative;
  z-index: 1;
  max-width: 820px;
  padding: 29px 44px;
  color: #ffffff;
}

.eyebrow {
  margin: 0 0 12px;
  color: #f39aaf;
  opacity: 1;
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .19em;
}

h1, h2, h3, p {
  letter-spacing: 0;
}

h1 {
  margin: 0;
  font-size: clamp(30px, 3.5vw, 44px);
  line-height: 1.08;
  font-weight: 700;
  letter-spacing: -.045em;
}

.hero-copy {
  max-width: 660px;
  margin: 12px 0 18px;
  color: rgba(255, 255, 255, 0.84);
  font-size: 13px;
  line-height: 1.8;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 18px;
}

.knowledge-note {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: rgba(255,255,255,.76);
  font-size: 11px;
}

.knowledge-note i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #22a559;
  box-shadow: 0 0 0 4px rgba(34, 165, 89, .16);
}

.hero-side-note {
  position: absolute;
  right: 28px;
  bottom: 24px;
  z-index: 1;
  display: grid;
  justify-items: end;
  gap: 2px;
  color: rgba(255,255,255,.58);
  font-size: 9px;
  letter-spacing: .12em;
}

.hero-side-note strong {
  color: #f39aaf;
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-size: 13px;
}

button {
  border: 0;
  border-radius: 10px;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.primary-button,
.secondary-button {
  min-height: 34px;
  padding: 0 13px;
}

.primary-button {
  display: inline-flex;
  align-items: center;
  gap: 18px;
  background: #d6002e;
  color: #fff;
  box-shadow: 0 1px 2px rgba(118, 0, 26, .4), 0 6px 16px rgba(214, 0, 46, .24);
}

.primary-button span {
  font-size: 16px;
}

.secondary-button {
  background: #ffffff;
  color: var(--tp-text-muted);
  box-shadow: inset 0 0 0 1px var(--za-line);
}

.content-grid {
  height: calc(100vh - 390px);
  max-width: 1280px;
  margin: 14px auto 0;
  padding: 0 18px 12px;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 14px;
}

.evidence-strip {
  width: calc(100% - 36px);
  max-width: 1280px;
  min-height: 64px;
  margin: 10px auto 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--za-line);
  border-radius: 16px;
  background: #fff;
  box-shadow: var(--tp-shadow-sm);
  overflow: hidden;
}

.evidence-strip article {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  padding: 10px 15px;
}

.evidence-strip article + article {
  border-left: 1px solid var(--za-line);
}

.evidence-strip span {
  color: var(--tp-accent);
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-size: 17px;
}

.evidence-strip div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.evidence-strip strong {
  color: var(--za-ink);
  font-family: inherit;
  font-size: 13px;
  letter-spacing: .04em;
}

.evidence-strip small {
  overflow: hidden;
  color: var(--za-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-panel,
.history-panel {
  min-height: 0;
  border: 1px solid var(--za-line);
  border-radius: 16px;
  padding: 18px;
  background: #ffffff;
  box-shadow: var(--tp-shadow-sm);
}

.section-head {
  margin-bottom: 10px;
}

.section-head h2 {
  margin: 0;
  font-family: inherit;
  font-size: 20px;
  letter-spacing: .04em;
  line-height: 1.24;
}

.history-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}

.workflow-list {
  display: grid;
  gap: 8px;
}

.workflow-item {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  position: relative;
  border-radius: 12px;
  padding: 10px;
  background: var(--tp-bg-muted);
  box-shadow: inset 0 0 0 1px var(--za-line);
}

.workflow-item span {
  color: var(--accent);
  font-size: 12px;
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-weight: 700;
}

.workflow-item h3 {
  margin: 0 0 3px;
  font-size: 14px;
  line-height: 1.25;
}

.workflow-item p,
.empty-block {
  margin: 0;
  color: var(--za-muted);
  line-height: 1.45;
}

.empty-block {
  padding: 26px;
  text-align: center;
  background: var(--tp-bg-muted);
  border-radius: 12px;
}

.empty-block h3 {
  margin: 0 0 5px;
  color: var(--za-ink);
  font-size: 16px;
}

.empty-cta {
  min-height: 30px;
  margin-top: 12px;
  padding: 0 14px;
  color: #fff;
  background: var(--tp-accent);
}

.empty-block.danger {
  color: #ef4444;
}

.history-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.history-search-input,
.history-filter-select {
  padding: 6px 10px;
  border: 1px solid var(--za-line);
  border-radius: 10px;
  font-size: 13px;
  outline: none;
  background: #fff;
}

.history-search-input {
  flex: 1;
  min-width: 160px;
}

.history-search-input:focus,
.history-filter-select:focus {
  border-color: var(--za-teal);
}

.history-filter-select {
  cursor: pointer;
}

@media (max-width: 900px) {
  .home-page {
    height: auto;
    overflow: visible;
  }

  .content-grid {
    height: auto;
    grid-template-columns: 1fr;
  }

  .hero-section {
    width: calc(100% - 28px);
  }

  .evidence-strip {
    width: calc(100% - 28px);
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .evidence-strip article:nth-child(3) {
    border-left: 0;
    border-top: 1px solid var(--za-line);
  }

  .evidence-strip article:nth-child(4) {
    border-top: 1px solid var(--za-line);
  }
}

@media (max-width: 560px) {
  .hero-section { height: auto; min-height: 294px; }
  .hero-content { width: 100%; padding: 26px 22px; }
  .hero-actions { align-items: flex-start; flex-direction: column; gap: 10px; }
  .primary-button { min-height: 42px; }
  .hero-side-note { display: none; }
  .evidence-strip { grid-template-columns: 1fr; }
  .evidence-strip article + article { border-left: 0; border-top: 1px solid var(--za-line); }
}
</style>
