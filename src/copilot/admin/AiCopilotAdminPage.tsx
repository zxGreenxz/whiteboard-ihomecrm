import {readProviders,readProviderPrices,readAdminEntitlements,readProfileBrief,readAdminSettings} from '../providerReadModels';
import { runPersistentCopilotAdminWrite } from './adminPersistence';
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { saveCopilotSettings, addCopilotEntitlement, changeCopilotEntitlement, removeCopilotEntitlement, saveCopilotProvider, copilotAdminOutcomeUnknown, CopilotAccountMissingError, CopilotAdminUnknownError } from './adminWrites';
import { actionErrorMessage, notifyActionError } from '@/lib/actionFeedback';
import { focusFirstError } from '@/lib/formErrors';
import { QueryRegion } from '@/components/errors/QueryRegion';
// Trang quản trị AI Copilot (Phase 4 PLAN.md) — /settings/ai-copilot
// - SUPER ADMIN: 4 tab đầy đủ (Cài đặt / Người dùng / Providers / Sử dụng)
// - Owner/user thường có entitlement: chỉ tab Sử dụng (RLS tự scope: user thấy
//   của mình, owner thấy cả đội qua owner_id)
// Ghi chú: RLS write các bảng cấu hình = is_super_admin() — UI chỉ là tiện ích,
// server mới là gate thật.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatVND } from '@/lib/utils';
import { LLM_PROXY_BASE, makeCopilotFetch, newTaskId } from '../copilotConfig';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  copilotRolloutTransitions,
  formatCopilotRolloutError,
  rolloutRowsFromAvailability,
  nhomRolloutTheoScope,
  setCopilotFeatureFlagV2,
  useCopilotAvailability,
  type CopilotFlagState,
} from '../featureFlags';
import { validateDefaultModel, validateProviderModels } from '../providerPolicy';
import type { ProviderModel } from '../providerPolicy';
import { useAuth } from '@/hooks/useAuth';
import {
  GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN,
  MUC_CANH_BAO_PHAN_TRAM,
  chiPhiQuyUocSelfHosted,
  daChamNguongCanhBao,
  mocDauNgayVN,
  tapModelSelfHosted,
  tinhPhanTramHanMuc,
  tomTatTokenHomNay,
} from './hanMucToken';
import type { DongTokenHomNay } from './hanMucToken';
import HanhDongTab from './HanhDongTab';

// ── Data hooks ───────────────────────────────────────────────────────────────

interface SettingsRow {
  chat_enabled: boolean;
  ui_control_enabled: boolean;
  rate_per_min: number;
  daily_usd_cap_user: number;
  daily_usd_cap_tenant: number;
  daily_usd_cap_global: number;
  // G1-F: hàng rào duy nhất còn cắn khi provider báo giá 0 (`20260903034632`).
  daily_tokens_cap_user: number;
  daily_tokens_cap_tenant: number;
}

const useSettings = () =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-copilot-settings'],
    queryFn: async (): Promise<SettingsRow | null> => {
      const { data, error } = await supabase
        .from('ai_copilot_settings')
        .select('chat_enabled, ui_control_enabled, rate_per_min, daily_usd_cap_user, daily_usd_cap_tenant, daily_usd_cap_global, daily_tokens_cap_user, daily_tokens_cap_tenant')
        .maybeSingle();
      if (error) throw error;
      // ÉP KIỂU CÓ CHỦ Ý: `integrations/supabase/types.ts` sinh từ schema
      // PRODUCTION, mà hai cột cap token chỉ tồn tại sau khi migration
      // `20260903034632` được apply. Sửa tay artifact máy-sở-hữu để "cho hết
      // đỏ" sẽ làm job generated-types-drift đỏ ngay lượt CI kế tiếp; cast ở
      // đúng hai chỗ đọc/ghi, kèm lý do, là cái giá rẻ hơn. Gỡ cast này ngay
      // sau lần `npm run gen:types` đầu tiên hậu-apply.
      //
      // THỨ TỰ PHÁT HÀNH — không đảo được: migration `20260903034632` phải APPLY
      // TRƯỚC khi web lên. Deploy web trước thì `.select()` này trả 400 "column
      // does not exist" và CẢ tab Cài đặt chết, không riêng hai ô mới.
      return readAdminSettings<SettingsRow>(data);
    },
  });

interface EntitlementRow {
  user_id: string;
  chat_enabled: boolean;
  ui_control_enabled: boolean;
  profile?: { email: string | null; full_name: string | null } | null;
}

const useEntitlements = (enabled: boolean) =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-copilot-entitlements-admin'],
    enabled,
    queryFn: async (): Promise<EntitlementRow[]> => {
      // FK trỏ auth.users (không phải profiles) → PostgREST không embed được,
      // join tay bằng 2 query.
      const { data, error } = await supabase
        .from('ai_copilot_entitlements')
        .select('user_id, chat_enabled, ui_control_enabled')
        .order('created_at', { ascending: true });
      if (error) throw error;
      const rows = readAdminEntitlements(data);
      if (!rows.length) return rows;
      const { data: profs, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .in('id', rows.map((r) => r.user_id));
      if (profilesError) throw profilesError;
      const byId = new Map(readProfileBrief(profs).map(p => [p.id, p]));
      return rows.map((r) => ({ ...r, profile: byId.get(r.user_id) ?? null }));
    },
  });

interface ProviderRow {
  provider: string;
  enabled: boolean;
  label: string;
  models: unknown;
  default_model: string | null;
  data_class: string;
}

function providerModelCost(model: ProviderModel): string {
  if (model.pricing_mode === 'unknown') return 'unknown';
  if (typeof model.input_price !== 'number' || typeof model.output_price !== 'number' ||
      !Number.isFinite(model.input_price) || !Number.isFinite(model.output_price) ||
      model.input_price < 0 || model.output_price < 0) return 'invalid';
  return `$${model.input_price}/$${model.output_price} per 1M tokens`;
}

const useProvidersAdmin = (enabled: boolean) =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-providers-admin'],
    enabled,
    queryFn: async (): Promise<ProviderRow[]> => {
      const { data, error } = await supabase
        .from('ai_providers')
        .select('provider, enabled, label, models, default_model, data_class')
        .order('provider');
      if (error) throw error;
      return readProviders(data);
    },
  });

interface UsageRow {
  user_id: string;
  owner_id: string | null;
  provider: string;
  model: string;
  feature: string;
  total_tokens: number;
  cost_usd: number | null;
  reserved_cost_usd: number | null;
  status: string;
  created_at: string;
}

function validTokenRow(row: unknown): row is DongTokenHomNay {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const record = row as Record<string, unknown>;
  return typeof record.user_id === 'string' && !!record.user_id
    && (record.owner_id === null || typeof record.owner_id === 'string' && !!record.owner_id)
    && (record.total_tokens === null || typeof record.total_tokens === 'number' && Number.isSafeInteger(record.total_tokens) && record.total_tokens >= 0);
}

function formatUsageCost(costUsd: number | null, reservedCostUsd: number | null): string {
  // A reservation is only an estimate; a missing finalized cost is unknown.
  if (costUsd === null) return 'unknown';
  const value = Number(costUsd);
  return Number.isFinite(value) && value >= 0 ? `$${value.toFixed(5)}` : 'unknown';
}

const useUsage = () =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-usage-7d'],
    queryFn: async (): Promise<UsageRow[]> => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const data = await fetchAllRows<UsageRow>((from, to) => supabase
        .from('ai_usage_logs')
        .select('user_id, owner_id, provider, model, feature, total_tokens, cost_usd, reserved_cost_usd, status, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to), { label: 'Copilot usage 7 ngày' });
      if (!data || data.some(row => !validTokenRow(row) || !['provider','model','feature','status','created_at'].every(key => typeof (row as unknown as Record<string, unknown>)[key] === 'string') || ![row.cost_usd,row.reserved_cost_usd].every(value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0))) throw new TypeError('Unconfirmed Copilot usage rows');
      return data;
    },
  });

/**
 * Token hôm nay (biên ngày VN — CÙNG biên với `reserve_ai_usage`).
 *
 * Truy vấn RIÊNG chứ không lọc lại từ `useUsage`: bảng 7 ngày bị `limit(1000)`
 * cắt, và một ngày bận có thể vượt 1000 dòng — lúc đó thanh hạn mức sẽ báo thiếu
 * đúng vào ngày người ta cần nó nhất.
 *
 * Đọc thẳng bảng qua RLS (giống `useUsage`) chứ không thêm RPC: policy
 * `ai_usage_logs_select` đã scope sẵn `user_id = tôi OR owner_id = tôi OR super
 * admin`, nên một RPC SECURITY DEFINER ở đây chỉ chép lại đúng luật đó vào chỗ
 * thứ hai để hai chỗ lệch nhau về sau.
 */
const useTokenHomNay = () => {
  // Mốc ngày nằm TRONG queryKey: một tab mở qua nửa đêm VN sẽ đổi khoá ở lần
  // render kế tiếp và tự nạp lại cửa sổ ngày mới, thay vì hiển thị mãi tổng của
  // hôm qua trong khi database đã reset hạn mức.
  const mocNgay = mocDauNgayVN(new Date());
  return useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-usage-token-hom-nay', mocNgay],
    queryFn: async (): Promise<DongTokenHomNay[]> => {
      const data = await fetchAllRows<DongTokenHomNay>((from, to) => supabase
        .from('ai_usage_logs')
        .select('user_id, owner_id, total_tokens')
        .gte('created_at', mocNgay)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to), { label: 'Copilot token hôm nay' });
      if (!data || data.some(row => !validTokenRow(row))) throw new TypeError('Unconfirmed Copilot token rows');
      return data;
    },
  });
};

/** Bảng giá model — chỉ để biết model nào `self_hosted`. RLS cho mọi authenticated đọc. */
const useProvidersGia = () =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['ai-providers-gia'],
    queryFn: async (): Promise<{ provider: string; models: unknown }[]> => {
      const { data, error } = await supabase.from('ai_providers').select('provider, models');
      if (error) throw error;
      return readProviderPrices(data);
    },
  });

const useProfileNames = (ids: string[]) =>
  useQuery({
    meta: { label: 'dữ liệu quản trị Copilot', errorDisplay: 'inline' },
    queryKey: ['profiles-brief', [...ids].sort()],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase.from('profiles').select('id, full_name, email').in('id', ids);
      if (error) throw error;
      return Object.fromEntries(readProfileBrief(data).map(p => [p.id, p.full_name || p.email || p.id.slice(0, 8)]));
    },
  });

// ── Tab: Cài đặt ─────────────────────────────────────────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const { data: settings, isLoading } = settingsQuery;
  const [draft, setDraft] = useState<SettingsRow | null>(null);
  const [numericDraft, setNumericDraft] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState('');
  const cur = draft ?? settings ?? null;

  const save = useMutation({
    mutationFn: (settings: SettingsRow) => runPersistentCopilotAdminWrite('settings', 'lưu cài đặt Copilot', () => saveCopilotSettings({...settings})),
    onSuccess: () => {
      toast.success('Đã lưu cài đặt Copilot');
      setDraft(null);
      setNumericDraft({});
      setFieldErrors({});
      setSaveError('');
      void qc.invalidateQueries({ queryKey: ['ai-copilot-settings'] });
    },
    onError: (e: Error) => setSaveError(actionErrorMessage(e, 'Chưa lưu được cài đặt Copilot')),
  });

  if (settingsQuery.isError) return <QueryRegion label="cấu hình Copilot" queries={[settingsQuery]}><p role="alert">Chưa cập nhật được cấu hình Copilot.</p></QueryRegion>;
  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;
  if (!cur) return <div className="text-sm text-red-600">Chưa có cấu hình Copilot. Liên hệ quản trị viên để thiết lập.</div>;

  const set = (patch: Partial<SettingsRow>) => setDraft({ ...cur, ...patch });
  const numberFields = ['rate_per_min', 'daily_usd_cap_user', 'daily_usd_cap_tenant', 'daily_usd_cap_global', 'daily_tokens_cap_user', 'daily_tokens_cap_tenant'] as const;
  const numberInput = (name: typeof numberFields[number]) => ({
    name, type: 'text', inputMode: 'decimal' as const, disabled: save.isPending,
    value: numericDraft[name] ?? String(cur[name]),
    'aria-invalid': Boolean(fieldErrors[name]),
    'aria-describedby': fieldErrors[name] ? `copilot-settings-${name}-error` : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft({ ...cur });
      setNumericDraft(previous => ({ ...previous, [name]: event.target.value }));
      setFieldErrors(previous => { const next = { ...previous }; delete next[name]; return next; });
    },
  });
  const saveSettings = () => {
    const errors: Record<string, string> = {};
    const values = { ...cur };
    for (const name of numberFields) {
      const raw = numericDraft[name] ?? String(cur[name]);
      const value = Number(raw);
      const integer = name === 'rate_per_min' || name.startsWith('daily_tokens');
      if (!raw.trim() || !Number.isFinite(value) || value < (name === 'rate_per_min' ? 1 : 0) ||
          (integer && (!Number.isInteger(value) || value > 2147483647)) ||
          (!integer && (value >= 1000000 || !/^\d+(?:\.\d{1,4})?$/.test(raw.trim())))) {
        errors[name] = integer ? `Nhập số nguyên ${name === 'rate_per_min' ? 'lớn hơn 0' : 'không âm'} trong giới hạn 2.147.483.647.` : 'Nhập hạn mức USD không âm, nhỏ hơn 1.000.000 và tối đa 4 chữ số sau dấu chấm.';
      } else values[name] = value;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) { void focusFirstError(errors, { order: numberFields }); return; }
    setSaveError('');
    save.mutate(values);
  };

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-center justify-between rounded border p-3">
        <div>
          <div className="font-medium text-sm">Chat (kill switch toàn hệ thống)</div>
          <div className="text-xs text-muted-foreground">Tắt = mọi user mất chat ngay lập tức</div>
        </div>
        <Switch disabled={save.isPending} checked={cur.chat_enabled} onCheckedChange={(v) => set({ chat_enabled: v })} />
      </div>
      <div className="flex items-center justify-between rounded border p-3">
        <div>
          <div className="font-medium text-sm">Điều khiển UI (experimental)</div>
          <div className="text-xs text-muted-foreground">Tắt = mọi user mất UI-control ngay</div>
        </div>
        <Switch disabled={save.isPending} checked={cur.ui_control_enabled} onCheckedChange={(v) => set({ ui_control_enabled: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          Rate limit (request/phút/user)
          <Input {...numberInput('rate_per_min')} />
        </label>
        <label className="text-sm">
          Cap USD/ngày mỗi USER
          <Input {...numberInput('daily_usd_cap_user')} />
        </label>
        <label className="text-sm">
          Cap USD/ngày mỗi TENANT
          <Input {...numberInput('daily_usd_cap_tenant')} />
        </label>
        <label className="text-sm">
          Cap USD/ngày TOÀN HỆ THỐNG
          <Input {...numberInput('daily_usd_cap_global')} />
        </label>
        <label className="text-sm">
          Cap TOKEN/ngày mỗi USER
          <Input {...numberInput('daily_tokens_cap_user')} />
        </label>
        <label className="text-sm">
          Cap TOKEN/ngày mỗi TENANT
          <Input {...numberInput('daily_tokens_cap_tenant')} />
        </label>
      </div>
      <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        <strong>Cap USD hiện KHÔNG cắn.</strong> Hai provider đang bật đều báo giá 0 (OpenRouter
        model <code>:free</code>, 9Router <code>self_hosted</code>), nên nhân bao nhiêu token cũng ra
        $0 và ba cap USD không bao giờ chạm. Hàng rào khối lượng thật là hai ô <strong>cap
        TOKEN</strong> ở trên. Đặt <strong>0 = tắt</strong> hạn mức đó.
      </p>
      {Object.entries(fieldErrors).map(([name, message]) => <p key={name} id={`copilot-settings-${name}-error`} role="alert" className="text-sm text-destructive">{message}</p>)}
      {saveError && !copilotAdminOutcomeUnknown(save.error) && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
      {copilotAdminOutcomeUnknown(save.error) && <div role="alert" className="text-sm text-destructive">Chưa xác nhận được kết quả lưu cài đặt. Giữ nội dung đang nhập và đọc lại cấu hình trước khi thực hiện tiếp.<Button type="button" variant="outline" onClick={() => void settingsQuery.refetch()}>Đọc lại cấu hình</Button></div>}
      <Button disabled={!draft || save.isPending || copilotAdminOutcomeUnknown(save.error)} onClick={saveSettings}>
        {save.isPending ? 'Đang lưu…' : 'Lưu cài đặt'}
      </Button>
    </div>
  );
}

// -- Tab: Rollout server-owned contracts -------------------------------------

function RolloutTab() {
  const qc = useQueryClient();
  const {
    organizations,
    selectedOrganizationId,
    selectOrganization,
    isLoading: organizationsLoading,
  } = useOrganization();
  const {
    data: availability,
    isLoading: availabilityLoading,
    isFetching,
    refetch,
  } = useCopilotAvailability(selectedOrganizationId);
  const [reason, setReason] = useState('');
  const [evidenceLink, setEvidenceLink] = useState('');
  const [rollbackReference, setRollbackReference] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [rolloutErrors, setRolloutErrors] = useState<Record<string, string>>({});
  const [rolloutError, setRolloutError] = useState('');
  const [rolloutUnknown, setRolloutUnknown] = useState(false);
  const rows = rolloutRowsFromAvailability(availability);
  const nhom = nhomRolloutTheoScope(rows);

  const transition = async (
    scope: 'page' | 'action',
    contractId: string,
    state: CopilotFlagState,
  ) => {
    if (!availability || rolloutUnknown) {
      setRolloutError('Chưa có trạng thái rollout đã xác nhận. Đọc lại cấu hình trước khi chuyển tiếp.');
      return;
    }
    const errors: Record<string, string> = {};
    if (!reason.trim()) errors.rolloutReason = 'Nhập lý do chuyển rollout.';
    if (!evidenceLink.trim()) errors.rolloutEvidence = 'Nhập liên kết bằng chứng.';
    if (!rollbackReference.trim()) errors.rolloutRollback = 'Nhập tham chiếu rollback.';
    setRolloutErrors(errors);
    if (Object.keys(errors).length) { await focusFirstError(errors, { order: ['rolloutReason', 'rolloutEvidence', 'rolloutRollback'] }); return; }
    setRolloutError('');
    setPending(`${scope}:${contractId}:${state}`);
    try {
      await runPersistentCopilotAdminWrite(`rollout:${scope}:${contractId}`, 'đổi trạng thái rollout Copilot', async () => {
      const receipt = await setCopilotFeatureFlagV2({
        // Scope lấy từ CHÍNH hàng đang bấm. Chết cứng 'page' thì một contract
        // scope `action` sẽ gửi sai khoá và RPC trả `unknown_rollout_contract`
        // — thông báo đó đọc như "contract không tồn tại", không như "gửi nhầm
        // scope", nên người vận hành đi tìm sai chỗ.
        scope,
        contractId,
        state,
        expectedRevision: availability.revision,
        canaryOrg: null,
        reason: reason.trim(),
        evidenceLink: evidenceLink.trim(),
        expiresAt: null,
        rollbackReference: rollbackReference.trim(),
      });
      const result = receipt as { scope?: unknown; contract_id?: unknown; state?: unknown; revision?: unknown } | null;
      if (!result || result.scope !== scope || result.contract_id !== contractId || result.state !== state ||
          !Number.isSafeInteger(result.revision) || (result.revision as number) <= availability.revision) throw new CopilotAdminUnknownError();
      return result;
      });
      toast.success(`Đã chuyển ${contractId} → ${state}`);
      await qc.invalidateQueries({ queryKey: ['copilot-availability'] });
      await refetch();
    } catch (error) {
      const unknown = copilotAdminOutcomeUnknown(error);
      setRolloutUnknown(unknown);
      setRolloutError(unknown ? 'Chưa xác nhận được kết quả chuyển rollout. Giữ lý do và đối chiếu trạng thái trước khi thực hiện tiếp.' : formatCopilotRolloutError(error));
      if (String(error instanceof Error ? error.message : error).includes('stale_revision')) {
        await refetch();
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium text-sm">Server-owned rollout</div>
            <div className="text-xs text-muted-foreground">
              Mọi thay đổi dùng CAS theo revision; snapshot lỗi hoặc hết hạn sẽ khóa toàn bộ tool.
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Revision: <span className="font-mono">{availability?.revision ?? '—'}</span>
            {isFetching ? ' · đang tải lại…' : ''}
          </div>
        </div>
        <label className="block text-sm">
          Tổ chức đang kiểm tra
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedOrganizationId ?? ''}
            disabled={organizationsLoading || organizations.length === 0}
            onChange={(event) => selectOrganization(event.target.value)}
          >
            <option value="">Chọn tổ chức</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>{organization.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm">
          Lý do bắt buộc
          <Input name="rolloutReason" aria-invalid={!!rolloutErrors.rolloutReason} aria-describedby={rolloutErrors.rolloutReason ? "copilot-rolloutReason-error" : undefined} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ví dụ: pilot đã đạt acceptance" />
        </label>
        <label className="text-sm">
          Liên kết bằng chứng
          <Input name="rolloutEvidence" aria-invalid={!!rolloutErrors.rolloutEvidence} aria-describedby={rolloutErrors.rolloutEvidence ? "copilot-rolloutEvidence-error" : undefined} value={evidenceLink} onChange={(event) => setEvidenceLink(event.target.value)} placeholder="URL / mã run / ticket" />
        </label>
        <label className="text-sm">
          Tham chiếu rollback
          <Input name="rolloutRollback" aria-invalid={!!rolloutErrors.rolloutRollback} aria-describedby={rolloutErrors.rolloutRollback ? "copilot-rolloutRollback-error" : undefined} value={rollbackReference} onChange={(event) => setRollbackReference(event.target.value)} placeholder="SHA / ticket rollback" />
        </label>
      </div>

      {Object.entries(rolloutErrors).map(([name, message]) => <p key={name} id={`copilot-${name}-error`} role="alert" className="text-sm text-destructive">{message}</p>)}
      {rolloutError && <p role="alert" className="text-sm text-destructive">{rolloutError}</p>}
      {!selectedOrganizationId || availability === null || (availabilityLoading && !availability) ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          BLOCKED — chưa có snapshot rollout server hợp lệ; không cho phép thay đổi hay suy đoán trạng thái.
        </div>
      ) : null}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">Contract</th>
              <th className="p-2">Trạng thái</th>
              <th className="p-2">Chuyển tiếp hợp lệ</th>
            </tr>
          </thead>
          {nhom.map((group) => (
            <tbody key={group.scope}>
              <tr className="border-t bg-muted/30">
                <th className="p-2 text-left text-xs font-semibold uppercase tracking-wide" colSpan={3}>
                  {group.nhan} · {group.rows.length} contract
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={`${row.scope}:${row.contractId}`} className="border-t">
                  <td className="p-2">
                    <div className="font-medium">{row.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.scope}:{row.contractId}</div>
                  </td>
                  <td className="p-2">
                    <span className="rounded bg-muted px-2 py-1 text-xs font-medium">{row.state}</span>
                  </td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-2">
                      {copilotRolloutTransitions(row.state).map((nextState) => (
                        <Button
                          key={nextState}
                          size="sm"
                          variant={nextState === 'disabled' ? 'destructive' : 'outline'}
                          disabled={!availability || pending !== null || rolloutUnknown}
                          onClick={() => void transition(row.scope, row.contractId, nextState)}
                        >
                          {pending === `${row.scope}:${row.contractId}:${nextState}` ? 'Đang lưu…' : nextState}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          {!rows.length && (
            <tbody>
              <tr><td className="p-3 text-muted-foreground" colSpan={3}>Chưa có snapshot rollout.</td></tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

// ── Tab: Người dùng (entitlements) ───────────────────────────────────────────

function EntitlementsTab() {
  const qc = useQueryClient();
  const entitlementsQuery = useEntitlements(true);
  const { data: rows, isLoading } = entitlementsQuery;
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['ai-copilot-entitlements-admin'] });

  const add = useMutation({
    mutationFn: (email: string) => runPersistentCopilotAdminWrite('entitlements', 'cấp quyền Copilot', () => addCopilotEntitlement(email)),
    onSuccess: () => { toast.success('Đã cấp quyền chat'); setEmail(''); refresh(); },
    onError: (e: Error) => {
      if(e instanceof CopilotAccountMissingError){setEmailError(e.message);void focusFirstError({email:e.message});}
      else notifyActionError(e, "Chưa xác nhận được kết quả cấp quyền Copilot");
    },
  });

  const toggle = useMutation({
    mutationFn: (input: Parameters<typeof changeCopilotEntitlement>[0]) => runPersistentCopilotAdminWrite('entitlements', 'đổi quyền Copilot', () => changeCopilotEntitlement(input)),
    onSuccess: refresh,
    onError: (e: Error) => notifyActionError(e, "Chưa xác nhận được kết quả đổi quyền Copilot"),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => runPersistentCopilotAdminWrite('entitlements', 'thu hồi quyền Copilot', () => removeCopilotEntitlement(userId)),
    onSuccess: () => { toast.success('Đã thu hồi (hiệu lực ngay)'); refresh(); },
    onError: (e: Error) => notifyActionError(e, "Chưa xác nhận được kết quả thu hồi quyền Copilot"),
  });

  const entitlementUnknown = [add.error,toggle.error,remove.error].some(copilotAdminOutcomeUnknown);
  const entitlementBusy = add.isPending || toggle.isPending || remove.isPending;
  const submitEmail = () => {
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { const message='Nhập email đã đăng ký của tài khoản cần cấp quyền.'; setEmailError(message); void focusFirstError({email:message}); return; }
    setEmailError('');add.mutate(email);
  };
  if (entitlementsQuery.isError) return <QueryRegion label="quyền sử dụng Copilot" queries={[entitlementsQuery]}><p role="alert">Chưa cập nhật được quyền sử dụng Copilot.</p></QueryRegion>;
  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-4">
      {entitlementUnknown && <div role="alert" className="text-sm text-destructive">Chưa xác nhận được kết quả đổi quyền Copilot. Đọc lại danh sách và đối chiếu tài khoản trước khi thực hiện tiếp.<Button type="button" variant="outline" onClick={() => void entitlementsQuery.refetch()}>Đọc lại quyền sử dụng</Button></div>}
      {emailError && <p id="copilot-email-error" role="alert" className="text-sm text-destructive">{emailError}</p>}
      <div className="flex max-w-md gap-2">
        <Input aria-label="Email tài khoản cần cấp quyền" data-field-name="email" aria-invalid={!!emailError} aria-describedby={emailError ? "copilot-email-error" : undefined} placeholder="Email user cần cấp quyền…" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button disabled={entitlementBusy || entitlementUnknown} onClick={submitEmail}>Cấp quyền</Button>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">Người dùng</th>
              <th className="p-2">Chat</th>
              <th className="p-2">Điều khiển UI</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.user_id} className="border-t">
                <td className="p-2">
                  <div className="font-medium">{r.profile?.full_name ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.profile?.email ?? r.user_id}</div>
                </td>
                <td className="p-2">
                  <Switch disabled={entitlementBusy || entitlementUnknown} checked={r.chat_enabled} onCheckedChange={(v) => toggle.mutate({ user_id: r.user_id, field: 'chat_enabled', value: v })} />
                </td>
                <td className="p-2">
                  <Switch disabled={entitlementBusy || entitlementUnknown} checked={r.ui_control_enabled} onCheckedChange={(v) => toggle.mutate({ user_id: r.user_id, field: 'ui_control_enabled', value: v })} />
                </td>
                <td className="p-2 text-right">
                  <Button disabled={entitlementBusy || entitlementUnknown} variant="destructive" size="sm" onClick={() => remove.mutate(r.user_id)}>Thu hồi</Button>
                </td>
              </tr>
            ))}
            {!rows?.length && (
              <tr><td className="p-3 text-muted-foreground" colSpan={4}>Chưa cấp quyền cho ai (opt-in tường minh).</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Providers ───────────────────────────────────────────────────────────

function ProvidersTab() {
  const qc = useQueryClient();
  // "Test key" đi qua đúng đường của người dùng thật — kể cả reserve_ai_usage —
  // nên nó cũng phải nói mình đang tiêu hạn mức của công ty nào.
  const { selectedOrganizationId } = useOrganization();
  const providersQuery = useProvidersAdmin(true);
  const { data: rows, isLoading } = providersQuery;
  const [editing, setEditing] = useState<string | null>(null);
  const [modelsDraft, setModelsDraft] = useState('');
  const [modelErrors,setModelErrors] = useState<Record<string,string>>({});
  const [modelSaveError,setModelSaveError] = useState('');
  const [defaultDraft, setDefaultDraft] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testFeedback,setTestFeedback] = useState<{provider:string;message:string}|null>(null);

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['ai-providers-admin'] });

  const update = useMutation({
    mutationFn: (input: Parameters<typeof saveCopilotProvider>[0]) => runPersistentCopilotAdminWrite(`provider:${input.provider}`, 'lưu nhà cung cấp AI', () => saveCopilotProvider(input)),
    onSuccess: refresh,
    onError: (e: Error) => notifyActionError(e, "Chưa xác nhận được kết quả lưu cấu hình nhà cung cấp AI"),
  });

  const saveModels = async (provider: string) => {
    if(update.isPending || copilotAdminOutcomeUnknown(update.error)) return;
    const errors: Record<string,string> = {};
    setModelSaveError('');
    let parsed: unknown;
    try { parsed = JSON.parse(modelsDraft); }
    catch { errors.models = 'Nội dung cấu hình mô hình chưa đúng định dạng JSON. Kiểm tra dấu ngoặc, dấu phẩy và dấu nháy.'; }
    if(!errors.models && !Array.isArray(parsed)) errors.models = 'Cấu hình mô hình phải là một danh sách.';
    if(Array.isArray(parsed)) {
      const problems = validateProviderModels(parsed);
      if(problems.length) errors.models = 'Kiểm tra mã, tên, cách tính phí và giá của từng mô hình. Giá cần là số không âm.';
      if(parsed.some(model => model?.pricing_mode === 'unknown')) errors.models = 'Chọn cách tính phí cho từng mô hình trước khi bật sử dụng.';
      if(validateDefaultModel(parsed,defaultDraft || null).length) errors.defaultModel = 'Mô hình mặc định phải thuộc danh sách mô hình được khai báo và có cấu hình hợp lệ.';
    }
    setModelErrors(errors);
    if(Object.keys(errors).length) { await focusFirstError(errors,{order:['models','defaultModel']}); return; }
    try {
      await update.mutateAsync({provider,patch:{models:parsed,default_model:defaultDraft || null}});
      setEditing(null);
      toast.success('Đã lưu danh sách và mô hình mặc định của nhà cung cấp AI.');
    } catch(error) { setModelSaveError(actionErrorMessage(error,'Chưa xác nhận được kết quả lưu cấu hình mô hình')); }
  };

  const revealModelErrors = (provider: ProviderRow, errors: Record<string, string>) => {
    void focusFirstError(errors, {
      order: ['models', 'defaultModel'],
      reveal: () => {
        if (editing !== provider.provider) {
          setModelsDraft(JSON.stringify(provider.models ?? [], null, 2));
          setDefaultDraft(provider.default_model ?? '');
        }
        setEditing(provider.provider);
        setModelErrors(errors);
        setModelSaveError('');
      },
    });
  };

  // Test key: gửi 1 completion nhỏ qua proxy (đi đủ gate + ghi usage)
  const testKey = async (r: ProviderRow) => {
    const models = Array.isArray(r.models) ? (r.models as any[]) : [];
    const modelId = r.default_model || models[0]?.id;
    if (!modelId) { revealModelErrors(r,{models:'Thêm mô hình trước khi kiểm tra kết nối.'}); return; }
    setTestFeedback(null);
    setTesting(r.provider);
    const t0 = Date.now();
    try {
      const doFetch = makeCopilotFetch('chat', newTaskId('testkey'), selectedOrganizationId);
      const res = await doFetch(`${LLM_PROXY_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `${r.provider}:${modelId}`,
          messages: [{ role: 'user', content: 'Trả lời đúng 1 từ: pong' }],
          max_tokens: 20,
        }),
      });
      const body: unknown = await res.json().catch((): null => null);
      if (!res.ok) throw {status: res.status};
      const completion = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const choices = completion?.choices;
      const first = Array.isArray(choices) && choices.length ? choices[0] : null;
      if (!completion || completion.error || !first?.message || first.message.role !== 'assistant' || typeof first.message.content !== 'string' || !first.message.content.trim()) throw new TypeError('Unconfirmed provider completion receipt');
      toast.success(`${r.label}: OK (${Date.now() - t0}ms)`);
    } catch (e) {
      setTestFeedback({provider:r.provider,message:actionErrorMessage(e, `Chưa xác nhận được kết nối ${r.label}`)});
    } finally {
      setTesting(null);
    }
  };

  if (providersQuery.isError) return <QueryRegion label="cấu hình nhà cung cấp AI" queries={[providersQuery]}><p role="alert">Chưa cập nhật được cấu hình nhà cung cấp AI.</p></QueryRegion>;
  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        API key nạp qua Supabase Edge Function secrets (OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY,
        DEEPSEEK_API_KEY, OPENAI_API_KEY, QWEN_API_KEY, ANTHROPIC_API_KEY) — bảng này chỉ bật/tắt + khai báo model/giá.
      </p>
      {copilotAdminOutcomeUnknown(update.error) && <div role="alert" className="text-sm text-destructive">Chưa xác nhận được kết quả cập nhật nhà cung cấp AI. Giữ bản cấu hình đang nhập và đọc lại dữ liệu trước khi thực hiện tiếp.<Button type="button" variant="outline" onClick={() => void providersQuery.refetch()}>Đọc lại nhà cung cấp</Button></div>}
      {rows?.map((r) => (
        <div key={r.provider} className="rounded border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              disabled={update.isPending || copilotAdminOutcomeUnknown(update.error)}
              checked={r.enabled}
              onCheckedChange={(v) => {
                if (v) {
                  const problems = validateProviderModels(r.models);
                  if (problems.length || (Array.isArray(r.models) && (r.models as ProviderModel[]).some((m) => m.pricing_mode === 'unknown'))) {
                    revealModelErrors(r, { models: 'Kiểm tra cách tính phí và giá của từng mô hình trước khi bật nhà cung cấp.' });
                    return;
                  }
                  const defaultProblems = validateDefaultModel(r.models, r.default_model);
                  if (defaultProblems.length) { revealModelErrors(r, { defaultModel: 'Chọn mô hình mặc định hợp lệ trước khi bật nhà cung cấp.' }); return; }
                }
                update.mutate({ provider: r.provider, patch: { enabled: v } });
              }}
            />
            <span className="font-medium">{r.label}</span>
            {testFeedback?.provider === r.provider && <p role="alert" className="text-sm text-destructive">{testFeedback.message}</p>}
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.provider}</span>
            {r.data_class === 'local_only' && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">local-only</span>}
            <span className="text-xs text-muted-foreground">
              {r.data_class === 'local_only'
                ? `model TỰ PHÁT HIỆN từ instance chạy trên máy người dùng (${r.provider === '9router' ? 'localhost:20128' : 'localhost:11434'})`
                : `${Array.isArray(r.models) ? (r.models as any[]).length : 0} model — mặc định: ${r.default_model ?? '—'}`}
            </span>
            <div className="ml-auto flex gap-2">
              {r.data_class !== 'local_only' && r.provider !== 'mock' && (
                <Button size="sm" variant="outline" disabled={testing === r.provider || !r.enabled} onClick={() => void testKey(r)}>
                  {testing === r.provider ? 'Đang test…' : 'Test key'}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(editing === r.provider ? null : r.provider);
                  setModelsDraft(JSON.stringify(r.models ?? [], null, 2));
                  setDefaultDraft(r.default_model ?? '');
                }}
              >
                Sửa models
              </Button>
            </div>
          </div>
          {r.data_class === 'local_only' && r.enabled && (
            <p className="mt-2 text-xs text-amber-700">
              {r.provider === 'ollama' ? (
                <>Người dùng cần chạy Ollama với biến môi trường <code className="rounded bg-muted px-1">OLLAMA_ORIGINS=*</code> để
                web gọi được (Windows: <code className="rounded bg-muted px-1">setx OLLAMA_ORIGINS *</code> rồi khởi động lại Ollama). </>
              ) : (
                <>Người dùng cần chạy 9Router trên máy (localhost:20128 — CORS mở sẵn). </>
              )}
              Request đi thẳng máy user, KHÔNG qua server — quota/usage log của hệ thống không áp cho provider local.
            </p>
          )}
          {editing === r.provider && (
            <div className="mt-3 space-y-2">
              {Object.entries(modelErrors).map(([field,message]) => <p key={field} id={`copilot-model-${field}-error`} role="alert" className="text-sm text-destructive">{message}</p>)}
              {modelSaveError && <p role="alert" className="text-sm text-destructive">{modelSaveError}</p>}
              {Array.isArray(r.models) && r.models.length > 0 && (
                <div className="rounded bg-muted/40 p-2 text-xs">
                  {(r.models as ProviderModel[]).map((model) => (
                    <div key={String(model.id)} className="flex justify-between gap-2">
                      <span>{String(model.id)} ({String(model.pricing_mode ?? 'missing')})</span>
                      <span>{providerModelCost(model)}</span>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="h-40 w-full rounded border bg-background p-2 font-mono text-xs"
                name="models" aria-invalid={!!modelErrors.models} aria-describedby={modelErrors.models ? "copilot-model-models-error" : undefined} style={modelErrors.models ? {borderColor:"hsl(var(--destructive))"} : undefined}
                value={modelsDraft}
                onChange={(e) => setModelsDraft(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Input name="defaultModel" aria-invalid={!!modelErrors.defaultModel} aria-describedby={modelErrors.defaultModel ? "copilot-model-defaultModel-error" : undefined} className="max-w-sm" placeholder="Mã mô hình mặc định" value={defaultDraft} onChange={(e) => setDefaultDraft(e.target.value)} />
                <Button size="sm" disabled={update.isPending} onClick={() => { void saveModels(r.provider); }}>Lưu</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tab: Sử dụng ─────────────────────────────────────────────────────────────

/**
 * Một thanh hạn mức token. `phanTram === null` nghĩa là hạn mức TẮT (cap = 0
 * theo quy ước của `reserve_ai_usage`) — nói thẳng ra chứ KHÔNG vẽ thanh 0%,
 * vì 0% đọc là "còn nguyên hạn mức", một câu khác hẳn.
 */
function ThanhHanMuc({
  nhan,
  daDung,
  cap,
  ghiChu,
}: {
  nhan: string;
  daDung: number;
  cap: number;
  ghiChu?: string;
}) {
  const phanTram = tinhPhanTramHanMuc(daDung, cap);
  const canhBao = daChamNguongCanhBao(phanTram);
  return (
    <div className="rounded border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{nhan}</span>
        {phanTram === null ? (
          <span className="text-xs text-muted-foreground">Hạn mức đang TẮT (cap = 0)</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {daDung.toLocaleString('vi-VN')} / {cap.toLocaleString('vi-VN')} token · {phanTram}%
          </span>
        )}
      </div>
      {phanTram !== null && (
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
          {/* Bề rộng kẹp ở 100 — con số thật vẫn hiện nguyên ở trên, chỉ cái
              thanh là không tràn ra ngoài khung. */}
          <div
            className={canhBao ? 'h-full bg-red-500' : 'h-full bg-emerald-500'}
            style={{ width: `${Math.min(phanTram, 100)}%` }}
          />
        </div>
      )}
      {canhBao && (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
          ⚠ Đã dùng ≥{MUC_CANH_BAO_PHAN_TRAM}% hạn mức token hôm nay. Chạm trần thì Copilot trả lỗi{' '}
          <code>daily_token_quota</code> đến hết ngày (giờ VN).
        </div>
      )}
      {ghiChu && <div className="mt-1 text-xs text-muted-foreground">{ghiChu}</div>}
    </div>
  );
}

function UsageTab() {
  const usageQuery = useUsage();
  const { data: rows, isLoading } = usageQuery;
  const userIds = useMemo(() => [...new Set((rows ?? []).map((r) => r.user_id))], [rows]);
  const namesQuery = useProfileNames(userIds);
  const { data: names } = namesQuery;
  const { data: user } = useAuth();
  const { data: isSuper } = useIsSuperAdmin();
  const settingsQuery = useSettings();
  const { data: settings } = settingsQuery;
  const dongHomNayQuery = useTokenHomNay();
  const { data: dongHomNay } = dongHomNayQuery;
  const providersGiaQuery = useProvidersGia();
  const { data: providersGia } = providersGiaQuery;
  const tomTat = useMemo(
    () => tomTatTokenHomNay(dongHomNay ?? [], user?.id ?? null, isSuper === true),
    [dongHomNay, user?.id, isSuper],
  );
  const modelSelfHosted = useMemo(() => tapModelSelfHosted(providersGia ?? []), [providersGia]);

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;
  const list = rows ?? [];
  const cost = (r: UsageRow): number | null => {
    if (r.cost_usd === null) return null;
    const value = Number(r.cost_usd);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  // Cột "Quy ước": model self-hosted có giá THẬT bằng 0 (`20260829080000`) nên
  // cột USD của nó luôn $0.00000 và không so sánh được gì. Gán một đơn giá tượng
  // trưng để XẾP HẠNG mức tiêu thụ — chỉ để so sánh, KHÔNG PHẢI HOÁ ĐƠN.
  const chiPhiQuyUoc = (r: UsageRow): string => {
    if (!modelSelfHosted.has(`${r.provider}:${r.model}`)) return '—';
    const v = chiPhiQuyUocSelfHosted(r.total_tokens);
    return v === null ? '—' : `≈$${v.toFixed(5)}`;
  };
  const totalCost = list.reduce<number | null>((s, r) => {
    const value = cost(r);
    return s === null || value === null ? null : s + value;
  }, 0);
  const totalTokens = list.reduce((s, r) => s + (r.total_tokens || 0), 0);

  const byUser = new Map<string, { n: number; tokens: number; cost: number | null }>();
  for (const r of list) {
    const cur = byUser.get(r.user_id) ?? { n: 0, tokens: 0, cost: null as number | null };
    const value = cost(r);
    cur.n += 1; cur.tokens += r.total_tokens || 0;
    cur.cost = cur.cost === null || value === null ? null : cur.cost + value;
    byUser.set(r.user_id, cur);
  }

  return (
    <QueryRegion label="thống kê sử dụng Copilot" queries={[usageQuery, settingsQuery, dongHomNayQuery, providersGiaQuery, ...(userIds.length ? [namesQuery] : [])]}>
    <div className="space-y-4">
      {settings && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Hạn mức token hôm nay (giờ VN)</div>
          <div className="grid gap-2 md:grid-cols-2">
            <ThanhHanMuc
              nhan="Của bạn"
              daDung={tomTat.cuaToi}
              cap={settings.daily_tokens_cap_user}
            />
            <ThanhHanMuc
              nhan={tomTat.laToanHeThong ? 'Toàn hệ thống' : 'Đội của bạn'}
              daDung={tomTat.cuaTenant}
              cap={settings.daily_tokens_cap_tenant}
              ghiChu={
                tomTat.laToanHeThong
                  ? // Gọi tổng toàn hệ thống là "tenant của bạn" là nói sai với
                    // đúng người có quyền tin nó nhất.
                    'Chưa có lượt gọi nào hôm nay gắn với bạn, nên đây là tổng MỌI tenant bạn nhìn thấy (super admin), không phải một tenant.'
                  : tomTat.tenantDayDu
                    ? undefined
                    : 'Bạn chỉ thấy dòng của chính mình (RLS), nên con số này THẤP hơn tổng thật của đội.'
              }
            />
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Request 7 ngày</div><div className="text-lg font-semibold">{list.length}</div></div>
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Tokens</div><div className="text-lg font-semibold">{totalTokens.toLocaleString('vi-VN')}</div></div>
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Chi phí (USD)</div><div className="text-lg font-semibold">{totalCost === null ? 'unknown' : `$${totalCost.toFixed(4)}`}</div></div>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr><th className="p-2">Người dùng</th><th className="p-2">Request</th><th className="p-2">Tokens</th><th className="p-2">USD</th></tr>
          </thead>
          <tbody>
            {[...byUser.entries()].sort((a, b) => (b[1].cost ?? -1) - (a[1].cost ?? -1)).map(([uid, agg]) => (
              <tr key={uid} className="border-t">
                <td className="p-2">{names?.[uid] ?? uid.slice(0, 8)}</td>
                <td className="p-2">{agg.n}</td>
                <td className="p-2">{agg.tokens.toLocaleString('vi-VN')}</td>
                <td className="p-2">{agg.cost === null ? 'unknown' : `$${agg.cost.toFixed(4)}`}</td>
              </tr>
            ))}
            {!list.length && <tr><td className="p-3 text-muted-foreground" colSpan={4}>Chưa có request nào trong 7 ngày.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr><th className="p-2">Thời gian</th><th className="p-2">Người dùng</th><th className="p-2">Model</th><th className="p-2">Feature</th><th className="p-2">Tokens</th><th className="p-2">USD</th><th className="p-2">Quy ước</th><th className="p-2">Trạng thái</th></tr>
          </thead>
          <tbody>
            {list.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t">
                <td className="p-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString('vi-VN')}</td>
                <td className="p-2">{names?.[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                <td className="p-2">{r.provider}:{r.model}</td>
                <td className="p-2">{r.feature}</td>
                <td className="p-2">{r.total_tokens}</td>
                <td className="p-2">{formatUsageCost(r.cost_usd, r.reserved_cost_usd)}</td>
                <td className="p-2 whitespace-nowrap text-muted-foreground">{chiPhiQuyUoc(r)}</td>
                <td className="p-2">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Cột <strong>Quy ước</strong> áp đơn giá {GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN} USD/token cho
        model <code>self_hosted</code> — <strong>chỉ để so sánh, không phải hoá đơn</strong>. Giá
        thật của chúng trong <code>ai_providers</code> là 0 (máy của chính công ty), nên cột USD
        luôn $0 và không xếp hạng được model nào ngốn hơn model nào.
      </p>
    </div>
    </QueryRegion>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AiCopilotAdminPage() {
  const { data: isSuper, isLoading } = useIsSuperAdmin();

  if (isLoading) {
    return <div className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold">AI Copilot</h1>
        <p className="text-sm text-muted-foreground">
          {isSuper
            ? 'Quản trị toàn hệ thống: kill switch, hạn mức, người dùng, providers, chi phí.'
            : 'Thống kê sử dụng AI Copilot (bạn/đội của bạn).'}
        </p>
      </div>
      {isSuper ? (
        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings">Cài đặt</TabsTrigger>
            <TabsTrigger value="rollout">Rollout</TabsTrigger>
            <TabsTrigger value="actions">Hành động</TabsTrigger>
            <TabsTrigger value="users">Người dùng</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="usage">Sử dụng</TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="pt-4"><SettingsTab /></TabsContent>
          <TabsContent value="rollout" className="pt-4"><RolloutTab /></TabsContent>
          {/* Chính sách + sổ hành động (G2-B). Nằm trong nhánh super admin của
              trang nên không cần gác thêm ở đây; RPC phía dưới vẫn tự kiểm. */}
          <TabsContent value="actions" className="pt-4"><HanhDongTab /></TabsContent>
          <TabsContent value="users" className="pt-4"><EntitlementsTab /></TabsContent>
          <TabsContent value="providers" className="pt-4"><ProvidersTab /></TabsContent>
          <TabsContent value="usage" className="pt-4"><UsageTab /></TabsContent>
        </Tabs>
      ) : (
        <UsageTab />
      )}
    </div>
  );
}
