import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { HermesPermissionFields } from '@/hermes/HermesPermissionFields';
import { HermesOrgPolicySettings } from '@/hermes/HermesOrgPolicySettings';
import { useHermesConnections } from '@/hermes/useHermesConnections';
import { HermesWorkAssistant } from '@/hermes/HermesWorkAssistant';
import { HermesZaloBindings } from '@/hermes/HermesZaloBindings';
import { HermesZaloBotSettings } from '@/hermes/HermesZaloBotSettings';
import { HermesDeliveryReconcile } from '@/hermes/HermesDeliveryReconcile';
import type { HermesCallerScope, HermesConnectionContext, HermesConnectionMetadata, HermesConnectionRestrictions, HermesConnectionStatus,
  HermesConnectorStatus, HermesGrantOptions, HermesSettingsInput } from '@/hermes/connectionClient';

const states = { pending: 'Chờ hoàn tất', active: 'Đã cấp kết nối', revoked: 'Đã thu hồi' } as const;

const errorLabels: Record<string, string> = {
  unauthorized: 'kết nối hết hạn hoặc đã bị thu hồi', forbidden: 'không đủ quyền CRM', context_changed: 'quyền hoặc kết nối vừa thay đổi',
  rate_limited: 'gọi quá nhiều lần trong một phút', busy: 'connector đang bận', timeout: 'quá thời gian xử lý',
  backend_unavailable: 'dịch vụ CRM tạm không phản hồi', tool_not_available: 'công cụ chưa được cấp quyền', invalid_request: 'yêu cầu không hợp lệ',
};
const errorLabel = (code: string) => Object.prototype.hasOwnProperty.call(errorLabels, code) ? errorLabels[code]
  : code.endsWith('_outcome_unknown') ? 'chưa xác định kết quả thao tác' : code;
const when = (value: number) => new Date(value).toLocaleString('vi-VN');

function connectorSummary(status: HermesConnectorStatus | null, failed: boolean) {
  if (status) return `Connector CRM phiên bản ${status.connector.version} đang chạy từ ${when(status.connector.startedAt)}. Thời điểm Hermes gọi CRM chỉ tính từ lần khởi động này.`;
  return failed ? 'Chưa đọc được trạng thái connector CRM; trạng thái dưới đây là hồ sơ đã lưu.' : 'Trạng thái dưới đây là hồ sơ đã lưu.';
}

/** Connector-memory observations only; absence means "not seen since start", never proof of health. */
function ConnectionActivity({ connection, status }: { connection: HermesConnectionMetadata; status: HermesConnectionStatus | undefined }) {
  const lastSuccessAt = status?.lastSuccessAt ?? null, lastToolCallAt = status?.lastToolCallAt ?? null;
  return <>
    {lastSuccessAt !== null
      ? <p className="text-sm text-muted-foreground">Hermes gọi CRM lần cuối lúc {when(lastSuccessAt)}{lastToolCallAt !== null && ` · dùng công cụ CRM lần cuối lúc ${when(lastToolCallAt)}`}</p>
      : connection.state === 'active' && <p className="text-sm text-muted-foreground">Chưa ghi nhận Hermes gọi CRM kể từ khi connector khởi động.</p>}
    {status && status.lastErrorCode !== null && status.lastErrorAt !== null &&
      <p className="text-sm text-muted-foreground">Lỗi gần nhất lúc {when(status.lastErrorAt)}: {errorLabel(status.lastErrorCode)}</p>}
  </>;
}

type Limits = Pick<HermesSettingsInput, 'exclusions' | 'scopeMode' | 'scopeIds'>;
const freshLimits = (): Limits => ({ exclusions: { read: [], action: [] }, scopeMode: 'unrestricted', scopeIds: [] });
function InheritedLimits({ value, options, disabled, effective, onChange }: { value: Limits; options: HermesGrantOptions;
  disabled: boolean; effective?: HermesConnectionRestrictions; onChange: (value: Limits) => void }) {
  const selected = { read: options.read.filter(key => !value.exclusions.read.includes(key)),
    action: options.action.filter(key => !value.exclusions.action.includes(key)) };
  const hidden = (['read', 'action'] as const).reduce((count, kind) => count + value.exclusions[kind].filter(key => !options[kind].includes(key)).length, 0);
  return <div className="space-y-3">
    <p className="text-sm">Theo quyền CRM của tôi. Bỏ chọn để tắt riêng cho Hermes; chọn lại để khôi phục quyền CRM đang có. Quyền CRM được cấp sau này cũng tự áp dụng, trừ phần đã tắt.</p>
    {hidden > 0 && <p className="text-sm text-muted-foreground">Đang giữ {hidden} quyền đã tắt chưa có trong danh sách CRM hiện tại.</p>}
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.scopeMode === 'restricted'} disabled={disabled}
      onChange={event => onChange({ ...value, scopeMode: event.target.checked ? 'restricted' : 'unrestricted', scopeIds: [] })} />Giới hạn phạm vi riêng cho Hermes</label>
    <p className="text-sm text-muted-foreground">{value.scopeMode === 'unrestricted' ? 'Theo toàn bộ phạm vi CRM hiện tại của tôi.'
      : value.scopeIds.length === 0 ? 'Chưa chọn phạm vi: Hermes không được truy cập dữ liệu cần phạm vi.' : 'Hermes chỉ dùng các phạm vi đã chọn, trong quyền CRM hiện tại.'}</p>
    <div className={value.scopeMode === 'unrestricted' ? '[&>div>fieldset:last-child]:hidden' : undefined}>
      <HermesPermissionFields value={selected} scopeIds={value.scopeIds} readChoices={options.read} actionChoices={options.action}
        scopes={options.scopes} effective={effective} disabled={disabled} onChange={(next, scopeIds) => onChange({ ...value, scopeIds,
          exclusions: { read: [...value.exclusions.read.filter(key => !options.read.includes(key)), ...options.read.filter(key => !next.read.includes(key))],
            action: [...value.exclusions.action.filter(key => !options.action.includes(key)), ...options.action.filter(key => !next.action.includes(key))] } })} />
    </div>
  </div>;
}
function ConnectionPermissions({ context, options, disabled, onSave, onSettings }: { context: HermesConnectionContext; options: HermesGrantOptions | null;
  disabled: boolean; onSave: (value: HermesConnectionRestrictions, scopeIds: string[]) => void; onSettings: (value: Limits) => void }) {
  const inherited = context.permissionMode === 'inherit_crm';
  const [transition, setTransition] = useState(false);
  const [value, setValue] = useState<Limits>(() => inherited ? { exclusions: context.exclusions ?? { read: [], action: [] },
    scopeMode: context.scopeMode ?? 'restricted', scopeIds: context.scopeMode === 'unrestricted' ? [] : [...context.scopeIds] } : freshLimits());
  if (!inherited && !transition) return <div className="space-y-3"><Restrictions context={context} options={options} disabled={disabled} onSave={onSave} />
    <Button variant="outline" disabled={disabled} onClick={() => setTransition(true)}>Chuyển sang theo quyền CRM</Button></div>;
  const changed = !inherited || JSON.stringify(value) !== JSON.stringify({ exclusions: context.exclusions,
    scopeMode: context.scopeMode, scopeIds: context.scopeMode === 'unrestricted' ? [] : context.scopeIds });
  return <section aria-label="Giới hạn cho Hermes" className="space-y-3 rounded-xl border bg-card p-4">
    <h2 className="font-semibold">Giới hạn cho Hermes</h2>
    {!inherited && <><p className="text-sm">Kết nối cũ dùng danh sách quyền đã cấp. Chuyển đổi sẽ theo quyền CRM hiện tại và quyền được cấp sau này, chỉ trừ những quyền bạn tắt ở đây. Các quyền không có trong danh sách cũ không tự trở thành quyền bị tắt.</p>
      </>}
    {options && <InheritedLimits value={value} options={options} effective={context.effective} disabled={disabled} onChange={setValue} />}
    <Button disabled={disabled || !options || !changed} onClick={() => onSettings(value)}>{inherited ? 'Lưu giới hạn cho Hermes' : 'Áp dụng quyền web và giới hạn đã chọn'}</Button>
  </section>;
}

function Restrictions({ context, options, disabled, onSave }: { context: HermesConnectionContext; options: HermesGrantOptions | null; disabled: boolean;
  onSave: (value: HermesConnectionRestrictions, scopeIds: string[]) => void }) {
  const [selected, setSelected] = useState<HermesConnectionRestrictions>(() => ({ read: [...context.restrictions.read], action: [...context.restrictions.action] }));
  const [scopeIds, setScopeIds] = useState([...context.scopeIds]);
  const changed = (['read', 'action'] as const).some(kind => selected[kind].length !== context.restrictions[kind].length) || scopeIds.length !== context.scopeIds.length;
  return <section aria-label="Quyền kết nối" className="space-y-4 rounded-xl border bg-card p-4">
    <h2 className="font-semibold">Quyền của kết nối …{context.id.slice(-8)}</h2>
    <p className="text-sm text-muted-foreground">Kết nối này dùng danh sách quyền đã cấp. Có thể tắt bớt ở đây hoặc chuyển sang theo quyền CRM để bật lại giới hạn trên cùng kết nối.</p>
    <HermesPermissionFields value={selected} scopeIds={scopeIds} readChoices={context.restrictions.read} actionChoices={context.restrictions.action}
      scopes={(options?.scopes ?? []).filter(scope => context.scopeIds.includes(scope.scopeId))} effective={context.effective} disabled={disabled}
      onChange={(value, scopes) => { setSelected(value); setScopeIds(scopes); }} />
    <Button disabled={disabled || !changed} onClick={() => onSave(selected, scopeIds)}>Lưu giới hạn</Button>
  </section>;
}

function Workspace({ userId, organizationId, email, currentScope }: { userId: string; organizationId: string;
  email: string; currentScope: () => HermesCallerScope }) {
  const model = useHermesConnections(userId, organizationId, currentScope);
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => {
    if (createOpen && model.optionsState === 'idle' && model.busy !== 'list' && !model.needsReload) void model.ensureOptions();
  }, [createOpen, model.optionsState, model.busy, model.needsReload, model.ensureOptions]);
  const password = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [botGeneration, setBotGeneration] = useState(0);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [limits, setLimits] = useState<Limits>(freshLimits);
  const botConfigurationChanged = useCallback(() => setBotGeneration(value => value + 1), []);
  const lifetime = useRef({ alive: true, generation: 0 });
  const handoffId = useRef<string | null>(null);
  handoffId.current = model.handoff?.connection.id ?? null;
  useLayoutEffect(() => {
    const value = lifetime.current; value.alive = true;
    return () => { value.alive = false; value.generation++; handoffId.current = null; if (password.current) password.current.value = ''; };
  }, []);
  const clearPolicyAuthority = () => {
    lifetime.current.generation++; handoffId.current = null;
    if (password.current) password.current.value = '';
    setCopied(null); setLimits(freshLimits());
    setBotGeneration(value => value + 1);
  };
  const policyChanging = () => {
    setPolicyBusy(true); clearPolicyAuthority(); model.invalidatePolicy();
  };
  const policyChanged = () => {
    setPolicyBusy(false); clearPolicyAuthority();
    void model.policyChanged();
  };
  const disabled = policyBusy || Boolean(model.busy) || model.needsReload || model.connections === null;
  const grantReady = model.optionsState === 'ready' && Boolean(model.options?.enabled);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !grantReady || !email || !password.current?.value) return;
    const value = password.current.value;
    password.current.value = ''; setCopied(null);
    void model.connect({ email, password: value, permissionMode: 'inherit_crm', exclusions: limits.exclusions, scopeMode: limits.scopeMode, scopeIds: limits.scopeIds });
  };
  const copyHandoff = async () => {
    const handoff = model.handoff, scope = { ...currentScope() }, generation = lifetime.current.generation;
    if (!handoff || scope.userId !== userId || scope.organizationId !== organizationId || handoff.tokenExpiresAt <= Date.now()) return;
    try {
      await navigator.clipboard.writeText(handoff.token);
      const current = currentScope();
      if (lifetime.current.alive && lifetime.current.generation === generation && handoffId.current === handoff.connection.id && current.generation === scope.generation &&
          current.userId === userId && current.organizationId === organizationId) setCopied('Đã sao chép mã kết nối.');
    } catch {
      if (lifetime.current.alive && lifetime.current.generation === generation && handoffId.current === handoff.connection.id && currentScope().generation === scope.generation) {
        setCopied('Chưa sao chép được. Bạn có thể chọn mã và sao chép thủ công.');
      }
    }
  };
  return <div className="max-w-4xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{connectorSummary(model.connectorStatus, model.connectorStatusError)}</p>
      <Button variant="outline" disabled={policyBusy || Boolean(model.busy)} onClick={() => { setCopied(null); void model.reload(); }}><RefreshCw className="h-4 w-4" />Tải lại danh sách</Button>
    </div>
    {model.message && <p role="status" className="rounded-lg border bg-muted/50 p-3 text-sm">{model.message}</p>}
    {model.needsReload && <p className="text-sm font-medium">Các thao tác đang tạm dừng đến khi bạn tải lại danh sách thành công.</p>}
    {model.busy && <p role="status" className="text-sm text-muted-foreground">{model.busy === 'list' || model.busy === 'context' ? 'Đang đọc thông tin kết nối…' : 'Đang chờ máy chủ xác nhận…'}</p>}
    {model.connections && <section aria-label="Kết nối của tôi" className="space-y-3">
      {model.connections.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">Chưa có kết nối Hermes trong công ty này.</p>}
      {model.connections.map(connection => <article key={connection.id} aria-label={`Kết nối ${connection.id.slice(-8)}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div><h2 className="font-medium">Kết nối …{connection.id.slice(-8)}</h2>
          <p className="text-sm text-muted-foreground">{states[connection.state]} · {connection.restrictions.read.length} quyền đọc · {connection.restrictions.action.length} quyền thao tác</p>
          {model.connectorStatus && <ConnectionActivity connection={connection}
            status={model.connectorStatus.connections.find(item => item.id === connection.id)} />}</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={disabled || connection.state !== 'active'} onClick={() => void model.contextFor(connection)}>Xem quyền</Button>
          <Button variant="destructive" size="sm" disabled={disabled || connection.state === 'revoked'} onClick={() => { setCopied(null); void model.revoke(connection); }}>Thu hồi</Button>
        </div>
      </article>)}
    </section>}
    {model.context && !createOpen && model.optionsState === 'loading' && <p role="status">Đang tải danh sách quyền và phạm vi được phép cấp…</p>}
    {model.context && !createOpen && model.optionsState === 'error' && <div><p role="alert">Chưa đọc được danh sách quyền và phạm vi được phép cấp.</p>
      <Button variant="outline" onClick={() => void model.ensureOptions()}>Thử tải lại quyền</Button></div>}
    {model.context && <ConnectionPermissions key={`${model.context.id}:${model.context.epoch}`} context={model.context} options={model.options} disabled={disabled}
      onSave={(value, scopes) => { if (model.context) void model.restrict(model.context, value, scopes); }}
      onSettings={value => { if (model.context) void model.settings({ connectionId: model.context.id, expectedEpoch: model.context.epoch, permissionMode: 'inherit_crm', ...value }); }} />}
    {model.handoff && <section aria-label="Mã kết nối một lần" className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-5 w-5" />Mã kết nối chỉ hiển thị lần này</h2>
      <p className="text-sm">Dùng mã để cấu hình Hermes của bạn. Chỉ sao chép vào nơi bạn quản lý; mã không được lưu trong trình duyệt và không thể xem lại ở đây.</p>
      <Label htmlFor="hermes-handoff">Mã kết nối</Label>
      <Input id="hermes-handoff" value={model.handoff.token} readOnly autoComplete="off" className="font-mono" />
      <p className="text-xs text-muted-foreground">Hạn hiện tại: {new Date(model.handoff.tokenExpiresAt).toLocaleString('vi-VN')}. Mã sẽ ẩn khi hết hạn, đổi tài khoản/công ty hoặc rời trang.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={() => void copyHandoff()}><Copy className="h-4 w-4" />Sao chép mã</Button>
        <Button variant="outline" onClick={() => { model.clearHandoff(); setCopied(null); }}>Đã lưu, ẩn mã</Button></div>
      {copied && <p role="status" className="text-sm">{copied}</p>}
    </section>}
    <HermesWorkAssistant userId={userId} organizationId={organizationId} currentScope={currentScope} />
    <HermesOrgPolicySettings userId={userId} organizationId={organizationId} currentScope={currentScope}
      onPolicyChanging={policyChanging} onPolicyChanged={policyChanged} />
    <HermesZaloBotSettings userId={userId} organizationId={organizationId} currentScope={currentScope} onConfigurationChanged={botConfigurationChanged} />
    {model.connections && <HermesZaloBindings key={botGeneration} userId={userId} organizationId={organizationId} currentScope={currentScope}
      connections={model.connections} disabled={disabled} />}
    <HermesDeliveryReconcile userId={userId} organizationId={organizationId} currentScope={currentScope} />
    <section aria-label="Cấp quyền Hermes mới" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">Kết nối Hermes của tôi</h2>
      <p className="text-sm text-muted-foreground">Theo quyền CRM của tôi. Bạn có thể tắt bớt quyền hoặc giới hạn phạm vi riêng cho Hermes, rồi xác nhận mật khẩu CRM.</p>
      <Button variant="outline" aria-expanded={createOpen} onClick={() => setCreateOpen(value => !value)}>{createOpen ? 'Đóng tạo kết nối' : 'Mở tạo kết nối'}</Button>
      {createOpen && <>
      {model.optionsState === 'ready' && model.options ? model.options.enabled ? <InheritedLimits value={limits} options={model.options} disabled={disabled} onChange={setLimits} />
        : <p role="status" className="text-sm">Chính sách công ty đang tắt kết nối Hermes. Người quản trị cần thay đổi chính sách để cho phép kết nối.</p>
        : model.optionsState === 'error' ? <div><p role="alert" className="text-sm">Chưa đọc được danh sách quyền và phạm vi được phép cấp.</p>
          <Button variant="outline" onClick={() => void model.ensureOptions()}>Thử tải lại quyền</Button></div>
        : <p role="status" className="text-sm">Đang tải danh sách quyền và phạm vi được phép cấp…</p>}
      <form aria-label="Tạo kết nối Hermes" onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="hermes-email">Tài khoản CRM</Label>
        <Input id="hermes-email" value={email} readOnly autoComplete="username" /></div>
        <div className="space-y-1"><Label htmlFor="hermes-password">Xác nhận mật khẩu CRM</Label>
          <Input ref={password} id="hermes-password" type="password" required maxLength={4096} autoComplete="off" disabled={disabled || !email} /></div></div>
      {!email && <p className="text-sm text-muted-foreground">Phiên hiện tại chưa có email đăng nhập để xác minh kết nối.</p>}
      <p className="text-xs text-muted-foreground">Mật khẩu chỉ dùng cho yêu cầu xác minh này và được xóa khỏi ô nhập ngay khi gửi.</p>
      <Button type="submit" disabled={disabled || !email || !grantReady}><Bot className="h-4 w-4" />Tạo kết nối</Button>
      </form>
      </>}
    </section>
  </div>;
}

export default function HermesConnectionsPage() {
  const auth = useAuth(), organization = useOrganization();
  const ready = !auth.isLoading && !auth.isError && !organization.isLoading && !organization.isError;
  const userId = ready ? auth.data?.id ?? null : null;
  const organizationId = ready ? organization.selectedOrganizationId : null;
  const live = useRef(true);
  const scope = useRef<HermesCallerScope>({ userId, organizationId, generation: 0 });
  // Invalidate during render, before a previous workspace's late continuation
  // can commit under a newly selected account/company. Returning A -> B -> A
  // increments the generation twice instead of accepting an old A response.
  if (scope.current.userId !== userId || scope.current.organizationId !== organizationId) {
    scope.current = { userId, organizationId, generation: scope.current.generation + 1 };
  }
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; scope.current.generation++; };
  }, []);
  const currentScope = useCallback(() => live.current ? { ...scope.current }
    : { userId: null, organizationId: null, generation: scope.current.generation }, []);
  return <MainLayout title="Trợ lý Hermes" subtitle={`Kết nối của tôi${organization.organization?.name ? ` tại ${organization.organization.name}` : ''}`} icon={Bot}>
    {auth.isLoading || organization.isLoading ? <p role="status">Đang kiểm tra tài khoản và công ty…</p>
      : !ready ? <p role="alert">Chưa kiểm tra được tài khoản hoặc công ty. Hãy tải lại trang.</p>
      : !userId ? <p role="alert">Hãy đăng nhập CRM để quản lý kết nối của bạn.</p>
      : !organizationId ? <p role="status">Chọn công ty ở bộ chọn công ty trước khi quản lý Hermes.</p>
      : <Workspace key={`${userId}:${organizationId}:${scope.current.generation}`} userId={userId} organizationId={organizationId}
        email={auth.data?.email ?? ''} currentScope={currentScope} />}
  </MainLayout>;
}
