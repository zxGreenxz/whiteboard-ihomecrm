import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useSetContractExitEarlyTerms } from '@/hooks/contracts/useContractExitEarlyTerms';
import {
  EARLY_REASONS, EARLY_REASON_LABELS, EARLY_REASON_NOTES, contractNumberLabel, isTransferReason,
  type ContractExitEarlyTerms, type EarlyReason,
} from '@/lib/contractExitEarlyTerms';

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);
const dateTime = (value: string) => new Date(value).toLocaleString('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
});

/** Ba lựa chọn con dưới "Trả phòng trước hạn" (dùng cho thanh lý mới và khi đổi trường hợp). */
export function EarlyReasonChoice(props: {
  value: EarlyReason | null; onChange: (value: EarlyReason) => void;
  saleName: string; onSaleNameChange: (value: string) => void; disabled?: boolean;
}) {
  const id = useId();
  return <fieldset disabled={props.disabled} className="space-y-2 rounded-md border border-dashed p-3">
    <legend className="px-1 text-sm font-medium">Trường hợp trả phòng trước hạn <span className="text-destructive">*</span></legend>
    {EARLY_REASONS.map(reason => <label key={reason}
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${props.value === reason ? 'border-primary bg-primary/5' : ''}`}>
      <input type="radio" className="mt-1" name={`${id}-early`} value={reason} checked={props.value === reason}
        onChange={() => props.onChange(reason)} />
      <span>{EARLY_REASON_LABELS[reason]}</span>
    </label>)}
    {props.value === 'SALE_ASSISTED' && <div className="space-y-1">
      <Label htmlFor={`${id}-sale`}>Tên sale / môi giới <span className="text-destructive">*</span></Label>
      <Input id={`${id}-sale`} value={props.saleName} maxLength={200} aria-invalid={!props.saleName.trim()}
        onChange={event => props.onSaleNameChange(event.target.value)} placeholder="Người nhận phiếu hoa hồng môi giới" />
      {!props.saleName.trim() && <p role="alert" className="text-xs text-destructive">Nhập tên sale / môi giới.</p>}
    </div>}
    {props.value && <p className="rounded-md bg-muted p-2 text-xs" data-testid="early-reason-note">{EARLY_REASON_NOTES[props.value]}</p>}
    {!props.value && <p role="alert" className="text-xs text-destructive">Chọn một trong ba trường hợp.</p>}
  </fieldset>;
}

/** Dòng trạng thái giữ phòng / khách nhận của hồ sơ đã ghi. */
export function earlyTermsStatus(terms: ContractExitEarlyTerms): string {
  if (!isTransferReason(terms.early_reason)) return 'Phòng rao bán như bình thường.';
  if (terms.new_contract_id) return `Khách nhận: ${contractNumberLabel(terms.new_contract_number)} (đã tự nối).`;
  if (terms.reopened_at) return `Đã mở bán lại${terms.reopened_by_name ? ` bởi ${terms.reopened_by_name}` : ''}; hợp đồng mới không tự nối.`;
  if (terms.hold_open && terms.hold_until) return `Đang giữ phòng cho khách nhận tới ${dateTime(terms.hold_until)}. Chưa có hợp đồng khách nhận.`;
  return 'Đã hết hạn giữ, phòng đang rao lại. Chưa có hợp đồng khách nhận.';
}

/**
 * Trường hợp của hồ sơ đã ghi (bước 1 khi quyết toán): hiện trường hợp, nút "Đổi trường hợp" kèm lý do. Hồ sơ trả phòng
 * trước hạn chưa có trường hợp (ghi bằng Hermes hoặc trước khi có tính năng) thì mở sẵn ô chọn.
 */
export function ExitEarlyTermsPanel(props: {
  exitCaseId: string; terms: ContractExitEarlyTerms | null | undefined; loading: boolean; error: boolean;
  onRetry?: () => void; disabled?: boolean; presetChange?: EarlyReason | null; onPresetConsumed?: () => void;
}) {
  const id = useId();
  const save = useSetContractExitEarlyTerms();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState<EarlyReason | null>(null);
  const [saleName, setSaleName] = useState('');
  const [note, setNote] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const { terms } = props;
  const formOpen = editing || (!props.loading && !props.error && !terms);
  const startEdit = (preset?: EarlyReason | null) => {
    setReason(preset ?? terms?.early_reason ?? null);
    setSaleName(terms?.sale_name ?? '');
    setNote('');
    setEditing(true);
  };
  const { presetChange, onPresetConsumed } = props;
  useEffect(() => {
    if (!presetChange) return;
    setReason(presetChange);
    setSaleName('');
    setNote('');
    setEditing(true);
    onPresetConsumed?.();
  }, [presetChange, onPresetConsumed]);
  if (props.loading) return <div className="h-16 animate-pulse rounded-md bg-muted" aria-label="Đang đọc trường hợp trả phòng" />;
  if (props.error) return <p role="alert" className="text-sm text-destructive">
    Không tải được trường hợp trả phòng trước hạn. {props.onRetry && <Button variant="link" className="h-auto p-0" onClick={props.onRetry}>Thử lại</Button>}
  </p>;
  const unchanged = !!terms && reason === terms.early_reason && (reason !== 'SALE_ASSISTED' || saleName.trim() === (terms.sale_name ?? ''));
  const ready = !!reason && (reason !== 'SALE_ASSISTED' || !!saleName.trim()) && !!note.trim() && !unchanged;
  const submit = async () => {
    if (!ready || !reason) return;
    const intent = JSON.stringify({ case: props.exitCaseId, version: terms?.version ?? 0, reason, saleName: saleName.trim(), note: note.trim() });
    let requestId = requestIds.current.get(intent);
    if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(intent, requestId); }
    try {
      await save.mutateAsync({ caseId: props.exitCaseId, expectedVersion: terms?.version ?? 0, requestId,
        earlyReason: reason, saleName: reason === 'SALE_ASSISTED' ? saleName.trim() : null, reason: note.trim() });
      setEditing(false);
    } catch { /* Hook đã báo lỗi; giữ nguyên ô đang điền để thử lại. */ }
  };
  return <section aria-label="Trường hợp trả phòng trước hạn" className="space-y-2 rounded-md border p-3 text-sm">
    {terms && !formOpen && <>
      <p>Trường hợp: <strong>{EARLY_REASON_LABELS[terms.early_reason]}</strong>
        {terms.early_reason === 'SALE_ASSISTED' && terms.sale_name && <> · Sale: <strong>{terms.sale_name}</strong></>}</p>
      {terms.early_reason === 'SALE_ASSISTED' && <p>Phí môi giới: <strong>{vnd(terms.broker_fee)} đ</strong></p>}
      <p className="text-muted-foreground">{earlyTermsStatus(terms)}</p>
      {terms.exit_state === 'PENDING' && <Button type="button" size="sm" variant="outline" disabled={props.disabled}
        onClick={() => startEdit()}>Đổi trường hợp</Button>}
    </>}
    {formOpen && <div className="space-y-3">
      {!terms && <p className="font-medium text-amber-800">Hồ sơ chưa chọn trường hợp trả phòng trước hạn (ghi từ Hermes hoặc trước khi có tính năng này). Chọn trường hợp trước khi quyết toán.</p>}
      <EarlyReasonChoice value={reason} onChange={setReason} saleName={saleName} onSaleNameChange={setSaleName}
        disabled={props.disabled || save.isPending} />
      <div className="space-y-1">
        <Label htmlFor={`${id}-note`}>{terms ? 'Lý do đổi trường hợp' : 'Ghi chú khi chọn trường hợp'} <span className="text-destructive">*</span></Label>
        <Textarea id={`${id}-note`} rows={2} value={note} disabled={props.disabled || save.isPending} aria-invalid={!note.trim()}
          onChange={event => setNote(event.target.value)} placeholder="Ghi rõ để đối soát sau này" />
        {unchanged && <p role="alert" className="text-xs text-destructive">Trường hợp không đổi.</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {terms && <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={() => setEditing(false)}>Huỷ</Button>}
        <Button type="button" size="sm" disabled={!ready || save.isPending || props.disabled} onClick={() => void submit()}>
          {save.isPending ? 'Đang lưu…' : terms ? 'Lưu trường hợp mới' : 'Lưu trường hợp'}
        </Button>
      </div>
    </div>}
  </section>;
}
