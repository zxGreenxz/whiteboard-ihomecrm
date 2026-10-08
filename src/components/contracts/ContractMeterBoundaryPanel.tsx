import { useRef, useState } from 'react';
import { useContractMeterBoundaries, useReviseContractMeterBoundaries } from '@/hooks/useContractMeterBoundaries';
import type { ContractMeterBoundarySet, MeterBoundaryInput } from '@/lib/contractMeterBoundaries';
import type { ContractExitCase } from '@/lib/contractExitCases';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ContractMeterBoundaryFields } from './ContractMeterBoundaryFields';

type ExitContext = Pick<ContractExitCase, 'state' | 'current_kind'>;
// Bằng chứng server ghi khi lấy số từ chỉ số chốt (20261008025958): giờ đo không biết, chỉ ghi
// giới hạn cuối ngày trả phòng ⇒ hiện ngày, không hiện giờ.
const SETTLEMENT_EVIDENCE = 'Chỉ số chốt khi quyết toán';

/** Số đang ghi ở mốc REVIEW, gửi lại nguyên văn: server coi là đã đối soát. */
function currentReadings(value: ContractMeterBoundarySet): MeterBoundaryInput | null {
  const readings = value.readings.flatMap(row => row.reading === null || !row.measured_at ? []
    : [{ meterId: row.meter_id, reading: row.reading, measuredAt: new Date(row.measured_at).toISOString(), evidence: row.evidence }]);
  return readings.length && readings.length === value.readings.length ? { state: 'VERIFIED', readings } : null;
}

function missingNote(exit?: ExitContext) {
  if (exit?.current_kind === 'FORFEIT') return 'Bỏ cọc: cọc đã cấn mọi khoản nên không cần số điện chốt. Số đầu của khách sau do quản lý nhập khi làm hợp đồng mới.';
  if (exit?.state === 'PENDING') return 'Số điện cuối nhập ở bước quyết toán (Tiền điện chốt số). Quyết toán xong, mốc này tự lấy số đó.';
  return 'Đã quyết toán nhưng chưa có số điện chốt. Bấm “Bổ sung / sửa chỉ số” để nhập số đồng hồ lúc khách trả phòng.';
}

export function ContractMeterBoundaryPanel({ contractId, roomId, canEdit, exit }: { contractId: string; roomId: string; canEdit: boolean; exit?: ExitContext }) {
  const query = useContractMeterBoundaries(contractId, 'MOVE_OUT');
  const revise = useReviseContractMeterBoundaries();
  const [mode, setMode] = useState<'idle' | 'edit' | 'reconcile'>('idle');
  const [boundary, setBoundary] = useState<MeterBoundaryInput | null>(null);
  const [reason, setReason] = useState('');
  const request = useRef<{ intent: string; key: string } | null>(null);
  // Khu này chỉ có khi đã có mốc bàn giao → chờ thì không vẽ gì (chủ chốt 02/10/2026).
  if (query.isPending) return <LoadingState label="chỉ số bàn giao" variant="none" />;
  if (query.isError) return <p role="alert" className="text-sm">Không tải được chỉ số bàn giao. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></p>;
  const value = query.data;
  if (!value) return null;
  const forfeitWithoutReading = value.state === 'MISSING' && exit?.current_kind === 'FORFEIT';
  const payload = mode === 'reconcile' ? currentReadings(value) : boundary;
  const open = (next: 'edit' | 'reconcile') => { setBoundary(null); setReason(''); request.current = null; setMode(next); };
  const save = async () => {
    if (!payload || !reason.trim()) return;
    const intent = JSON.stringify({ setId: value.id, expectedRevision: value.revision, reason: reason.trim(), boundary: payload });
    if (request.current?.intent !== intent) request.current = { intent, key: crypto.randomUUID() };
    try {
      await revise.mutateAsync({ setId: value.id, expectedRevision: value.revision, reason: reason.trim(), boundary: payload, idempotencyKey: request.current.key });
      setMode('idle'); setReason('');
    } catch { /* Keep entries and request identity for retry; hook displays the error. */ }
  };
  return <div className="space-y-2 border-t pt-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Chỉ số lúc trả phòng · {value.state === 'VERIFIED' ? 'Đã kiểm tra' : forfeitWithoutReading ? 'Không cần số chốt' : value.state === 'MISSING' ? 'Chờ bổ sung' : 'Cần đối soát'}</h3>
      {canEdit && mode === 'idle' && <div className="flex flex-wrap gap-2">
        {value.state === 'REVIEW' && !!currentReadings(value) && <Button size="sm" onClick={() => open('reconcile')}>Đã đối soát, giữ số này</Button>}
        <Button size="sm" variant="outline" onClick={() => open('edit')}>Bổ sung / sửa chỉ số</Button>
      </div>}
    </div>
    {value.state === 'MISSING' && <p className="text-muted-foreground">{missingNote(exit)}</p>}
    {value.state === 'REVIEW' && <p className="text-amber-700">Số bổ sung khác số điện chốt đã tính tiền khi quyết toán. Kiểm tra lại hoá đơn quyết toán; xong thì bấm “Đã đối soát”, hoặc sửa về đúng số đã tính tiền.</p>}
    <ul className="space-y-1">{value.readings.map(row => <li key={row.id}>
      {row.meter_type === 'ELECTRICITY' ? 'Điện' : row.meter_type === 'WATER' ? 'Nước' : 'Đồng hồ'} · {row.meter_code || row.meter_id.slice(0, 8)}:
      {' '}<strong>{row.reading === null ? 'Chưa có số' : row.reading.toLocaleString('vi-VN')}</strong>
      {row.measured_at && <span className="text-muted-foreground"> · {row.evidence?.startsWith(SETTLEMENT_EVIDENCE)
        ? `chốt khi quyết toán, ngày ${new Date(row.measured_at).toLocaleDateString('vi-VN')}`
        : `đo ${new Date(row.measured_at).toLocaleString('vi-VN')}`}</span>}
    </li>)}</ul>
    {mode !== 'idle' && <div className="space-y-3">
      {mode === 'edit' && <ContractMeterBoundaryFields roomId={roomId} disabled={revise.isPending} onChange={setBoundary} />}
      <div className="space-y-1"><Label htmlFor={`meter-reason-${contractId}`}>{mode === 'reconcile' ? 'Đã đối soát thế nào' : 'Lý do bổ sung / sửa'}</Label>
        <Input id={`meter-reason-${contractId}`} value={reason} disabled={revise.isPending} onChange={event => setReason(event.target.value)} /></div>
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={revise.isPending} onClick={() => setMode('idle')}>Hủy</Button>
        <Button disabled={!payload || !reason.trim() || revise.isPending} onClick={() => void save()}>
          {revise.isPending ? 'Đang lưu…' : mode === 'reconcile' ? 'Xác nhận đã đối soát' : 'Lưu chỉ số đã kiểm tra'}</Button></div>
    </div>}
    {!!value.history.length && <details><summary className="cursor-pointer">Lịch sử bổ sung ({value.history.length})</summary>
      <ul className="mt-2 space-y-1">{value.history.map(row => <li key={row.revision}>Lần {row.revision} · {row.reason} · {new Date(row.changed_at).toLocaleString('vi-VN')}</li>)}</ul>
    </details>}
  </div>;
}
