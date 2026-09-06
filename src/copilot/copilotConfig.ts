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
 * 9Router trên VPS dùng Gemini qua Antigravity (`ag/`). Mức suy luận nằm
 * TRONG tên model (`(high)`), theo quy ước của 9Router.
 * Ưu tiên Gemini 3.6 theo lựa chọn của chủ dự án; chỉ chủ động chọn 3.7/3.8
 * sau khi đánh giá thấy cần. Không tự nâng model khi lỗi mạng hoặc hết quota.
 *
 * RÀNG BUỘC THỨ TỰ: giá trị này phải CÓ trong `ai_providers.models` của provider
 * `9router` trước khi deploy, vì proxy nay từ chối model ngoài danh sách.
 */
export const DEFAULT_MODEL = '9router:ag/gemini-3.6-flash-high(high)';

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
 *
 * `organizationId` là công ty ĐANG CHỌN (`OrganizationContext`), đi lên proxy
 * qua `x-organization-id` rồi vào thẳng `reserve_ai_usage(..., p_organization_id)`.
 * Trước G0-B không có nó: proxy để trống `organization_id`, và trigger
 * `autofill_org_strict` phải SUY công ty từ `user_id` — chỉ đoán được khi người
 * dùng thuộc đúng một công ty, còn với người đa tổ chức thì hoặc lỗi 500 hoặc
 * ghi hạn mức vào công ty họ không chọn.
 *
 * Header đi ở HEADER chứ không phải trong body: body là payload OpenAI-compat do
 * thư viện dựng, và proxy chỉ chuyển tiếp một allow-list khoá của nó.
 *
 * `null` (chưa chốt công ty) thì KHÔNG gắn header và VẪN gọi. Chặn im lặng ở đây
 * biến "chưa chọn công ty" thành "Copilot không phản hồi"; để server trả 400
 * `organization_required` thì người dùng đọc được một câu nói đúng chuyện.
 */
export function makeCopilotFetch(
  feature: 'chat' | 'ui_control',
  taskId: string,
  organizationId: string | null,
): typeof fetch {
  return async (input, init) => {
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token ?? '';
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    headers.set('x-copilot-feature', feature);
    headers.set('x-task-id', taskId);
    if (organizationId) headers.set('x-organization-id', organizationId);
    return fetch(input, { ...init, headers });
  };
}

export function newTaskId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
