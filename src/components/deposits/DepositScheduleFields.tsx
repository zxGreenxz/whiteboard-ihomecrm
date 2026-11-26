import { useEffect, useState } from 'react';
import { DateInput } from '@/components/ui/date-input';

export type DepositSchedule = {
  holdUntil: string;
  moveIn: string;
  topup: string;
};

export const emptyDepositSchedule: DepositSchedule = { holdUntil: '', moveIn: '', topup: '' };

export function addDepositDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const result = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(result.getTime())) return '';
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function DepositScheduleFields({ value, voucherDate, onChange, disabled = false, targetHold, destinationChanged }: {
  destinationChanged?: boolean;
  targetHold?: {id:string; payer?:string|null} | null;
  value: DepositSchedule;
  voucherDate: string;
  onChange: (value: DepositSchedule) => void;
  disabled?: boolean;
}) {
  const [moveInEdited, setMoveInEdited] = useState(Boolean(value.moveIn && value.moveIn !== value.holdUntil));
  useEffect(()=>{
    if(value.moveIn && value.moveIn!==value.holdUntil)setMoveInEdited(true);
  },[value.moveIn,value.holdUntil]);
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    if (offset === null || !voucherDate) return;
    const next = addDepositDays(voucherDate, offset);
    if (next && next !== value.topup) onChange({ ...value, topup: next });
  }, [offset, voucherDate, value, onChange]);

  return <fieldset disabled={disabled} className="grid gap-3">
    {destinationChanged && <p role="alert" className="text-sm text-destructive">Lượt giữ chỗ đã đổi. Mở lại phiếu để chọn đúng lượt thu.</p>}
    {!destinationChanged && targetHold !== undefined && <p className="text-sm" role="status">{targetHold
      ? `Phiếu này bổ sung vào lượt đang giữ${targetHold.payer ? ' · '+targetHold.payer : ''}.`
      : 'Phiếu này mở lượt giữ chỗ mới. Các phiếu cũ chưa xác định lượt được đối chiếu riêng.'}</p>}
    <div className="grid grid-cols-2 gap-2">
      <label className="grid gap-1 text-sm">Giữ chỗ đến
        <DateInput aria-label="Giữ chỗ đến" name="hold_until" value={value.holdUntil} onChange={holdUntil => onChange({
          ...value, holdUntil, moveIn: moveInEdited ? value.moveIn : holdUntil,
        })} />
      </label>
      <label className="grid gap-1 text-sm">Ngày dự kiến vào
        <DateInput aria-label="Ngày dự kiến vào" name="intended_move_in_on" value={value.moveIn} onChange={moveIn => {
          setMoveInEdited(true);
          onChange({ ...value, moveIn });
        }} />
      </label>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid w-36 gap-1 text-sm">Ngày bổ sung cọc
        <DateInput aria-label="Ngày bổ sung cọc" name="topup_due_date" value={value.topup} onChange={topup => {
          setOffset(null);
          onChange({ ...value, topup });
        }} />
      </label>
      <div className="flex flex-wrap gap-1" aria-label="Chọn nhanh từ ngày phiếu">
        {[3, 4, 5, 6, 7].map(days => <button key={days} type="button" disabled={!voucherDate || disabled}
          aria-label={'Sau ngày phiếu ' + days + ' ngày'} aria-pressed={offset === days}
          className="min-h-9 rounded border px-2 text-sm aria-pressed:bg-secondary"
          onClick={() => {
            setOffset(days);
            onChange({ ...value, topup: addDepositDays(voucherDate, days) });
          }}>{days}N</button>)}
      </div>
    </div>
    {value.holdUntil && value.topup > value.holdUntil && <p className="text-xs text-muted-foreground">
      Hạn bổ sung sau ngày giữ chỗ. Phòng vẫn được giữ đến khi quản lý xử lý.
    </p>}
  </fieldset>;
}
