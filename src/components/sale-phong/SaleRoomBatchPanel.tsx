import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePatchSaleRoom } from '@/hooks/useSaleRoomInventory';
import { useSaleRoomPolicy } from '@/hooks/useSaleRoomPolicy';
import { saleRoomPatchSchema, type SaleRoomInventoryRow, type SaleRoomPatch } from '@/lib/saleRoomOperations';
import { salePolicyTimeLabel, salePolicyTimeToIso, saleRoomPolicyInputSchema } from '@/lib/saleRoomPolicyTypes';
import { runSaleRoomBatch, validateSaleBatch, type SaleBatchCommand, type SaleBatchDraft } from '@/lib/saleRoomWorkflow';

type Mode = 'patch' | 'policy' | 'cancel';
type Field = 'rent_price' | 'room_type' | 'amenities' | 'sale_note' | 'description';
const FIELDS: Array<{ key: Field; label: string }> = [
  { key: 'rent_price', label: 'Giá niêm yết (đ/tháng)' }, { key: 'room_type', label: 'Loại phòng' },
  { key: 'amenities', label: 'Nội thất (mỗi dòng một mục)' }, { key: 'sale_note', label: 'Ghi chú / chính sách thường' },
  { key: 'description', label: 'Mô tả gửi khách' },
];
const STATUS = { queued: 'Chưa gửi', saving: 'Cần đối chiếu', applied: 'Đã lưu', conflict: 'Cần đối chiếu dữ liệu mới', rejected: 'Bị từ chối', unknown: 'Chưa rõ kết quả' };
const label = (row: SaleRoomInventoryRow) => `${row.buildingName} · ${row.name}`;
const livePolicies = (row: SaleRoomInventoryRow) => (row.policies ?? (row.policy ? [row.policy] : []))
  .filter(policy => ['ACTIVE', 'SCHEDULED'].includes(policy.status));
const formSchema = z.object({
  mode: z.enum(['patch', 'policy', 'cancel']), selected: z.array(z.string().uuid()).max(50),
  fields: z.object({ rent_price: z.string().max(30).optional(), room_type: z.string().max(5000).optional(),
    amenities: z.string().max(5000).optional(), sale_note: z.string().max(5000).optional(), description: z.string().max(5000).optional() }).strict(),
  policy: z.object({ title: z.string(), content: z.string(), start: z.string(), end: z.string() }).strict(), reason: z.string(),
  cancelTargets: z.record(z.string().uuid()).optional(),
}).strict();
function restoreForm(key: string) {
  try { const raw = sessionStorage.getItem(key); return { value: raw ? formSchema.parse(JSON.parse(raw)) : null, warning: '' }; }
  catch { return { value: null, warning: 'Không đọc được bản nháp nội dung. Kiểm tra lại các trường trước khi lập lô mới.' }; }
}
function restoreBatch(key: string, organizationId: string): { draft: SaleBatchDraft | null; warning: string } {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { draft: null, warning: '' };
    const parsed = validateSaleBatch(organizationId, JSON.parse(raw));
    return { draft: { ...parsed, results: parsed.results.map(result => result.status === 'saving'
      ? { ...result, status: 'unknown', message: 'Lần trước bị gián đoạn. Đối chiếu cùng mã yêu cầu.' } : result) }, warning: '' };
  } catch {
    // Corrupt local draft is not a successful write and must be visible to the operator.
    return { draft: null, warning: 'Không đọc được lô đã lưu trên trình duyệt. Kiểm tra lại dữ liệu trước khi lập lô mới.' };
  }
}

export default function SaleRoomBatchPanel({ rows, initialRoomIds, organizationId, actorId, blocked, onBusyChange, onClose, onSaved }: {
  rows: SaleRoomInventoryRow[]; initialRoomIds: string[]; organizationId: string; actorId: string; blocked: boolean;
  onBusyChange: (busy: boolean) => void; onClose: () => void; onSaved: () => void;
}) {
  const storageKey = `sale-room-batch:v1:${actorId}:${organizationId}`;
  const [restoredForm] = useState(() => restoreForm(`${storageKey}:form`));
  const form = restoredForm.value;
  const [restored] = useState(() => restoreBatch(storageKey, organizationId));
  const [draft, setDraft] = useState<SaleBatchDraft | null>(restored.draft);
  const [error, setError] = useState(restored.warning || restoredForm.warning);
  const [mode, setMode] = useState<Mode>(form?.mode ?? 'patch');
  const [selected, setSelected] = useState<Set<string>>(new Set(form?.selected ?? []));
  const [fields, setFields] = useState<Partial<Record<Field, string>>>(form?.fields ?? {});
  const [policy, setPolicy] = useState({ title: form?.policy.title ?? '', content: form?.policy.content ?? '', start: form?.policy.start ?? '', end: form?.policy.end ?? '' });
  const [reason, setReason] = useState(form?.reason ?? '');
  const [cancelTargets, setCancelTargets] = useState<Record<string, string>>(form?.cancelTargets ?? {});
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true); const dispatching = useRef(false);
  // A batch refreshes the shared views once after dispatch, not once per room.
  const patch = usePatchSaleRoom({ refreshAfterWrite: false }); const policies = useSaleRoomPolicy({ refreshAfterWrite: false });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    try { sessionStorage.setItem(`${storageKey}:form`, JSON.stringify({ mode, selected: [...selected], fields, policy, reason, cancelTargets })); }
    catch { setError('Chưa lưu được bản nháp trên trình duyệt. Giữ màn hình này để tránh mất nội dung.'); }
  }, [storageKey, mode, selected, fields, policy, reason, cancelTargets]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!busy) return; event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  const offered = rows.filter(row => initialRoomIds.includes(row.room.id));
  const eligible = offered.filter(row => row.capabilities.edit);
  const locked = busy || blocked || !!draft;
  const persist = (next: SaleBatchDraft) => {
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    if (mounted.current) setDraft(next);
  };
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const prepare = () => {
    if (blocked || busy) return;
    setError('');
    try {
      if (!selected.size || selected.size > 50) throw new Error('Chọn từ 1 đến 50 phòng cho mỗi lần cập nhật.');
      const targets = [...selected].map(id => {
        const row = rows.find(item => item.room.id === id);
        if (!row || !row.capabilities.edit) throw new Error('Có phòng không còn trong phạm vi hoặc quyền cập nhật đã thay đổi.');
        return row;
      });
      let roomPatch: SaleRoomPatch | undefined;
      if (mode === 'patch') {
        const values: Record<string, unknown> = {};
        for (const [field, raw = ''] of Object.entries(fields)) {
          if (field === 'rent_price') {
            if (!/^\d+$/.test(raw.trim())) throw new Error('Nhập giá nguyên không âm bằng đồng, không dùng dấu phân cách.');
            values[field] = Number(raw);
          } else if (field === 'amenities') values[field] = raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
          else values[field] = raw.trim() || null;
        }
        const parsed = saleRoomPatchSchema.safeParse(values);
        if (!parsed.success) throw new Error('Chọn trường cần sửa và kiểm tra giá, nội dung đã nhập.');
        roomPatch = parsed.data;
      }
      const campaign = mode === 'policy' ? saleRoomPolicyInputSchema.parse({ title: policy.title, content: policy.content,
        starts_at: salePolicyTimeToIso(policy.start), ends_at: salePolicyTimeToIso(policy.end) }) : null;
      if (mode === 'cancel' && !reason.trim()) throw new Error('Nhập lý do ngừng chính sách.');
      const commands: SaleBatchCommand[] = targets.map(row => {
        const common = { roomId: row.room.id, expectedRevision: row.revision, requestId: crypto.randomUUID() };
        if (mode === 'patch' && roomPatch) return { kind: 'patch', label: label(row), input: { ...common, patch: roomPatch } };
        if (mode === 'policy' && campaign) {
          if (livePolicies(row).some(existing => Date.parse(campaign.starts_at) < Date.parse(existing.ends_at)
            && Date.parse(existing.starts_at) < Date.parse(campaign.ends_at))) throw new Error(`${label(row)} đã có chính sách trùng thời gian. Chọn thời gian khác hoặc ngừng chính sách đó trước.`);
          return { kind: 'policy', label: label(row), input: { ...common, policy: campaign } };
        }
        const target = livePolicies(row).find(policy => policy.id === (cancelTargets[row.room.id] ?? row.policy?.id));
        if (!target) throw new Error(`${label(row)} không có chính sách đang hoặc sắp áp dụng đã chọn. Chọn lại chính sách cần ngừng.`);
        return { kind: 'cancel', label: `${label(row)} · ${target.title} (${salePolicyTimeLabel(target.starts_at)} → ${salePolicyTimeLabel(target.ends_at)})`, input: { roomId: row.room.id, requestId: common.requestId,
          policyId: target.id, expectedVersion: target.version, reason: reason.trim() } };
      });
      persist(validateSaleBatch(organizationId, { commands, results: [] }));
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'ZodError' ? failure.message : 'Kiểm tra nội dung và thời gian chính sách; chưa gửi thay đổi.');
    }
  };
  const execute = async () => {
    if (!draft || blocked || dispatching.current) return;
    dispatching.current = true; setBusy(true); setError('');
    try {
      await runSaleRoomBatch(organizationId, draft, command => command.kind === 'patch' ? patch.mutateAsync(command.input)
        : command.kind === 'policy' ? policies.save.mutateAsync(command.input) : policies.cancel.mutateAsync(command.input),
      persist, () => mounted.current);
      try { await policies.refresh(); }
      catch { setError('Đã giữ kết quả từng phòng; chưa tải được dữ liệu mới. Tải lại trước lần cập nhật tiếp theo.'); }
      onSaved();
    } catch {
      setError('Chưa lưu được tiến độ trên trình duyệt. Giữ lô này để đối chiếu; các phòng chưa gửi chưa bị thay đổi.');
    } finally { dispatching.current = false; if (mounted.current) setBusy(false); }
  };
  const unresolved = draft?.results.some(result => result.status === 'saving' || result.status === 'unknown');
  const remaining = draft?.commands.filter(command => {
    const result = draft.results.find(item => item.requestId === command.input.requestId);
    return !result || ['queued', 'saving', 'unknown'].includes(result.status);
  }).length ?? 0;
  const reset = () => {
    if (busy || unresolved) return;
    try { sessionStorage.removeItem(storageKey); setDraft(null); setError(''); onSaved(); }
    catch { setError('Chưa xóa được bản nháp trên trình duyệt. Giữ nguyên để tránh gửi lại nhầm.'); }
  };
  return <section aria-label="Cập nhật hàng loạt và chính sách" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Cập nhật nhiều phòng · chính sách có thời hạn</h3>
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Đóng</Button></div>
    <p className="text-sm text-muted-foreground">Lưu trực tiếp theo quyền được cấp. Mỗi phòng có kết quả riêng; không thay đổi hợp đồng hay tiền cọc.</p>
    {blocked && <p role="alert" className="text-sm text-destructive">Chưa đọc được thông tin mới nhất. Tải lại trước khi gửi.</p>}
    {!draft && <>
      <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
        <legend className="mb-2 text-sm font-medium">1. Chọn phòng ({selected.size}/50)</legend>
        <Button type="button" variant="outline" size="sm" disabled={!eligible.length || eligible.length > 50}
          onClick={() => setSelected(new Set(eligible.map(row => row.room.id)))}>Chọn tất cả phòng được sửa trong kết quả</Button>
        {eligible.length > 50 && <p className="text-xs text-muted-foreground">Kết quả vượt 50 phòng. Lọc ít phòng hơn hoặc chọn từng phòng.</p>}
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">{offered.map(row => <label key={row.room.id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={selected.has(row.room.id)} disabled={!row.capabilities.edit || (!selected.has(row.room.id) && selected.size >= 50)}
            onChange={() => toggle(row.room.id)} aria-label={`Chọn ${label(row)}`} />
          <span>{label(row)}{!row.capabilities.edit && <span className="text-muted-foreground"> · chỉ xem</span>}
            {row.policy && <span className="block text-xs text-muted-foreground">{row.policy.title} · {row.policy.status === 'ACTIVE' ? 'Đang áp dụng' : row.policy.status === 'SCHEDULED' ? 'Sắp áp dụng' : 'Đã kết thúc'}</span>}</span>
        </label>)}</div>
      </fieldset>
      <fieldset disabled={locked} className="space-y-3 disabled:opacity-60"><legend className="mb-2 text-sm font-medium">2. Nội dung cập nhật</legend>
        <Label htmlFor="sale-batch-mode">Thao tác</Label><select id="sale-batch-mode" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={mode} onChange={event => setMode(event.target.value as Mode)}>
          <option value="patch">Thông tin phòng</option><option value="policy">Chính sách có thời hạn</option><option value="cancel">Ngừng chính sách có thời hạn</option>
        </select>
        {mode === 'patch' && FIELDS.map(field => <div key={field.key} className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fields[field.key] !== undefined} onChange={event => setFields(current => {
            const next = { ...current }; if (event.target.checked) next[field.key] = ''; else delete next[field.key]; return next;
          })} />Sửa {field.label.toLowerCase()}</label>
          {fields[field.key] !== undefined && <><Label htmlFor={`batch-${field.key}`}>{field.label}</Label>
            {field.key === 'rent_price' || field.key === 'room_type'
              ? <Input id={`batch-${field.key}`} value={fields[field.key]} inputMode={field.key === 'rent_price' ? 'numeric' : undefined} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} />
              : <Textarea id={`batch-${field.key}`} value={fields[field.key]} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} />}</>}
        </div>)}
        {mode === 'patch' && <p className="text-xs text-muted-foreground">Chỉ các trường được chọn sẽ thay đổi. Nội dung để trống sẽ xóa trường đó; giá phải có số.</p>}
        {mode === 'policy' && <>
          <Label htmlFor="batch-policy-title">Tên chương trình</Label><Input id="batch-policy-title" maxLength={120} value={policy.title} onChange={event => setPolicy(current => ({ ...current, title: event.target.value }))} />
          <Label htmlFor="batch-policy-content">Nội dung chính sách gửi khách</Label><Textarea id="batch-policy-content" maxLength={2000} value={policy.content} onChange={event => setPolicy(current => ({ ...current, content: event.target.value }))} />
          <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="batch-policy-start">Bắt đầu · giờ Việt Nam</Label><Input id="batch-policy-start" type="datetime-local" value={policy.start} onChange={event => setPolicy(current => ({ ...current, start: event.target.value }))} /></div>
            <div><Label htmlFor="batch-policy-end">Kết thúc · giờ Việt Nam</Label><Input id="batch-policy-end" type="datetime-local" value={policy.end} onChange={event => setPolicy(current => ({ ...current, end: event.target.value }))} /></div></div>
          <p className="text-xs text-muted-foreground">Chính sách tự hiện từ giờ bắt đầu và tự hết hiệu lực đúng giờ kết thúc. Giá hợp đồng không tự thay đổi.</p>
        </>}
        {mode === 'cancel' && <>
          {rows.filter(row => selected.has(row.room.id)).map(row => <div key={row.room.id}>
            <Label htmlFor={`cancel-policy-${row.room.id}`}>Chính sách cần ngừng · {label(row)}</Label>
            <select id={`cancel-policy-${row.room.id}`} className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={cancelTargets[row.room.id] ?? row.policy?.id ?? ''}
              onChange={event => setCancelTargets(current => ({ ...current, [row.room.id]: event.target.value }))}>
              {!livePolicies(row).length && <option value="">Không có chính sách còn hạn</option>}
              {livePolicies(row).map(policy => <option key={policy.id} value={policy.id}>{policy.title} · {salePolicyTimeLabel(policy.starts_at)} → {salePolicyTimeLabel(policy.ends_at)}</option>)}
            </select>
          </div>)}
          <Label htmlFor="batch-policy-reason">Lý do ngừng chính sách</Label><Textarea id="batch-policy-reason" value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></>}
      </fieldset>
      <Button type="button" disabled={locked || !selected.size} onClick={prepare}>Xem lại nội dung cập nhật</Button>
    </>}
    {draft && <div className="space-y-3">
      <h4 className="font-medium">Nội dung sẽ lưu cho {draft.commands.length} phòng</h4>
      <p className="text-sm text-muted-foreground">{draft.results.filter(result => result.status === 'applied').length}/{draft.commands.length} phòng đã xác nhận lưu.</p>
      {draft.commands.map(command => {
        const result = draft.results.find(item => item.requestId === command.input.requestId);
        return <article key={command.input.requestId} className="space-y-1 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><strong>{command.label}</strong><span>{result ? STATUS[result.status] : 'Chưa gửi'}</span></div>
          {command.kind === 'patch' ? Object.entries(command.input.patch).map(([key, value]) => <p key={key}>{FIELDS.find(field => field.key === key)?.label ?? key}: {value === null || (Array.isArray(value) && !value.length) ? '(xóa nội dung)' : Array.isArray(value) ? value.join(', ') : String(value)}</p>)
            : command.kind === 'policy' ? <><p className="font-medium">{command.input.policy.title}</p><p className="whitespace-pre-wrap">{command.input.policy.content}</p><p>{salePolicyTimeLabel(command.input.policy.starts_at)} → {salePolicyTimeLabel(command.input.policy.ends_at)}</p></>
              : <p>Ngừng chính sách · {command.input.reason}</p>}
          {result && <p role={result.status === 'applied' ? 'status' : 'alert'} className={result.status === 'applied' ? 'text-emerald-700' : 'text-muted-foreground'}>{result.message}</p>}
        </article>;
      })}
      {unresolved && <p role="alert" className="text-sm text-amber-700">Lô dừng ở phòng chưa rõ kết quả. Đối chiếu đúng yêu cầu đó trước khi tiếp tục; không tạo lô mới cho cùng nội dung.</p>}
      <div className="flex flex-wrap gap-2">
        {remaining > 0 && <Button type="button" disabled={busy || blocked} onClick={() => void execute()}>{busy ? 'Đang cập nhật…' : unresolved ? 'Đối chiếu và tiếp tục lô' : 'Lưu trực tiếp các phòng đã chọn'}</Button>}
        <Button type="button" variant="outline" disabled={busy || unresolved} onClick={reset}>{draft.results.length ? 'Lập lô mới từ dữ liệu hiện tại' : 'Quay lại sửa nội dung'}</Button>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
