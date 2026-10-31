import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { can, useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { HermesPermissionFields } from '@/hermes/HermesPermissionFields';
import { HermesOrgPolicySettings } from '@/hermes/HermesOrgPolicySettings';
import { useHermesConnections } from '@/hermes/useHermesConnections';
import { HermesWorkAssistant } from '@/hermes/HermesWorkAssistant';
import { HermesZaloBindings, type HermesZaloSummary } from '@/hermes/HermesZaloBindings';
import { HermesZaloBotSettings } from '@/hermes/HermesZaloBotSettings';
import { HermesDeliveryReconcile } from '@/hermes/HermesDeliveryReconcile';
import { HermesSectionDivider, HermesSetupProgress, HermesStep, hermesConnectionNames, shortConnectionId,
  type HermesStepState } from '@/hermes/HermesSetupGuide';
import type { HermesCallerScope, HermesConnectionContext, HermesConnectionMetadata, HermesConnectionRestrictions, HermesConnectionStatus,
  HermesConnectorStatus, HermesGrantOptions, HermesSettingsInput } from '@/hermes/connectionClient';

const states = { pending: 'Chờ hoàn tất', active: 'Đã kết nối', revoked: 'Đã ngắt' } as const;

const errorLabels: Record<string, string> = {
  unauthorized: 'kết nối hết hạn hoặc đã bị thu hồi', forbidden: 'không đủ quyền CRM', context_changed: 'quyền hoặc kết nối vừa thay đổi',
  rate_limited: 'gọi quá nhiều lần trong một phút', busy: 'connector đang bận', timeout: 'quá thời gian xử lý',
  backend_unavailable: 'dịch vụ CRM tạm không phản hồi', tool_not_available: 'công cụ chưa được cấp quyền', invalid_request: 'yêu cầu không hợp lệ',
};
const errorLabel = (code: string) => Object.prototype.hasOwnProperty.call(errorLabels, code) ? errorLabels[code]
  : code.endsWith('_outcome_unknown') ? 'chưa xác định kết quả thao tác' : code;
const when = (value: number) => new Date(value).toLocaleString('vi-VN');

function connectorSummary(status: HermesConnectorStatus | null, failed: boolean) {
  if (status) return `Dịch vụ kết nối CRM phiên bản ${status.connector.version}, chạy từ ${when(status.connector.startedAt)}. Giờ “dùng lần cuối” chỉ tính từ lần chạy này.`;
  return failed ? 'Chưa đọc được trạng thái dịch vụ kết nối CRM; thông tin trên trang là hồ sơ đã lưu.' : 'Thông tin trên trang là hồ sơ đã lưu.';
}

/** Connector-memory observations only; absence means "not seen since start", never proof of health. */
function ConnectionActivity({ connection, status }: { connection: HermesConnectionMetadata; status: HermesConnectionStatus | undefined }) {
  const lastSuccessAt = status?.lastSuccessAt ?? null, lastToolCallAt = status?.lastToolCallAt ?? null;
  return <>
    {lastSuccessAt !== null
      ? <p className="text-sm text-muted-foreground">Hermes dùng CRM lần cuối lúc {when(lastSuccessAt)}{lastToolCallAt !== null && ` · dùng công cụ CRM lần cuối lúc ${when(lastToolCallAt)}`}</p>
      : connection.state === 'active' && <p className="text-sm text-muted-foreground">Chưa thấy Hermes dùng CRM kể từ lần chạy gần nhất của dịch vụ kết nối.</p>}
    {status && status.lastErrorCode !== null && status.lastErrorAt !== null &&
      <p className="text-sm text-muted-foreground">Lỗi gần nhất lúc {when(status.lastErrorAt)}: {errorLabel(status.lastErrorCode)}</p>}
  </>;
}

/** Câu tóm tắt quyền bằng lời thường; danh sách chi tiết nằm sau nút "Chỉnh quyền". */
function permissionSummary(connection: HermesConnectionMetadata) {
  if (connection.permissionMode !== 'inherit_crm') {
    return `Danh sách quyền cũ: ${connection.restrictions.read.length} quyền xem · ${connection.restrictions.action.length} quyền thao tác`;
  }
  const off = (connection.exclusions?.read.length ?? 0) + (connection.exclusions?.action.length ?? 0);
  const scope = connection.scopeMode === 'restricted' ? ` · chỉ ${connection.scopeIds.length} toà/khu đã chọn` : '';
  return `Theo quyền CRM của bạn${off > 0 ? `, trừ ${off} mục đã tắt` : ''}${scope}`;
}

type Limits = Pick<HermesSettingsInput, 'exclusions' | 'scopeMode' | 'scopeIds'>;
const freshLimits = (): Limits => ({ exclusions: { read: [], action: [] }, scopeMode: 'unrestricted', scopeIds: [] });
function InheritedLimits({ value, options, disabled, effective, onChange }: { value: Limits; options: HermesGrantOptions;
  disabled: boolean; effective?: HermesConnectionRestrictions; onChange: (value: Limits) => void }) {
  const selected = { read: options.read.filter(key => !value.exclusions.read.includes(key)),
    action: options.action.filter(key => !value.exclusions.action.includes(key)) };
  const hidden = (['read', 'action'] as const).reduce((count, kind) => count + value.exclusions[kind].filter(key => !options[kind].includes(key)).length, 0);
  return <div className="space-y-3">
    <p className="text-sm">Mặc định Hermes được làm những việc bạn được làm trong CRM. Bỏ chọn mục nào thì Hermes không được làm mục đó. Quyền CRM bạn được cấp thêm sau này cũng tự áp dụng, trừ các mục đã bỏ.</p>
    {hidden > 0 && <p className="text-sm text-muted-foreground">Đang giữ {hidden} quyền đã tắt chưa có trong danh sách CRM hiện tại.</p>}
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.scopeMode === 'restricted'} disabled={disabled}
      onChange={event => onChange({ ...value, scopeMode: event.target.checked ? 'restricted' : 'unrestricted', scopeIds: [] })} />Chỉ cho Hermes xem một số toà/khu</label>
    <p className="text-sm text-muted-foreground">{value.scopeMode === 'unrestricted' ? 'Hermes xem được mọi toà bạn đang được xem.'
      : value.scopeIds.length === 0 ? 'Chưa chọn toà/khu nào: Hermes sẽ không xem được dữ liệu theo toà.' : 'Hermes chỉ xem các toà/khu đã chọn, trong quyền CRM hiện tại của bạn.'}</p>
    <div className={value.scopeMode === 'unrestricted' ? '[&>div>fieldset:last-child]:hidden' : undefined}>
      <HermesPermissionFields value={selected} scopeIds={value.scopeIds} readChoices={options.read} actionChoices={options.action}
        scopes={options.scopes} effective={effective} disabled={disabled} onChange={(next, scopeIds) => onChange({ ...value, scopeIds,
          exclusions: { read: [...value.exclusions.read.filter(key => !options.read.includes(key)), ...options.read.filter(key => !next.read.includes(key))],
            action: [...value.exclusions.action.filter(key => !options.action.includes(key)), ...options.action.filter(key => !next.action.includes(key))] } })} />
    </div>
  </div>;
}
function ConnectionPermissions({ context, name, options, disabled, onSave, onSettings }: { context: HermesConnectionContext; name: string;
  options: HermesGrantOptions | null; disabled: boolean; onSave: (value: HermesConnectionRestrictions, scopeIds: string[]) => void;
  onSettings: (value: Limits) => void }) {
  const inherited = context.permissionMode === 'inherit_crm';
  const [transition, setTransition] = useState(false);
  const [value, setValue] = useState<Limits>(() => inherited ? { exclusions: context.exclusions ?? { read: [], action: [] },
    scopeMode: context.scopeMode ?? 'restricted', scopeIds: context.scopeMode === 'unrestricted' ? [] : [...context.scopeIds] } : freshLimits());
  if (!inherited && !transition) return <div className="space-y-3"><Restrictions context={context} name={name} options={options} disabled={disabled} onSave={onSave} />
    <Button variant="outline" disabled={disabled} onClick={() => setTransition(true)}>Chuyển sang theo quyền CRM</Button></div>;
  const changed = !inherited || JSON.stringify(value) !== JSON.stringify({ exclusions: context.exclusions,
    scopeMode: context.scopeMode, scopeIds: context.scopeMode === 'unrestricted' ? [] : context.scopeIds });
  return <section aria-label="Giới hạn cho Hermes" className="space-y-3 rounded-lg border p-3">
    <h3 className="font-medium">Quyền của {name}</h3>
    {!inherited && <p className="text-sm">Sau khi chuyển, Hermes theo quyền CRM hiện tại và quyền bạn được cấp thêm sau này, chỉ trừ những mục bạn tắt ở đây. Các quyền không có trong danh sách cũ không tự bị tắt.</p>}
    {options && <InheritedLimits value={value} options={options} effective={context.effective} disabled={disabled} onChange={setValue} />}
    <Button disabled={disabled || !options || !changed} onClick={() => onSettings(value)}>{inherited ? 'Lưu giới hạn cho Hermes' : 'Áp dụng quyền web và giới hạn đã chọn'}</Button>
  </section>;
}

function Restrictions({ context, name, options, disabled, onSave }: { context: HermesConnectionContext; name: string; options: HermesGrantOptions | null;
  disabled: boolean; onSave: (value: HermesConnectionRestrictions, scopeIds: string[]) => void }) {
  const [selected, setSelected] = useState<HermesConnectionRestrictions>(() => ({ read: [...context.restrictions.read], action: [...context.restrictions.action] }));
  const [scopeIds, setScopeIds] = useState([...context.scopeIds]);
  const changed = (['read', 'action'] as const).some(kind => selected[kind].length !== context.restrictions[kind].length) || scopeIds.length !== context.scopeIds.length;
  return <section aria-label="Quyền kết nối" className="space-y-4 rounded-lg border p-3">
    <h3 className="font-medium">Quyền của {name}</h3>
    <p className="text-sm text-muted-foreground">Kết nối này tạo theo cách cũ: Hermes chỉ có đúng danh sách quyền đã cấp lúc tạo. Bạn có thể tắt bớt ở đây, hoặc chuyển sang theo quyền CRM.</p>
    <HermesPermissionFields value={selected} scopeIds={scopeIds} readChoices={context.restrictions.read} actionChoices={context.restrictions.action}
      scopes={(options?.scopes ?? []).filter(scope => context.scopeIds.includes(scope.scopeId))} effective={context.effective} disabled={disabled}
      onChange={(value, scopes) => { setSelected(value); setScopeIds(scopes); }} />
    <Button disabled={disabled || !changed} onClick={() => onSave(selected, scopeIds)}>Lưu giới hạn</Button>
  </section>;
}

function ConnectionRow({ connection, name, status, disabled, onPermissions, onRevoke }: { connection: HermesConnectionMetadata; name: string;
  status: HermesConnectorStatus | null; disabled: boolean; onPermissions?: () => void; onRevoke?: () => void }) {
  return <article aria-label={`${name} · mã ${shortConnectionId(connection.id)}`} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3">
    <div className="min-w-0 space-y-0.5">
      <p className="font-medium">{name} <span className="ml-1 rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">{states[connection.state]}</span></p>
      <p className="text-sm text-muted-foreground">{permissionSummary(connection)}</p>
      {status && <ConnectionActivity connection={connection} status={status.connections.find(item => item.id === connection.id)} />}
    </div>
    {(onPermissions || onRevoke) && <div className="flex flex-wrap gap-2">
      {onPermissions && <Button variant="outline" size="sm" disabled={disabled || connection.state !== 'active'} onClick={onPermissions}>Chỉnh quyền</Button>}
      {onRevoke && <AlertDialog>
        <AlertDialogTrigger asChild><Button variant="outline" size="sm" className="text-destructive" disabled={disabled || connection.state === 'revoked'}>Ngắt kết nối</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ngắt {name}?</AlertDialogTitle>
            <AlertDialogDescription>Hermes sẽ không dùng được tài khoản CRM của bạn qua kết nối này nữa, kể cả khi bạn nhắn trên Zalo. Không hoàn tác được: muốn dùng lại phải tạo kết nối mới ở bước 2.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Giữ kết nối</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={onRevoke}>Ngắt kết nối</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>}
  </article>;
}

const provisioningText: Record<NonNullable<HermesZaloSummary['provisioningState']>, string> = {
  pending: 'Đang đồng bộ với trợ lý…',
  pending_credential: 'Trợ lý chưa nhận được kết nối CRM. Kiểm tra bước 2, rồi bấm “Dùng kết nối này cho trợ lý” ở bước 3 nếu có.',
  restart_pending: 'Đang chờ quản trị viên kích hoạt trợ lý.',
  unavailable: 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ tự thử lại.',
  synchronized: 'Trợ lý đã sẵn sàng.',
};

function Workspace({ userId, organizationId, email, currentScope }: { userId: string; organizationId: string;
  email: string; currentScope: () => HermesCallerScope }) {
  const model = useHermesConnections(userId, organizationId, currentScope);
  const permissions = useMyPermissions();
  // Chỉ quyết định hiện hay ẩn; máy chủ vẫn tự kiểm quyền. Đọc quyền lỗi thì vẫn hiện để không che công cụ quản trị.
  const admin = permissions.isError || can(permissions.data, 'users', 'edit');
  const [createOpen, setCreateOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  useEffect(() => {
    if (createOpen && model.optionsState === 'idle' && model.busy !== 'list' && !model.needsReload) void model.ensureOptions();
  }, [createOpen, model.optionsState, model.busy, model.needsReload, model.ensureOptions]);
  const password = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [botGeneration, setBotGeneration] = useState(0);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [limits, setLimits] = useState<Limits>(freshLimits);
  const [zalo, setZalo] = useState<HermesZaloSummary>({ bots: null, stage: 'none', provisioningState: null });
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

  // Tiến độ chỉ để hướng dẫn: suy ra từ dữ liệu đã đọc, không mở thêm lượt gọi máy chủ nào.
  const connections = model.connections ?? [];
  const names = hermesConnectionNames(connections);
  const live = connections.filter(connection => connection.state !== 'revoked');
  const revoked = connections.filter(connection => connection.state === 'revoked');
  const active = connections.filter(connection => connection.state === 'active');
  const companyOff = model.optionsState === 'ready' && model.options?.enabled === false;
  const noBot = zalo.bots === 0;
  // "Đã bật" chỉ khi vừa đọc được chính sách bật; có kết nối cũ không chứng minh công ty còn bật Hermes.
  const companyReady = model.options?.enabled === true && (zalo.bots ?? 0) > 0;
  const linked = zalo.stage === 'linked';
  const done = [companyReady, active.length > 0, zalo.stage !== 'none', zalo.stage === 'observed' || linked, linked,
    linked && zalo.provisioningState === 'synchronized', false];
  // Thiếu bot hay công ty tắt thì người dùng không tự đi tiếp được: đưa về bước 1 (việc của quản trị).
  const current = companyOff || noBot ? 0 : [1, 2, 3, 4, 5].find(index => !done[index]) ?? null;
  const stateOf = (index: number, isDone: boolean): HermesStepState => isDone ? 'done' : index === current ? 'current' : 'todo';
  const zaloState: HermesStepState = linked ? 'done' : current !== null && current >= 2 && current <= 4 ? 'current' : 'todo';
  const companyState: HermesStepState = companyOff || noBot ? 'blocked' : stateOf(0, companyReady);
  const companySummary = companyOff ? `Công ty đang tắt Hermes. ${admin ? 'Bật lại ngay bên dưới.' : 'Nhờ quản trị công ty bật lại.'}`
    : noBot ? `Công ty chưa có bot Zalo. ${admin ? 'Chọn một nick Zalo phụ làm bot ngay bên dưới.' : 'Nhờ quản trị chọn một nick Zalo phụ làm bot.'}`
      : companyReady ? `Đã bật, có ${zalo.bots} bot Zalo sẵn sàng.`
        : zalo.bots ? `Có ${zalo.bots} bot Zalo sẵn sàng. Bật Hermes là việc của quản trị, làm một lần cho cả công ty.`
          : 'Việc của quản trị, làm một lần cho cả công ty.';
  // Trạng thái kích hoạt chỉ đọc khi tải danh sách liên kết, nên nói rõ cách xem trạng thái mới.
  const refreshHint = 'Bấm “Tải lại liên kết” ở bước 3 để xem trạng thái mới nhất.';
  const activationSummary = !linked ? 'Tự chạy sau khi bạn liên kết Zalo.'
    : !zalo.provisioningState ? `Chưa đọc được trạng thái kích hoạt. ${refreshHint}`
      : zalo.provisioningState === 'synchronized' ? provisioningText.synchronized : `${provisioningText[zalo.provisioningState]} ${refreshHint}`;

  return <div className="max-w-3xl space-y-4">
    <HermesSetupProgress key={model.connections === null ? 'loading' : 'ready'} done={done} current={current}
      initiallyOpen={model.connections !== null && active.length === 0}
      action={<Button variant="outline" size="sm" disabled={policyBusy || Boolean(model.busy)} onClick={() => { setCopied(null); void model.reload(); }}><RefreshCw className="h-4 w-4" />Tải lại danh sách</Button>} />
    {model.message && <p role="status" className="rounded-lg border bg-muted/50 p-3 text-sm">{model.message}</p>}
    {model.needsReload && <p className="text-sm font-medium">Các thao tác đang tạm dừng đến khi bạn tải lại danh sách thành công.</p>}
    {model.busy && <p role="status" className="text-sm text-muted-foreground">{model.busy === 'list' || model.busy === 'context' ? 'Đang đọc thông tin kết nối…' : 'Đang chờ máy chủ xác nhận…'}</p>}

    <HermesStep label="1" state={companyState} title="Công ty bật Hermes và chọn bot Zalo" who="Quản trị" summary={companySummary}>
      {admin && <>
        <HermesOrgPolicySettings userId={userId} organizationId={organizationId} currentScope={currentScope}
          onPolicyChanging={policyChanging} onPolicyChanged={policyChanged} />
        <HermesZaloBotSettings userId={userId} organizationId={organizationId} currentScope={currentScope} onConfigurationChanged={botConfigurationChanged} />
      </>}
    </HermesStep>

    <HermesStep label="2" state={stateOf(1, active.length > 0)} title="Kết nối Hermes với tài khoản CRM của bạn" who="Bạn · trang này"
      summary={model.connections === null ? null : live.length === 0 ? 'Chưa có kết nối Hermes trong công ty này.'
        : active.length > 0 ? 'Hermes đã được dùng tài khoản CRM của bạn.' : 'Kết nối chưa hoàn tất.'}>
      {live.length > 0 && <div aria-label="Kết nối của tôi" className="space-y-2">
        {live.map(connection => <ConnectionRow key={connection.id} connection={connection} name={names(connection.id)} status={model.connectorStatus}
          disabled={disabled} onPermissions={() => void model.contextFor(connection)} onRevoke={() => { setCopied(null); void model.revoke(connection); }} />)}
      </div>}
      {model.context && !createOpen && model.optionsState === 'loading' && <p role="status" className="text-sm">Đang tải danh sách quyền và phạm vi được phép cấp…</p>}
      {model.context && !createOpen && model.optionsState === 'error' && <div className="space-y-2"><p role="alert" className="text-sm">Chưa đọc được danh sách quyền và phạm vi được phép cấp.</p>
        <Button variant="outline" size="sm" onClick={() => void model.ensureOptions()}>Thử tải lại quyền</Button></div>}
      {model.context && <ConnectionPermissions key={`${model.context.id}:${model.context.epoch}`} context={model.context} name={names(model.context.id)}
        options={model.options} disabled={disabled}
        onSave={(value, scopes) => { if (model.context) void model.restrict(model.context, value, scopes); }}
        onSettings={value => { if (model.context) void model.settings({ connectionId: model.context.id, expectedEpoch: model.context.epoch, permissionMode: 'inherit_crm', ...value }); }} />}
      {model.handoff && <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
        <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 flex-none text-primary" />Đã tạo kết nối. Làm tiếp bước 3 bên dưới để nhắn Hermes qua Zalo.</p>
        <details aria-label="Mã kết nối một lần" className="space-y-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Tự chạy Hermes riêng (nâng cao)? Mã kết nối chỉ hiện lần này</summary>
          <div className="mt-2 space-y-2">
            <p>Chỉ dán mã vào Hermes do chính bạn quản lý. Mã không lưu trong trình duyệt và không xem lại được ở đây.</p>
            <Label htmlFor="hermes-handoff">Mã kết nối</Label>
            <Input id="hermes-handoff" value={model.handoff.token} readOnly autoComplete="off" className="font-mono" />
            <p className="text-xs text-muted-foreground">Hạn hiện tại: {new Date(model.handoff.tokenExpiresAt).toLocaleString('vi-VN')}. Mã sẽ ẩn khi hết hạn, đổi tài khoản/công ty hoặc rời trang.</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void copyHandoff()}><Copy className="h-4 w-4" />Sao chép mã</Button>
              <Button size="sm" variant="outline" onClick={() => { model.clearHandoff(); setCopied(null); }}>Đã lưu, ẩn mã</Button></div>
            {copied && <p role="status" className="text-sm">{copied}</p>}
          </div>
        </details>
      </div>}
      {model.connections && <>
        <Button variant={active.length === 0 && !createOpen ? 'default' : 'outline'} size={active.length === 0 ? 'default' : 'sm'} aria-expanded={createOpen}
          onClick={() => setCreateOpen(value => !value)}>{createOpen ? 'Đóng' : active.length === 0 ? 'Bắt đầu kết nối' : 'Tạo kết nối mới'}</Button>
        {active.length > 0 && !createOpen && <p className="text-xs text-muted-foreground">Chỉ cần khi kết nối cũ hết hạn hoặc đã ngắt.</p>}
      </>}
      {createOpen && <section aria-label="Cấp quyền Hermes mới" className="space-y-3 rounded-lg border p-3">
        <p className="text-sm">Hermes sẽ làm được những việc bạn được làm trong CRM, không hơn. Bạn có thể tắt bớt trước khi tạo.</p>
        {model.optionsState === 'ready' && model.options ? model.options.enabled ? <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" aria-expanded={limitsOpen} onClick={() => setLimitsOpen(value => !value)}>{limitsOpen ? 'Ẩn tuỳ chỉnh quyền' : 'Tuỳ chỉnh quyền (không bắt buộc)'}</Button>
            {!limitsOpen && (limits.exclusions.read.length + limits.exclusions.action.length > 0 || limits.scopeMode === 'restricted') &&
              <span className="text-xs text-muted-foreground">Đang tắt {limits.exclusions.read.length + limits.exclusions.action.length} mục{limits.scopeMode === 'restricted' ? ` · chỉ ${limits.scopeIds.length} toà/khu` : ''}</span>}
          </div>
          {limitsOpen && <InheritedLimits value={limits} options={model.options} disabled={disabled} onChange={setLimits} />}
        </> : <p role="status" className="text-sm">Công ty đang tắt Hermes nên chưa tạo được kết nối. Nhờ quản trị bật lại ở bước 1.</p>
          : model.optionsState === 'error' ? <div className="space-y-2"><p role="alert" className="text-sm">Chưa đọc được danh sách quyền và phạm vi được phép cấp.</p>
            <Button variant="outline" size="sm" onClick={() => void model.ensureOptions()}>Thử tải lại quyền</Button></div>
          : <p role="status" className="text-sm">Đang tải danh sách quyền và phạm vi được phép cấp…</p>}
        <form aria-label="Tạo kết nối Hermes" onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="hermes-email">Tài khoản CRM</Label>
            <Input id="hermes-email" value={email} readOnly autoComplete="username" /></div>
            <div className="space-y-1"><Label htmlFor="hermes-password">Xác nhận mật khẩu CRM</Label>
              <Input ref={password} id="hermes-password" type="password" required maxLength={4096} autoComplete="off" disabled={disabled || !email} /></div></div>
          {!email && <p className="text-sm text-muted-foreground">Phiên hiện tại chưa có email đăng nhập để xác minh kết nối.</p>}
          <p className="text-xs text-muted-foreground">Mật khẩu chỉ dùng để xác minh lần này và được xoá khỏi ô nhập ngay khi gửi.</p>
          <Button type="submit" disabled={disabled || !email || !grantReady}><Bot className="h-4 w-4" />Tạo kết nối</Button>
        </form>
      </section>}
      {revoked.length > 0 && <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Kết nối đã ngắt ({revoked.length})</summary>
        <div className="mt-2 space-y-2">{revoked.map(connection => <ConnectionRow key={connection.id} connection={connection}
          name={`${names(connection.id)} · mã …${shortConnectionId(connection.id)}`} status={null} disabled />)}</div>
      </details>}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Chi tiết kỹ thuật</summary>
        <div className="mt-2 space-y-1 text-muted-foreground">
          <p>{connectorSummary(model.connectorStatus, model.connectorStatusError)}</p>
          {live.map(connection => <p key={connection.id}>{names(connection.id)}: mã …{shortConnectionId(connection.id)}</p>)}
        </div>
      </details>
    </HermesStep>

    <HermesStep label="3–5" state={zaloState} title="Liên kết Zalo để nhắn Hermes" who="Bạn · Zalo"
      summary={linked ? 'Đã liên kết nick Zalo của bạn.' : 'Làm lần lượt 3 việc nhỏ dưới đây.'}>
      {model.connections && <HermesZaloBindings key={botGeneration} userId={userId} organizationId={organizationId} currentScope={currentScope}
        connections={model.connections} disabled={disabled} onSummary={setZalo} />}
    </HermesStep>

    <HermesStep label="6" state={stateOf(5, done[5])} title="Trợ lý được kích hoạt" who="Tự động" summary={activationSummary} />

    <HermesStep label="7" state={current === null ? 'current' : 'todo'} title="Nhắn bot trên Zalo để dùng" who="Bạn · Zalo"
      summary="Nhắn riêng cho bot như nhắn cho đồng nghiệp. Hermes chỉ làm được việc trong quyền của bạn.">
      {current === null && <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>“Toà Nhà A còn phòng nào trống?”</li>
        <li>“Tạo việc kiểm tra điện phòng 101, giao cho anh Nam, hạn 5 giờ chiều.”</li>
        <li>“Việc nào của tôi sắp quá hạn?”</li>
      </ul>}
    </HermesStep>

    <HermesSectionDivider>Sau khi đã dùng</HermesSectionDivider>
    <HermesWorkAssistant userId={userId} organizationId={organizationId} currentScope={currentScope} />

    <HermesSectionDivider>Khi có sự cố</HermesSectionDivider>
    <HermesDeliveryReconcile userId={userId} organizationId={organizationId} currentScope={currentScope} />
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
  return <MainLayout title="Trợ lý Hermes" subtitle={`Cài và dùng Hermes${organization.organization?.name ? ` tại ${organization.organization.name}` : ''}`} icon={Bot}>
    {auth.isLoading || organization.isLoading ? <p role="status">Đang kiểm tra tài khoản và công ty…</p>
      : !ready ? <p role="alert">Chưa kiểm tra được tài khoản hoặc công ty. Hãy tải lại trang.</p>
      : !userId ? <p role="alert">Hãy đăng nhập CRM để quản lý kết nối của bạn.</p>
      : !organizationId ? <p role="status">Chọn công ty ở bộ chọn công ty trước khi quản lý Hermes.</p>
      : <Workspace key={`${userId}:${organizationId}:${scope.current.generation}`} userId={userId} organizationId={organizationId}
        email={auth.data?.email ?? ''} currentScope={currentScope} />}
  </MainLayout>;
}
