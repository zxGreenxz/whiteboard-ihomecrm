import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ContractExitCase, ExitKind } from '@/lib/contractExitCases';

export const EXIT_KIND_LABELS: Record<ExitKind, string> = {
  NATURAL_EXPIRY: 'Hết hạn hợp đồng',
  EARLY_RETURN: 'Trả phòng trước hạn',
  FORFEIT: 'Bỏ cọc',
};

const RETURN_NOTE_SAMPLES: Record<ExitKind, string> = {
  NATURAL_EXPIRY: 'Khách trả phòng do hết hạn hợp đồng.',
  EARLY_RETURN: 'Khách trả phòng trước thời hạn hợp đồng.',
  FORFEIT: 'Khách trả phòng và bỏ cọc.',
};

interface Props {
  actualDate: string; onDateChange: (value: string) => void;
  kind: ExitKind | null; onKindChange: (value: ExitKind) => void;
  exitCase?: Pick<ContractExitCase, 'initial_kind' | 'current_kind'>;
  changeReason: string; onReasonChange: (value: string) => void;
  returnNote: string; onReturnNoteChange: (value: string) => void;
  pending: boolean; onDefer: () => void; onContinue: () => void;
  physicalReady?: boolean; children?: ReactNode;
}

export function ContractReturnStep(props: Props) {
  const id = useId();
  const changingKind = !!props.exitCase && props.kind !== props.exitCase.current_kind;
  const valid = !!props.kind && !!props.actualDate && props.physicalReady !== false
    && (!!props.exitCase || !!props.returnNote.trim()) && (!changingKind || !!props.changeReason.trim());
  return <div className="space-y-5 py-2">
    <div className="space-y-2">
      <Label htmlFor={`${id}-date`}>Ngày khách thực tế trả phòng <span className="text-destructive">*</span></Label>
      <Input id={`${id}-date`} type="date" value={props.actualDate} disabled={!!props.exitCase || props.pending}
        onChange={event => props.onDateChange(event.target.value)} required />
    </div>
    <fieldset disabled={props.pending} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Loại thanh lý <span className="text-destructive">*</span></legend>
      {(Object.entries(EXIT_KIND_LABELS) as [ExitKind, string][]).map(([kind, label]) =>
        <label key={kind} className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm ${props.kind === kind ? 'border-primary bg-primary/5' : ''}`}>
          <input type="radio" name={`${id}-kind`} value={kind} checked={props.kind === kind}
            onChange={() => props.onKindChange(kind)} />{label}
        </label>)}
    </fieldset>
    {!props.exitCase && <div className="space-y-2">
      <Label htmlFor={`${id}-return-note`}>Nội dung thanh lý <span className="text-destructive">*</span></Label>
      <Textarea id={`${id}-return-note`} value={props.returnNote} disabled={props.pending} required
        aria-describedby={`${id}-return-note-help`} aria-invalid={!props.returnNote.trim()} rows={3}
        onChange={event => props.onReturnNoteChange(event.target.value)}
        placeholder="Nhập lý do và nội dung cần lưu để đối chiếu" />
      <p id={`${id}-return-note-help`} className="text-xs text-muted-foreground">
        Bắt buộc ghi nội dung để đối chiếu. Có thể dùng mẫu bên dưới và bổ sung nếu cần.
      </p>
      {!props.returnNote.trim() && <p role="alert" className="text-xs text-destructive">Nhập nội dung thanh lý trước khi tiếp tục.</p>}
      {props.kind && <div className="space-y-2 rounded-md bg-muted p-3">
        <p className="text-sm">{RETURN_NOTE_SAMPLES[props.kind]}</p>
        <Button type="button" size="sm" variant="outline" disabled={props.pending}
          onClick={() => props.kind && props.onReturnNoteChange(RETURN_NOTE_SAMPLES[props.kind])}>
          Dùng nội dung mẫu
        </Button>
      </div>}
    </div>}
    {props.exitCase && <div className="space-y-1 text-sm">
      <p className="font-medium">Nội dung thanh lý đã ghi</p>
      <p className="whitespace-pre-wrap break-words">{props.returnNote || 'Chưa có nội dung thanh lý'}</p>
    </div>}
    {props.exitCase && <p className="text-sm text-muted-foreground">Loại đã ghi lúc trả: {EXIT_KIND_LABELS[props.exitCase.initial_kind]}. Hồ sơ vẫn giữ thông tin này để đối soát.</p>}
    {changingKind && <div className="space-y-2">
      <Label htmlFor={`${id}-reason`}>Lý do đổi loại thanh lý <span className="text-destructive">*</span></Label>
      <Textarea id={`${id}-reason`} value={props.changeReason} disabled={props.pending}
        aria-invalid={!props.changeReason.trim()}
        onChange={event => props.onReasonChange(event.target.value)} placeholder="Ghi rõ lý do để đối soát sau này" />
      {!props.changeReason.trim() && <p role="alert" className="text-xs text-destructive">Nhập lý do đổi loại thanh lý trước khi tiếp tục.</p>}
    </div>}
    {props.children}
    {!props.exitCase && <p className="rounded-md bg-muted p-3 text-sm">
      Chọn quyết toán sau: xác nhận khách đã đi, phòng trống để sale và hồ sơ chuyển sang <strong>Chờ quyết toán</strong>.
      Tiền cọc, khấu trừ và tiền hoàn sẽ xử lý khi quyết toán theo cách đang dùng.
    </p>}
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
      {!props.exitCase && <Button disabled={!valid || props.pending} variant="outline" onClick={props.onDefer}>
        {props.pending ? 'Đang lưu…' : 'Trả phòng, quyết toán sau'}
      </Button>}
      <Button disabled={!valid || props.pending} onClick={props.onContinue}>
        {props.exitCase ? 'Tiếp tục quyết toán' : 'Tiếp tục quyết toán ngay'}
      </Button>
    </div>
  </div>;
}
