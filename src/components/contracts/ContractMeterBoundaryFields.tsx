import { useEffect, useId, useMemo, useState } from 'react';
import { useMeters } from '@/hooks/useMeters';
import type { MeterBoundaryInput } from '@/lib/contractMeterBoundaries';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';

const MISSING_REASON = 'Chưa đủ chỉ số khi nhận bàn giao, bổ sung sau';
function localDateTime(value = new Date()) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
interface Props {
  roomId: string;
  allowMissing?: boolean;
  disabled?: boolean;
  initialValue?: MeterBoundaryInput | null;
  onChange: (value: MeterBoundaryInput | null) => void;
}

/** Physical readings only. Never default an unknown reading to zero or another tenant's reading. */
export function ContractMeterBoundaryFields({ roomId, allowMissing = false, disabled = false, initialValue, onChange }: Props) {
  const id = useId();
  const query = useMeters(roomId);
  const meters = useMemo(() => (query.data ?? []).filter(meter => meter.status === 'ACTIVE'), [query.data]);
  const [missing, setMissing] = useState(allowMissing && initialValue?.state !== 'VERIFIED');
  const [readings, setReadings] = useState<Record<string, string>>(() => initialValue?.state === 'VERIFIED'
    ? Object.fromEntries(initialValue.readings.map(row => [row.meterId, String(row.reading)])) : {});
  const [measuredAt, setMeasuredAt] = useState(() => localDateTime(initialValue?.state === 'VERIFIED' && initialValue.readings[0]
    ? new Date(initialValue.readings[0].measuredAt) : new Date()));
  useEffect(() => {
    if (missing && allowMissing) { onChange({ state: 'MISSING', reason: MISSING_REASON }); return; }
    const date = new Date(measuredAt);
    if (query.isPending || query.isError || !Number.isFinite(date.getTime()) || date.getTime() > Date.now()
      || meters.some(meter => !readings[meter.id]?.trim() || !Number.isFinite(Number(readings[meter.id])) || Number(readings[meter.id]) < 0)) {
      onChange(null); return;
    }
    onChange({ state: 'VERIFIED', readings: meters.map(meter => ({ meterId: meter.id, reading: Number(readings[meter.id]), measuredAt: date.toISOString() })) });
  }, [allowMissing, missing, measuredAt, meters, readings, query.isPending, query.isError, onChange]);

  return <fieldset disabled={disabled} className="space-y-3 rounded-md border p-3">
    <legend className="px-1 text-sm font-medium">Chỉ số điện, nước khi bàn giao</legend>
    {allowMissing && <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={missing} onChange={event => setMissing(event.target.checked)} className="mt-1" />
      <span>Chưa đủ chỉ số, bổ sung sau. Vẫn ghi nhận khách đã trả phòng.</span>
    </label>}
    {!missing && <>
      {query.isPending ? <LoadingState label="đồng hồ của phòng" variant="detail" rows={2} />
        : query.isError ? <p role="alert" className="text-sm text-destructive">Không tải được đồng hồ. <Button variant="link" type="button" onClick={() => void query.refetch()}>Thử lại</Button></p>
        : <>
          {!meters.length && <p className="text-sm text-muted-foreground">Phòng chưa có đồng hồ đang hoạt động.</p>}
          {meters.map(meter => <div key={meter.id} className="grid grid-cols-2 items-center gap-3">
            <Label htmlFor={`${id}-${meter.id}`}>{meter.meter_type === 'ELECTRICITY' ? 'Điện' : meter.meter_type === 'WATER' ? 'Nước' : 'Đồng hồ'} · {meter.code}</Label>
            <Input id={`${id}-${meter.id}`} type="number" min="0" step="any" value={readings[meter.id] ?? ''} placeholder="Nhập số đã kiểm tra"
              onChange={event => setReadings(previous => ({ ...previous, [meter.id]: event.target.value }))} />
          </div>)}
          {!!meters.length && <div className="space-y-1"><Label htmlFor={`${id}-measured`}>Thời điểm đo thực tế</Label>
            <Input id={`${id}-measured`} type="datetime-local" value={measuredAt} onChange={event => setMeasuredAt(event.target.value)} /></div>}
        </>}
      <p className="text-xs text-muted-foreground">Ghi số trên đồng hồ đã kiểm tra cho lần bàn giao này. Chưa biết thì để trống; số 0 chỉ dùng khi đồng hồ thực tế bằng 0.</p>
    </>}
  </fieldset>;
}
