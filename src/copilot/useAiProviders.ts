// Danh sách provider/model khả dụng cho user chọn (đọc ai_providers — RLS
// SELECT authenticated). Model user chọn lưu server per-user qua
// profiles.ui_preferences (KHÔNG tạo bảng riêng).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSetUiPreference, useUiPreferences } from '@/hooks/useUiPreferences';
import { DEFAULT_MODEL, MODEL_PREF_KEY } from './copilotConfig';
import { listOllamaModels } from './ollama';

export interface ModelOption {
  value: string; // "provider:model-id"
  label: string;
  provider: string;
  localOnly: boolean;
}

export function useAiProviders() {
  return useQuery({
    queryKey: ['ai-providers'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ModelOption[]> => {
      const { data, error } = await supabase
        .from('ai_providers')
        .select('provider, enabled, label, models, default_model, data_class')
        .eq('enabled', true);
      if (error) throw error;
      const out: ModelOption[] = [];
      for (const p of data ?? []) {
        if (p.provider === 'mock') continue; // dev-only, không cho user chọn
        const localOnly = p.data_class === 'local_only';
        let models = Array.isArray(p.models) ? (p.models as any[]) : [];
        // local_only (Ollama): model nằm trên MÁY user — không khai báo trong DB
        // thì tự phát hiện từ instance đang chạy; không chạy → rỗng (ẩn).
        if (localOnly && !models.length) {
          models = await listOllamaModels();
        }
        for (const m of models) {
          if (!m?.id) continue;
          out.push({
            value: `${p.provider}:${m.id}`,
            label: `${m.label ?? m.id} — ${p.label}`,
            provider: p.provider,
            localOnly,
          });
        }
      }
      return out;
    },
  });
}

/** Model đang chọn (ui_preferences → fallback DEFAULT_MODEL). */
export function useCopilotModel(): { model: string; setModel: (m: string) => void } {
  const { data: prefs } = useUiPreferences();
  const setPref = useSetUiPreference();
  const model = (prefs?.[MODEL_PREF_KEY] as string) || DEFAULT_MODEL;
  return {
    model,
    setModel: (m: string) => setPref.mutate({ key: MODEL_PREF_KEY, value: m }),
  };
}

/** Entitlement của CHÍNH user (RLS select own) — không có dòng = ẩn launcher. */
export function useCopilotEntitlement() {
  return useQuery({
    queryKey: ['ai-copilot-entitlement'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_copilot_entitlements')
        .select('chat_enabled, ui_control_enabled')
        .maybeSingle();
      if (error) throw error;
      return data; // null = không được dùng
    },
  });
}
