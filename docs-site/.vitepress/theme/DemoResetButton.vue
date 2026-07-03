<script setup lang="ts">
import { ref } from 'vue'

const URL = 'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/demo-reset'
const SECRET = (import.meta.env.VITE_DEMO_RESET_SECRET as string | undefined) ?? ''

const state = ref<'idle' | 'busy' | 'done' | 'cooldown' | 'error'>('idle')
const wait = ref(0)

async function reset() {
  if (!SECRET) {
    alert('Thiếu cấu hình secret (chỉ hoạt động trên bản deploy).')
    return
  }
  if (!confirm('Đưa TOÀN BỘ dữ liệu demo về trạng thái gốc?\nThao tác dở dang của người khác trên sandbox sẽ mất.')) return
  state.value = 'busy'
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'x-demo-secret': SECRET } })
    if (r.status === 429) {
      wait.value = (await r.json()).retryAfterSec ?? 600
      state.value = 'cooldown'
      return
    }
    if (r.status === 409) {
      wait.value = 60
      state.value = 'cooldown'
      return
    }
    state.value = r.ok ? 'done' : 'error'
  } catch {
    state.value = 'error'
  }
}
</script>

<template>
  <button class="demo-reset" :disabled="state === 'busy'" @click="reset">
    <span v-if="state === 'idle'">🔄 Reset dữ liệu demo</span>
    <span v-else-if="state === 'busy'">Đang reset…</span>
    <span v-else-if="state === 'done'">✅ Đã về trạng thái gốc — F5 lại app để thấy dữ liệu mới</span>
    <span v-else-if="state === 'cooldown'">⏳ Vừa có người reset — thử lại sau ~{{ Math.ceil(wait / 60) }} phút</span>
    <span v-else>❌ Lỗi — báo quản trị viên</span>
  </button>
</template>

<style scoped>
.demo-reset {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
.demo-reset:hover:not(:disabled) {
  background: var(--vp-c-brand-1);
  color: #fff;
}
.demo-reset:disabled {
  opacity: 0.6;
  cursor: wait;
}
</style>
