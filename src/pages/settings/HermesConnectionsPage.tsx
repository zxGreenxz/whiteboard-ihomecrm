import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { VISIBLE_PAGE_GROUPS, featureKey } from '@/lib/permissionPages';
import { useHermesConnections } from '@/hermes/useHermesConnections';
import { HermesZaloBindings } from '@/hermes/HermesZaloBindings';
import { HermesZaloBotSettings } from '@/hermes/HermesZaloBotSettings';
import type { HermesCallerScope, HermesConnectionContext, HermesConnectionRestrictions } from '@/hermes/connectionClient';

const labels = new Map<string, string>(VISIBLE_PAGE_GROUPS.flatMap(group => group.pages.flatMap(page =>
  page.features.map(feature => [featureKey(feature), `${page.label} · ${feature.label}`] as const))));
labels.set('assistant.context.read', 'Xem thông tin phiên và quyền của tôi');
const name = (capability: string) => labels.get(capability) ?? capability;
const states = { pending: 'Chờ hoàn tất', active: 'Đã cấp kết nối', revoked: 'Đã thu hồi' } as const;

function Restrictions({ context, disabled, onSave }: { context: HermesConnectionContext; disabled: boolean;
  onSave: (value: HermesConnectionRestrictions) => void }) {
  const [selected, setSelected] = useState<HermesConnectionRestrictions>(() => ({ read: [...context.restrictions.read], action: [...context.restrictions.action] }));
  const changed = (['read', 'action'] as const).some(kind => selected[kind].length !== context.restrictions[kind].length);
  return <section aria-label="Quyền kết nối" className="space-y-4 rounded-xl border bg-card p-4">
    <h2 className="font-semibold">Quyền của kết nối …{context.id.slice(-8)}</h2>
    <p className="text-sm text-muted-foreground">Bạn có thể tắt bớt quyền đang cấp. Quyền hiệu lực còn phụ thuộc quyền CRM và giới hạn của công ty.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      {(['read', 'action'] as const).map(kind => <fieldset disabled={disabled} key={kind} className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 font-medium">{kind === 'read' ? 'Đọc dữ liệu' : 'Thao tác dữ liệu'}</legend>
        {context.restrictions[kind].length === 0 && <p className="text-sm text-muted-foreground">Chưa cấp quyền.</p>}
        {context.restrictions[kind].map(key => <label key={key} className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={selected[kind].includes(key)} onChange={event => setSelected(previous => ({ ...previous,
            [kind]: event.target.checked ? [...previous[kind], key] : previous[kind].filter(value => value !== key) }))} />
          <span>{name(key)} <span className="block text-xs text-muted-foreground">{context.effective[kind].includes(key) ? 'Đang có hiệu lực' : 'Hiện chưa có hiệu lực'}</span></span>
        </label>)}
      </fieldset>)}
    </div>
    <p className="text-sm text-muted-foreground">{context.scopeIds.length ? `${context.scopeIds.length} phạm vi đã cấp được giữ nguyên.` : 'Chưa cấp phạm vi dữ liệu phòng.'} Màn hình này chưa thay đổi phạm vi.</p>
    <Button disabled={disabled || !changed} onClick={() => onSave(selected)}>Lưu giới hạn</Button>
  </section>;
}

function Workspace({ userId, organizationId, email, currentScope }: { userId: string; organizationId: string;
  email: string; currentScope: () => HermesCallerScope }) {
  const model = useHermesConnections(userId, organizationId, currentScope);
  const password = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [botGeneration, setBotGeneration] = useState(0);
  const botConfigurationChanged = useCallback(() => setBotGeneration(value => value + 1), []);
  const lifetime = useRef({ alive: true, generation: 0 });
  const handoffId = useRef<string | null>(null);
  handoffId.current = model.handoff?.connection.id ?? null;
  useLayoutEffect(() => {
    const value = lifetime.current; value.alive = true;
    return () => { value.alive = false; value.generation++; handoffId.current = null; if (password.current) password.current.value = ''; };
  }, []);
  const disabled = Boolean(model.busy) || model.needsReload || model.connections === null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !email || !password.current?.value) return;
    const value = password.current.value;
    password.current.value = ''; setCopied(null);
    void model.connect({ email, password: value, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] });
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
      <Button variant="outline" disabled={Boolean(model.busy)} onClick={() => { setCopied(null); void model.reload(); }}><RefreshCw className="h-4 w-4" />Tải lại danh sách</Button>
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
    {model.context && <Restrictions key={`${model.context.id}:${model.context.epoch}`} context={model.context} disabled={disabled}
      onSave={value => { if (model.context) void model.restrict(model.context, value); }} />}
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
    <HermesZaloBotSettings userId={userId} organizationId={organizationId} currentScope={currentScope} onConfigurationChanged={botConfigurationChanged} />
    {model.connections && <HermesZaloBindings key={botGeneration} userId={userId} organizationId={organizationId} currentScope={currentScope}
      connections={model.connections} disabled={disabled} />}
    <form aria-label="Tạo kết nối Hermes" onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">Kết nối Hermes của tôi</h2>
      <p className="text-sm text-muted-foreground">Kết nối mới hiện chỉ cho xem thông tin phiên và quyền của bạn. Chưa cấp đọc phòng hay thao tác CRM; công ty phải cho phép kết nối này.</p>
      <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="hermes-email">Tài khoản CRM</Label>
        <Input id="hermes-email" value={email} readOnly autoComplete="username" /></div>
        <div className="space-y-1"><Label htmlFor="hermes-password">Xác nhận mật khẩu CRM</Label>
          <Input ref={password} id="hermes-password" type="password" required maxLength={4096} autoComplete="off" disabled={disabled || !email} /></div></div>
      {!email && <p className="text-sm text-muted-foreground">Phiên hiện tại chưa có email đăng nhập để xác minh kết nối.</p>}
      <p className="text-xs text-muted-foreground">Mật khẩu chỉ dùng cho yêu cầu xác minh này và được xóa khỏi ô nhập ngay khi gửi.</p>
      <Button type="submit" disabled={disabled || !email}><Bot className="h-4 w-4" />Tạo kết nối</Button>
    </form>
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
