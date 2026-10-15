import { requiresBuildingScope } from '../../../infra/hermes-broker/capability-contract.mjs';
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
import type { HermesCallerScope, HermesConnectionContext, HermesConnectionRestrictions, HermesGrantOptions } from '@/hermes/connectionClient';

const states = { pending: 'Chờ hoàn tất', active: 'Đã cấp kết nối', revoked: 'Đã thu hồi' } as const;

function Restrictions({ context, options, disabled, onSave }: { context: HermesConnectionContext; options: HermesGrantOptions | null; disabled: boolean;
  onSave: (value: HermesConnectionRestrictions, scopeIds: string[]) => void }) {
  const [selected, setSelected] = useState<HermesConnectionRestrictions>(() => ({ read: [...context.restrictions.read], action: [...context.restrictions.action] }));
  const [scopeIds, setScopeIds] = useState([...context.scopeIds]);
  const changed = (['read', 'action'] as const).some(kind => selected[kind].length !== context.restrictions[kind].length) || scopeIds.length !== context.scopeIds.length;
  return <section aria-label="Quyền kết nối" className="space-y-4 rounded-xl border bg-card p-4">
    <h2 className="font-semibold">Quyền của kết nối …{context.id.slice(-8)}</h2>
    <p className="text-sm text-muted-foreground">Chỉ tắt bớt quyền hoặc bỏ phạm vi đã cấp. Để cấp lại quyền đã tắt, hãy tạo kết nối mới và xác nhận mật khẩu ở bên dưới.</p>
    <HermesPermissionFields value={selected} scopeIds={scopeIds} readChoices={context.restrictions.read} actionChoices={context.restrictions.action}
      scopes={(options?.scopes ?? []).filter(scope => context.scopeIds.includes(scope.scopeId))} effective={context.effective} disabled={disabled}
      onChange={(value, scopes) => { setSelected(value); setScopeIds(scopes); }} />
    <Button disabled={disabled || !changed} onClick={() => onSave(selected, scopeIds)}>Lưu giới hạn</Button>
  </section>;
}

function Workspace({ userId, organizationId, email, currentScope }: { userId: string; organizationId: string;
  email: string; currentScope: () => HermesCallerScope }) {
  const model = useHermesConnections(userId, organizationId, currentScope);
  const password = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [botGeneration, setBotGeneration] = useState(0);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [grant, setGrant] = useState<HermesConnectionRestrictions>({ read: ['assistant.context.read'], action: [] });
  const [grantScopes, setGrantScopes] = useState<string[]>([]);
  useEffect(() => {
    if (!model.options) return;
    setGrant(previous => ({ read: previous.read.filter(key => model.options?.read.some(allowed => allowed === key)),
      action: previous.action.filter(key => model.options?.action.some(allowed => allowed === key)) }));
    setGrantScopes(previous => previous.filter(id => model.options?.scopes.some(scope => scope.scopeId === id)));
  }, [model.options]);
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
    setCopied(null); setGrant({ read: [], action: [] }); setGrantScopes([]);
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
  const grantReady = Boolean(model.options?.enabled) && (grant.read.length > 0 || grant.action.length > 0) &&
    grant.read.every(key => model.options?.read.some(allowed => allowed === key)) &&
    grant.action.every(key => model.options?.action.some(allowed => allowed === key)) &&
    (!requiresBuildingScope(grant.read, grant.action) || grantScopes.length > 0) && grantScopes.every(id => model.options?.scopes.some(scope => scope.scopeId === id));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !grantReady || !email || !password.current?.value) return;
    const value = password.current.value;
    password.current.value = ''; setCopied(null);
    void model.connect({ email, password: value, restrictions: { read: [...grant.read], action: [...grant.action] }, scopeIds: requiresBuildingScope(grant.read, grant.action) ? [...grantScopes] : [] });
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
      <p className="text-sm text-muted-foreground">Trạng thái dưới đây là hồ sơ đã lưu; chưa xác nhận Hermes đang chạy.</p>
      <Button variant="outline" disabled={policyBusy || Boolean(model.busy)} onClick={() => { setCopied(null); void model.reload(); }}><RefreshCw className="h-4 w-4" />Tải lại danh sách</Button>
    </div>
    {model.message && <p role="status" className="rounded-lg border bg-muted/50 p-3 text-sm">{model.message}</p>}
    {model.needsReload && <p className="text-sm font-medium">Các thao tác đang tạm dừng đến khi bạn tải lại danh sách thành công.</p>}
    {model.busy && <p role="status" className="text-sm text-muted-foreground">{model.busy === 'list' || model.busy === 'context' ? 'Đang đọc thông tin kết nối…' : 'Đang chờ máy chủ xác nhận…'}</p>}
    {model.connections && <section aria-label="Kết nối của tôi" className="space-y-3">
      {model.connections.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">Chưa có kết nối Hermes trong công ty này.</p>}
      {model.connections.map(connection => <article key={connection.id} aria-label={`Kết nối ${connection.id.slice(-8)}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div><h2 className="font-medium">Kết nối …{connection.id.slice(-8)}</h2>
          <p className="text-sm text-muted-foreground">{states[connection.state]} · {connection.restrictions.read.length} quyền đọc · {connection.restrictions.action.length} quyền thao tác</p></div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={disabled || connection.state !== 'active'} onClick={() => void model.contextFor(connection)}>Xem quyền</Button>
          <Button variant="destructive" size="sm" disabled={disabled || connection.state === 'revoked'} onClick={() => { setCopied(null); void model.revoke(connection); }}>Thu hồi</Button>
        </div>
      </article>)}
    </section>}
    {model.context && <Restrictions key={`${model.context.id}:${model.context.epoch}`} context={model.context} options={model.options} disabled={disabled}
      onSave={(value, scopes) => { if (model.context) void model.restrict(model.context, value, scopes); }} />}
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
      <p className="text-sm text-muted-foreground">Chọn quyền và phạm vi cho Hermes, rồi xác nhận mật khẩu CRM. Kết nối mới không thay đổi quyền của bạn.</p>
      {model.options ? model.options.enabled ? <HermesPermissionFields value={grant} scopeIds={grantScopes} readChoices={model.options.read} actionChoices={model.options.action}
        scopes={model.options.scopes} disabled={disabled} onChange={(value, scopes) => { setGrant(value); setGrantScopes(scopes); }} />
        : <p role="status" className="text-sm">Chính sách công ty đang tắt kết nối Hermes. Người quản trị cần thay đổi chính sách để cho phép kết nối.</p>
        : <p role="status" className="text-sm">Chưa đọc được danh sách quyền và phạm vi được phép cấp. Tải lại danh sách trước khi tạo kết nối.</p>}
      {grant.read.includes('rooms.view') && !grantScopes.length && <p className="text-sm">Chọn ít nhất một phạm vi để cho Hermes đọc phòng.</p>}
      <form aria-label="Tạo kết nối Hermes" onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="hermes-email">Tài khoản CRM</Label>
        <Input id="hermes-email" value={email} readOnly autoComplete="username" /></div>
        <div className="space-y-1"><Label htmlFor="hermes-password">Xác nhận mật khẩu CRM</Label>
          <Input ref={password} id="hermes-password" type="password" required maxLength={4096} autoComplete="off" disabled={disabled || !email} /></div></div>
      {!email && <p className="text-sm text-muted-foreground">Phiên hiện tại chưa có email đăng nhập để xác minh kết nối.</p>}
      <p className="text-xs text-muted-foreground">Mật khẩu chỉ dùng cho yêu cầu xác minh này và được xóa khỏi ô nhập ngay khi gửi.</p>
      <Button type="submit" disabled={disabled || !email || !grantReady}><Bot className="h-4 w-4" />Tạo kết nối</Button>
      </form>
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
