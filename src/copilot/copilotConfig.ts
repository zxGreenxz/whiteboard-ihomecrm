// Cấu hình chung cho AI Copilot (chat + UI-control) — PLAN.md v2.1.
import { supabase } from '@/integrations/supabase/client';

/** baseURL proxy — client OpenAI-compat sẽ gọi {base}/chat/completions. */
export const LLM_PROXY_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/llm-proxy`;

/** Ollama local — data_class 'local_only' KHÔNG đi qua proxy (browser → localhost). */
export const OLLAMA_BASE = 'http://localhost:11434/v1';

/** Model mặc định khi user chưa chọn (đã verify tool-calling, $0 — SPIKE-RESULTS.md). */
export const DEFAULT_MODEL = 'openrouter:nvidia/nemotron-3-super-120b-a12b:free';

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
