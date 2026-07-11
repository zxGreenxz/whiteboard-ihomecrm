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

// ── Data hooks ───────────────────────────────────────────────────────────────

interface SettingsRow {
  chat_enabled: boolean;
  ui_control_enabled: boolean;
  rate_per_min: number;
  daily_usd_cap_user: number;
  daily_usd_cap_tenant: number;
  daily_usd_cap_global: number;
}

const useSettings = () =>
  useQuery({
    queryKey: ['ai-copilot-settings'],
    queryFn: async (): Promise<SettingsRow | null> => {
      const { data, error } = await supabase
        .from('ai_copilot_settings')
        .select('chat_enabled, ui_control_enabled, rate_per_min, daily_usd_cap_user, daily_usd_cap_tenant, daily_usd_cap_global')
        .maybeSingle();
      if (error) throw error;
      return data as SettingsRow | null;
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
      const rows = (data ?? []) as EntitlementRow[];
      if (!rows.length) return rows;
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .in('id', rows.map((r) => r.user_id));
      const byId = new Map((profs ?? []).map((p: any) => [p.id, p]));
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

const useProvidersAdmin = (enabled: boolean) =>
  useQuery({
    queryKey: ['ai-providers-admin'],
    enabled,
    queryFn: async (): Promise<ProviderRow[]> => {
      const { data, error } = await supabase
        .from('ai_providers')
        .select('provider, enabled, label, models, default_model, data_class')
        .order('provider');
      if (error) throw error;
      return (data ?? []) as ProviderRow[];
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
  reserved_cost_usd: number;
  status: string;
  created_at: string;
}

const useUsage = () =>
  useQuery({
    queryKey: ['ai-usage-7d'],
    queryFn: async (): Promise<UsageRow[]> => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('ai_usage_logs')
        .select('user_id, owner_id, provider, model, feature, total_tokens, cost_usd, reserved_cost_usd, status, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as UsageRow[];
    },
  });

const useProfileNames = (ids: string[]) =>
  useQuery({
    queryKey: ['profiles-brief', [...ids].sort()],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', ids);
      return Object.fromEntries((data ?? []).map((p: any) => [p.id, p.full_name || p.email || p.id.slice(0, 8)]));
    },
  });

// ── Tab: Cài đặt ─────────────────────────────────────────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useSettings();
  const [draft, setDraft] = useState<SettingsRow | null>(null);
  const cur = draft ?? settings ?? null;

  const save = useMutation({
    mutationFn: async (s: SettingsRow) => {
      const { error } = await supabase
        .from('ai_copilot_settings')
        .update({ ...s, updated_at: new Date().toISOString() })
        .eq('id', true);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt');
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['ai-copilot-settings'] });
    },
    onError: (e: Error) => toast.error(`Lỗi lưu cài đặt: ${e.message}`),
  });

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;
  if (!cur) return <div className="text-sm text-red-600">Chưa có dòng cài đặt (seed migration 20260710200000).</div>;

  const set = (patch: Partial<SettingsRow>) => setDraft({ ...cur, ...patch });
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-center justify-between rounded border p-3">
        <div>
          <div className="font-medium text-sm">Chat (kill switch toàn hệ thống)</div>
          <div className="text-xs text-muted-foreground">Tắt = mọi user mất chat ngay lập tức</div>
        </div>
        <Switch checked={cur.chat_enabled} onCheckedChange={(v) => set({ chat_enabled: v })} />
      </div>
      <div className="flex items-center justify-between rounded border p-3">
        <div>
          <div className="font-medium text-sm">Điều khiển UI (experimental)</div>
          <div className="text-xs text-muted-foreground">Tắt = mọi user mất UI-control ngay</div>
        </div>
        <Switch checked={cur.ui_control_enabled} onCheckedChange={(v) => set({ ui_control_enabled: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          Rate limit (request/phút/user)
          <Input type="number" value={cur.rate_per_min} onChange={(e) => set({ rate_per_min: Math.max(1, Math.round(num(e.target.value))) })} />
        </label>
        <label className="text-sm">
          Cap USD/ngày mỗi USER
          <Input type="number" step="0.1" value={cur.daily_usd_cap_user} onChange={(e) => set({ daily_usd_cap_user: num(e.target.value) })} />
        </label>
        <label className="text-sm">
          Cap USD/ngày mỗi TENANT
          <Input type="number" step="0.1" value={cur.daily_usd_cap_tenant} onChange={(e) => set({ daily_usd_cap_tenant: num(e.target.value) })} />
        </label>
        <label className="text-sm">
          Cap USD/ngày TOÀN HỆ THỐNG
          <Input type="number" step="0.1" value={cur.daily_usd_cap_global} onChange={(e) => set({ daily_usd_cap_global: num(e.target.value) })} />
        </label>
      </div>
      <Button disabled={!draft || save.isPending} onClick={() => cur && save.mutate(cur)}>
        {save.isPending ? 'Đang lưu…' : 'Lưu cài đặt'}
      </Button>
    </div>
  );
}

// ── Tab: Người dùng (entitlements) ───────────────────────────────────────────

function EntitlementsTab() {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useEntitlements(true);
  const [email, setEmail] = useState('');

  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-copilot-entitlements-admin'] });

  const add = useMutation({
    mutationFn: async (em: string) => {
      const { data: prof, error: pErr } = await supabase
        .from('profiles')
        .select('id, email')
        .ilike('email', em.trim())
        .maybeSingle();
      if (pErr) throw pErr;
      if (!prof) throw new Error(`Không tìm thấy user với email "${em}"`);
      const { error } = await supabase
        .from('ai_copilot_entitlements')
        .insert({ user_id: prof.id, chat_enabled: true, ui_control_enabled: false });
      if (error) throw error;
    },
    onSuccess: () => { toast.success('Đã cấp quyền chat'); setEmail(''); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: async (p: { user_id: string; field: 'chat_enabled' | 'ui_control_enabled'; value: boolean }) => {
      const { error } = await supabase
        .from('ai_copilot_entitlements')
        .update({ [p.field]: p.value })
        .eq('user_id', p.user_id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (user_id: string) => {
      const { error } = await supabase.from('ai_copilot_entitlements').delete().eq('user_id', user_id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success('Đã thu hồi (hiệu lực ngay)'); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-4">
      <div className="flex max-w-md gap-2">
        <Input placeholder="Email user cần cấp quyền…" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button disabled={!email.trim() || add.isPending} onClick={() => add.mutate(email)}>Cấp quyền</Button>
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
                  <Switch checked={r.chat_enabled} onCheckedChange={(v) => toggle.mutate({ user_id: r.user_id, field: 'chat_enabled', value: v })} />
                </td>
                <td className="p-2">
                  <Switch checked={r.ui_control_enabled} onCheckedChange={(v) => toggle.mutate({ user_id: r.user_id, field: 'ui_control_enabled', value: v })} />
                </td>
                <td className="p-2 text-right">
                  <Button variant="destructive" size="sm" onClick={() => remove.mutate(r.user_id)}>Thu hồi</Button>
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
  const { data: rows, isLoading } = useProvidersAdmin(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [modelsDraft, setModelsDraft] = useState('');
  const [defaultDraft, setDefaultDraft] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-providers-admin'] });

  const update = useMutation({
    mutationFn: async (p: { provider: string; patch: Record<string, unknown> }) => {
      const { error } = await supabase
        .from('ai_providers')
        .update({ ...p.patch, updated_at: new Date().toISOString() })
        .eq('provider', p.provider);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const saveModels = (provider: string) => {
    try {
      const parsed = JSON.parse(modelsDraft);
      if (!Array.isArray(parsed)) throw new Error('models phải là mảng [{id,label,input_price,output_price}]');
      update.mutate({ provider, patch: { models: parsed, default_model: defaultDraft || null } });
      setEditing(null);
      toast.success('Đã lưu models');
    } catch (e) {
      toast.error(`JSON không hợp lệ: ${e instanceof Error ? e.message : e}`);
    }
  };

  // Test key: gửi 1 completion nhỏ qua proxy (đi đủ gate + ghi usage)
  const testKey = async (r: ProviderRow) => {
    const models = Array.isArray(r.models) ? (r.models as any[]) : [];
    const modelId = r.default_model || models[0]?.id;
    if (!modelId) { toast.error('Provider chưa khai báo model nào'); return; }
    setTesting(r.provider);
    const t0 = Date.now();
    try {
      const doFetch = makeCopilotFetch('chat', newTaskId('testkey'));
      const res = await doFetch(`${LLM_PROXY_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `${r.provider}:${modelId}`,
          messages: [{ role: 'user', content: 'Trả lời đúng 1 từ: pong' }],
          max_tokens: 20,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) toast.success(`${r.label}: OK (${Date.now() - t0}ms)`);
      else toast.error(`${r.label}: HTTP ${res.status} — ${body?.error?.message ?? 'lỗi'}`);
    } catch (e) {
      toast.error(`${r.label}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setTesting(null);
    }
  };

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        API key nạp qua Supabase Edge Function secrets (OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY,
        DEEPSEEK_API_KEY, OPENAI_API_KEY, QWEN_API_KEY, ANTHROPIC_API_KEY) — bảng này chỉ bật/tắt + khai báo model/giá.
      </p>
      {rows?.map((r) => (
        <div key={r.provider} className="rounded border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <Switch checked={r.enabled} onCheckedChange={(v) => update.mutate({ provider: r.provider, patch: { enabled: v } })} />
            <span className="font-medium">{r.label}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.provider}</span>
            {r.data_class === 'local_only' && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">local-only</span>}
            <span className="text-xs text-muted-foreground">
              {Array.isArray(r.models) ? (r.models as any[]).length : 0} model — mặc định: {r.default_model ?? '—'}
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
          {editing === r.provider && (
            <div className="mt-3 space-y-2">
              <textarea
                className="h-40 w-full rounded border bg-background p-2 font-mono text-xs"
                value={modelsDraft}
                onChange={(e) => setModelsDraft(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Input className="max-w-sm" placeholder="default_model (model id)" value={defaultDraft} onChange={(e) => setDefaultDraft(e.target.value)} />
                <Button size="sm" onClick={() => saveModels(r.provider)}>Lưu</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tab: Sử dụng ─────────────────────────────────────────────────────────────

function UsageTab() {
  const { data: rows, isLoading } = useUsage();
  const userIds = useMemo(() => [...new Set((rows ?? []).map((r) => r.user_id))], [rows]);
  const { data: names } = useProfileNames(userIds);

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;
  const list = rows ?? [];
  const cost = (r: UsageRow) => Number(r.cost_usd ?? r.reserved_cost_usd) || 0;
  const totalCost = list.reduce((s, r) => s + cost(r), 0);
  const totalTokens = list.reduce((s, r) => s + (r.total_tokens || 0), 0);

  const byUser = new Map<string, { n: number; tokens: number; cost: number }>();
  for (const r of list) {
    const cur = byUser.get(r.user_id) ?? { n: 0, tokens: 0, cost: 0 };
    cur.n += 1; cur.tokens += r.total_tokens || 0; cur.cost += cost(r);
    byUser.set(r.user_id, cur);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Request 7 ngày</div><div className="text-lg font-semibold">{list.length}</div></div>
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Tokens</div><div className="text-lg font-semibold">{totalTokens.toLocaleString('vi-VN')}</div></div>
        <div className="rounded border p-3"><div className="text-xs text-muted-foreground">Chi phí (USD)</div><div className="text-lg font-semibold">${totalCost.toFixed(4)}</div></div>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr><th className="p-2">Người dùng</th><th className="p-2">Request</th><th className="p-2">Tokens</th><th className="p-2">USD</th></tr>
          </thead>
          <tbody>
            {[...byUser.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([uid, agg]) => (
              <tr key={uid} className="border-t">
                <td className="p-2">{names?.[uid] ?? uid.slice(0, 8)}</td>
                <td className="p-2">{agg.n}</td>
                <td className="p-2">{agg.tokens.toLocaleString('vi-VN')}</td>
                <td className="p-2">${agg.cost.toFixed(4)}</td>
              </tr>
            ))}
            {!list.length && <tr><td className="p-3 text-muted-foreground" colSpan={4}>Chưa có request nào trong 7 ngày.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr><th className="p-2">Thời gian</th><th className="p-2">Người dùng</th><th className="p-2">Model</th><th className="p-2">Feature</th><th className="p-2">Tokens</th><th className="p-2">USD</th><th className="p-2">Trạng thái</th></tr>
          </thead>
          <tbody>
            {list.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t">
                <td className="p-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString('vi-VN')}</td>
                <td className="p-2">{names?.[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                <td className="p-2">{r.provider}:{r.model}</td>
                <td className="p-2">{r.feature}</td>
                <td className="p-2">{r.total_tokens}</td>
                <td className="p-2">${cost(r).toFixed(5)}</td>
                <td className="p-2">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
            <TabsTrigger value="users">Người dùng</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="usage">Sử dụng</TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="pt-4"><SettingsTab /></TabsContent>
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
