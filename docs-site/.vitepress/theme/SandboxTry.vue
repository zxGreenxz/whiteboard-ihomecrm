<script setup lang="ts">
import { ref } from 'vue'
import DemoResetButton from './DemoResetButton.vue'

const props = defineProps<{
  account: string        // username demo phù hợp vai (vd demo.ketoan)
  appPath: string        // route trên app (vd /thu-tien)
  appLabel?: string      // nhãn nút mở app
  fixtures?: string      // phòng/dữ liệu bài tập (vd "B101, B102")
  viewOnly?: boolean     // trang read-only: không bài tập, không nút reset
}>()

const APP = 'https://ptcrm.vercel.app'
const copied = ref(false)
function copy() {
  navigator.clipboard?.writeText(props.account)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="sandbox-try">
    <p class="sb-head">🧪 <strong>{{ viewOnly ? 'Xem trên sandbox' : 'Thử trực tiếp trên sandbox' }}</strong></p>
    <div class="sb-row">
      <span>Đăng nhập:</span>
      <code>{{ account }}</code>
      <button class="sb-copy" @click="copy">{{ copied ? '✓ đã copy' : 'copy' }}</button>
      <a href="/01-bat-dau/sandbox/">mật khẩu &amp; quy tắc →</a>
    </div>
    <div class="sb-row">
      <a class="sb-open" :href="APP + appPath" target="_blank" rel="noopener">
        {{ appLabel ?? 'Mở màn hình trên app' }} ↗
      </a>
      <span v-if="fixtures" class="sb-fix">Dữ liệu bài tập: <strong>{{ fixtures }}</strong></span>
    </div>

    <div class="sb-body"><slot /></div>

    <div v-if="!viewOnly" class="sb-reset"><DemoResetButton /></div>
    <p class="sb-warn">
      ⚠ Sandbox dùng chung — người khác có thể đang thao tác; số liệu bạn thấy có thể khác bài tập.
      Nếu lệch, bấm Reset rồi làm lại. Không nhập tên/SĐT thật.
    </p>
  </div>
</template>

<style scoped>
.sandbox-try {
  margin: 20px 0;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
}
.sb-head { margin: 0 0 10px; font-size: 15px; }
.sb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 14px;
}
.sb-copy {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  cursor: pointer;
}
.sb-open {
  display: inline-block;
  padding: 5px 14px;
  border-radius: 8px;
  background: var(--vp-c-brand-1);
  color: #fff !important;
  font-weight: 600;
  font-size: 14px;
  text-decoration: none !important;
}
.sb-fix { font-size: 13px; color: var(--vp-c-text-2); }
.sb-body { margin: 10px 0; }
.sb-body :deep(h4), .sb-body :deep(p strong:first-child) { margin-top: 8px; }
.sb-reset { margin: 10px 0 4px; }
.sb-warn {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--vp-c-text-2);
  border-top: 1px dashed var(--vp-c-divider);
  padding-top: 8px;
}
</style>
