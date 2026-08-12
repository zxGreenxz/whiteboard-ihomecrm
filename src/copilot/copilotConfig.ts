// Cấu hình chung cho AI Copilot (chat + UI-control) — PLAN.md v2.1.
import { supabase } from '@/integrations/supabase/client';

/** baseURL proxy — client OpenAI-compat sẽ gọi {base}/chat/completions. */
export const LLM_PROXY_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/llm-proxy`;

/**
 * Provider LOCAL (data_class 'local_only') — KHÔNG đi qua proxy, browser gọi
 * thẳng localhost trên máy người dùng. Muốn thêm provider local mới: thêm 1
 * dòng ở đây + seed ai_providers (data_class 'local_only') + nhánh detect
 * model trong localProvider listLocalModels.
 *
 * LƯU Ý: 9Router giờ chạy trên VPS (ai.chillhome.io.vn) như provider CLOUD
 * (data_class 'cloud') → đi qua llm-proxy để mọi user dùng được ở bất cứ đâu +
 * có quota/usage log. KHÔNG còn trong danh sách local. Chỉ Ollama là local.
 */
export const LOCAL_PROVIDER_BASES: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
};

/**
 * Model mặc định khi user chưa chọn.
 *
 * 9Router là VPS self-host với tài khoản Codex trả phí; effort nằm TRONG tên
 * model (`(max)`), không phải tham số riêng — đó là quy ước của 9Router, đừng
 * đi tìm `reasoning_effort`.
 *
 * Đã đo thật ngày 12/08/2026 trên `cli.chillhome.io.vn`: gọi tool đúng (và trả
 * được nhiều tool call trong một lượt), đọc được ảnh. Model cũ
 * `openrouter:nvidia/nemotron-3-super-120b-a12b:free` là bản miễn phí, giữ lại
 * trong `ai_providers` làm đường lui khi VPS chết.
 *
 * RÀNG BUỘC THỨ TỰ: giá trị này phải CÓ trong `ai_providers.models` của provider
 * `9router` trước khi deploy, vì proxy nay từ chối model ngoài danh sách.
 */
export const DEFAULT_MODEL = '9router:cx/gpt-5.6-sol(max)';

/** Key trong profiles.ui_preferences lưu model user chọn. */
export const MODEL_PREF_KEY = 'copilotModel';

/** Tách "provider:model-id" (model-id được phép chứa ':', vd ':free'). */
export function parseProviderModel(raw: string): { provider: string; modelId: string } | null {
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) return null;
  return { provider: raw.slice(0, sep), modelId: raw.slice(sep + 1) };
}

/**
 * customFetch cho LLM class / PageAgent: gắn JWT TƯƠI mỗi request (F11 — token
 * hết hạn giữa task) + header định danh feature/task cho proxy ghi usage log.
 */
export function makeCopilotFetch(feature: 'chat' | 'ui_control', taskId: string): typeof fetch {
  return async (input, init) => {
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token ?? '';
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    headers.set('x-copilot-feature', feature);
    headers.set('x-task-id', taskId);
    return fetch(input, { ...init, headers });
  };
}

export function newTaskId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
