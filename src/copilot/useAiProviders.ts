// Danh sách provider/model khả dụng cho user chọn (đọc ai_providers — RLS
// SELECT authenticated). Model user chọn lưu server per-user qua
// profiles.ui_preferences (KHÔNG tạo bảng riêng).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';
import { useSetUiPreference, useUiPreferences } from '@/hooks/useUiPreferences';
import { DEFAULT_MODEL, MODEL_PREF_KEY } from './copilotConfig';
import { listLocalModels } from './ollama';
import { isUsableProviderModel } from './providerPolicy';

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
        // local_only (Ollama/9Router): model nằm trên MÁY user — không khai báo
        // trong DB thì tự phát hiện từ instance đang chạy; không chạy → rỗng (ẩn).
        if (localOnly && !models.length) {
          models = await listLocalModels(p.provider);
        }
        for (const m of models) {
          // Cloud models need complete, known pricing before they can reach the proxy.
          // Local models are discovered from the user's dev-only instance instead.
          if (!localOnly && !isUsableProviderModel(m)) continue;
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

/**
 * Model preference đã lưu có còn dùng được không?
 *
 * Admin gỡ một model khỏi `ai_providers.models` (vì nó chết, vì đổi nhà cung
 * cấp) thì preference của người dùng vẫn trỏ vào cái tên cũ — nó nằm trong
 * `profiles.ui_preferences`, không ai đi dọn. Trước đây hậu quả nhẹ: request đi
 * lên upstream rồi hỏng ở đó. Từ khi proxy ép allowlist thì hậu quả là **400
 * bad_model ngay lượt đầu**, và người dùng không hiểu vì sao Copilot chết trong
 * khi đồng nghiệp vẫn dùng được.
 *
 * Đã gặp thật ngày 12/08/2026: tài khoản test còn lưu `9router:mmf/mimo-auto`,
 * một model đã bị gỡ khỏi VPS từ 11/08.
 *
 * `options` chưa tải xong (undefined) ⇒ GIỮ NGUYÊN preference. Coi "chưa biết"
 * là "không hợp lệ" sẽ đá mọi người về model mặc định trong chớp mắt đầu tiên
 * của mỗi lần mở panel, rồi ghi đè lựa chọn thật của họ.
 */
export function modelConDungDuoc(model: string, options: ModelOption[] | undefined): boolean {
  if (!options) return true;
  return options.some((o) => o.value === model);
}

/**
 * Nhà cung cấp được ưu tiên khi phải chọn tạm một model thay thế.
 *
 * `openrouter` đứng đầu vì nó là đường đám mây có hoá đơn và có SLA; các nhà
 * cung cấp khác xếp sau theo đúng thứ tự khai báo của server.
 */
const UU_TIEN_NHA_CUNG_CAP: readonly string[] = ['openrouter'];

/**
 * Model thay thế khi lựa chọn hiện tại không còn nằm trong `options`.
 *
 * VÌ SAO KHÔNG QUAY VỀ `DEFAULT_MODEL`
 *   `DEFAULT_MODEL` là `9router:…`, một endpoint TỰ DỰNG. Ngày 01–03/09/2026 nó
 *   chết hai ngày: sổ proxy ghi 6 lượt `upstream_error` từ 9router và đúng 1 lượt
 *   `ok` từ nemotron. Trong hai ngày đó, ai chưa từng tự chọn model — tức là
 *   người dùng mặc định — bấm gửi rồi ngồi chờ **hết 60 giây timeout**, mỗi lượt.
 *   Bản cũ rơi về `DEFAULT_MODEL` KỂ CẢ khi provider `9router` đã bị tắt trong
 *   `ai_providers`, nghĩa là nó cố tình chọn đúng cái model mà server vừa nói là
 *   không dùng được nữa. "Mặc định" ở đó không còn là một lựa chọn, nó là một
 *   hằng số đã cũ.
 *
 * Nên bản này chọn từ CHÍNH danh sách server vừa trả về:
 *   - bỏ `localOnly` (Ollama/9Router chạy trên máy người dùng — người ở xa văn
 *     phòng không có gì để gọi, và một model cục bộ là lựa chọn CÓ CHỦ Ý chứ
 *     không phải thứ để rơi vào);
 *   - ưu tiên `openrouter`, rồi tới thứ tự server trả về.
 *
 * `options` rỗng hoặc chưa tải xong ⇒ giữ `DEFAULT_MODEL`: không có gì để thay
 * thì bịa ra một cái tên khác chỉ đổi thông báo lỗi chứ không chữa được gì.
 */
export function modelThayThe(options: ModelOption[] | undefined): string | null {
  if (!options?.length) return null;
  const dungDuoc = options.filter((o) => !o.localOnly);
  if (!dungDuoc.length) return null;
  for (const nhaCungCap of UU_TIEN_NHA_CUNG_CAP) {
    const uuTien = dungDuoc.find((o) => o.provider === nhaCungCap);
    if (uuTien) return uuTien.value;
  }
  return dungDuoc[0]?.value ?? null;
}

/** Nhãn hiển thị của một model, để banner nói tên người đọc được. */
export function nhanModel(model: string, options: ModelOption[] | undefined): string {
  return options?.find((o) => o.value === model)?.label ?? model;
}

/**
 * Model đang chọn (ui_preferences → model thay thế khả dụng → DEFAULT_MODEL).
 *
 * KHÔNG tự ghi đè preference đã lưu khi nó lỗi thời: người dùng có thể chỉ đang
 * mất mạng, hoặc admin sắp bật lại model đó. Chỉ trả về model thay thế cho lượt
 * chạy hiện tại; preference thật đổi khi người dùng tự chọn.
 */
export function useCopilotModel(): {
  model: string;
  setModel: (m: string) => void;
  modelLoiThoi: boolean;
  /** Nhãn của model đang dùng tạm, chỉ có giá trị khi `modelLoiThoi`. */
  modelThayThe: string | null;
} {
  const { data: prefs } = useUiPreferences();
  const { data: options } = useAiProviders();
  const setPref = useSetUiPreference();
  const daLuu = (prefs?.[MODEL_PREF_KEY] as string) || DEFAULT_MODEL;
  const conDung = modelConDungDuoc(daLuu, options);
  const thayThe = conDung ? null : modelThayThe(options);
  return {
    model: conDung ? daLuu : (thayThe ?? DEFAULT_MODEL),
    modelLoiThoi: !conDung,
    modelThayThe: thayThe === null ? null : nhanModel(thayThe, options),
    setModel: (m: string) => setPref.mutate({ key: MODEL_PREF_KEY, value: m }),
  };
}

/**
 * Entitlement của CHÍNH user — không có dòng = ẩn launcher.
 *
 * `.eq('user_id', uid)` KHÔNG phải hàng rào (RLS mới là hàng rào), nó là điều
 * kiện để `.maybeSingle()` có nghĩa. Với người dùng thường, policy "select own"
 * đã lọc sẵn nên thiếu `.eq` cũng chạy đúng — nhưng SUPER ADMIN thấy MỌI dòng,
 * và `maybeSingle()` gặp dòng thứ hai là ném PGRST116. Hậu quả không phải một
 * thông báo lỗi mà là NÚT COPILOT BIẾN MẤT: query throw, `entitlement` về
 * undefined, `CopilotLauncher` trả null.
 *
 * Bảng chỉ cần có hai người được cấp quyền là bẫy này bật.
 */
export function useCopilotEntitlement() {
  return useQuery({
    queryKey: ['ai-copilot-entitlement'],
    staleTime: 60_000,
    queryFn: async () => {
      // Session LOCAL, không round-trip `/auth/v1/user` — cùng lối với các
      // queryFn khác trong repo (xem `@/lib/authSession`).
      const userId = await getSessionUserId();
      // Chưa đăng nhập thì không có gì để hỏi. Trả null (ẩn launcher) chứ không
      // ném: đây là trạng thái bình thường lúc app vừa dựng, không phải lỗi.
      if (!userId) return null;
      const { data, error } = await supabase
        .from('ai_copilot_entitlements')
        .select('chat_enabled, ui_control_enabled')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data; // null = không được dùng
    },
  });
}
