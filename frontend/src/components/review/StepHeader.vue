<template>
  <div :class="['step-shell bg-white', compact ? 'step-shell--compact' : 'flex-shrink-0']">
    <div class="step-caption">{{ compact ? '任务进度' : 'CONTRACT REVIEW FLOW' }}</div>
    <div class="step-track flex items-center" aria-label="合同审核任务进度">
      <div class="flex items-center text-xs" :class="activeStep >= 0 ? 'text-primary' : 'text-gray-500'">
        <div class="step-dot flex items-center justify-center rounded-full border-2" :class="activeStep >= 0 ? 'border-primary' : 'border-gray-400'">
          <span v-if="activeStep > 0">✓</span><span v-else>1</span>
        </div>
        <span class="step-label ml-1 font-semibold">{{ compact ? '已上传' : '上传合同' }}</span>
      </div>
      <div class="step-line border-t-2" :class="activeStep >= 1 ? 'border-primary' : 'border-gray-300'"></div>
      <div class="flex items-center text-xs" :class="activeStep >= 1 ? 'text-primary' : 'text-gray-500'">
        <div class="step-dot flex items-center justify-center rounded-full border-2" :class="activeStep >= 1 ? 'border-primary' : 'border-gray-400'">
           <span v-if="activeStep > 1">✓</span><span v-else>2</span>
        </div>
        <span class="step-label ml-1 font-semibold">{{ compact ? '已分析' : '确认信息并分析' }}</span>
      </div>
      <div class="step-line border-t-2" :class="activeStep >= 2 ? 'border-primary' : 'border-gray-300'"></div>
      <div class="flex items-center text-xs" :class="activeStep >= 2 ? 'text-primary' : 'text-gray-500'">
        <div class="step-dot flex items-center justify-center rounded-full border-2" :class="activeStep >= 2 ? 'border-primary' : 'border-gray-400'">
          <span>3</span>
        </div>
        <span class="step-label ml-1 font-semibold">{{ compact ? '查看结果' : '查看并编辑结果' }}</span>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'StepHeader',
  setup() {
    return {};
  },
  props: {
    activeStep: { type: Number, default: 0 },
    compact: { type: Boolean, default: false },
  },
};
</script>

<style scoped>
.step-shell {
  position: relative;
  padding: 13px 18px;
  margin: 12px clamp(12px, 2vw, 24px) 8px;
  border: 1px solid var(--za-line);
  border-radius: 14px;
  box-shadow: var(--tp-shadow-sm);
}

.step-dot {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  background: var(--tp-bg-surface);
}

.step-line {
  flex: 1 1 auto;
  margin: 0 8px;
}

.step-caption {
  margin-bottom: 8px;
  color: var(--tp-accent);
  font-family: ui-monospace, "SFMono-Regular", monospace;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .18em;
}

.step-shell--compact {
  width: min(100%, 320px);
  flex: 0 1 320px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}

.step-shell--compact .step-caption {
  margin-bottom: 5px;
  color: var(--tp-text-subtle);
  font-family: inherit;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
}

.step-shell--compact .step-track {
  width: 100%;
  max-width: 320px;
}

.step-shell--compact .step-dot {
  width: 17px;
  height: 17px;
  flex-basis: 17px;
  border-width: 1.5px;
  font-size: 10px;
}

.step-shell--compact .step-line {
  flex: 0 1 48px;
  min-width: 24px;
  max-width: 48px;
  margin: 0 6px;
}

.step-shell--compact .step-label {
  white-space: nowrap;
  font-size: 11px;
}
</style>
