import { useRef, useState } from 'react';
import { useContractMeterBoundaries, useReviseContractMeterBoundaries } from '@/hooks/useContractMeterBoundaries';
import type { MeterBoundaryInput } from '@/lib/contractMeterBoundaries';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ContractMeterBoundaryFields } from './ContractMeterBoundaryFields';

export function ContractMeterBoundaryPanel({ contractId, roomId, canEdit }: { contractId: string; roomId: string; canEdit: boolean }) {
  const query = useContractMeterBoundaries(contractId, 'MOVE_OUT');
  const revise = useReviseContractMeterBoundaries();
  const [editing, setEditing] = useState(false);
  const [boundary, setBoundary] = useState<MeterBoundaryInput | null>(null);
  const [reason, setReason] = useState('');
  const request = useRef<{ intent: string; key: string } | null>(null);
  // Khu này chỉ có khi đã có mốc bàn giao → chờ thì không vẽ gì (chủ chốt 02/10/2026).
  if (query.isPending) return <LoadingState label="chỉ số bàn giao" variant="none" />;
  if (query.isError) return <p role="alert" className="text-sm">Không tải được chỉ số bàn giao. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></p>;
  const value = query.data;
  if (!value) return null;
  const save = async () => {
    if (!boundary || !reason.trim()) return;
    const intent = JSON.stringify({ setId: value.id, expectedRevision: value.revision, reason: reason.trim(), boundary });
    if (request.current?.intent !== intent) request.current = { intent, key: crypto.randomUUID() };
    try {
      await revise.mutateAsync({ setId: value.id, expectedRevision: value.revision, reason: reason.trim(), boundary, idempotencyKey: request.current.key });
      setEditing(false); setReason('');
    } catch { /* Keep entries and request identity for retry; hook displays the error. */ }
  };
  return <div className="space-y-2 border-t pt-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Chỉ số lúc trả phòng · {value.state === 'VERIFIED' ? 'Đã kiểm tra' : value.state === 'MISSING' ? 'Chờ bổ sung' : 'Cần đối soát'}</h3>
      {canEdit && !editing && <Button size="sm" variant="outline" onClick={() => { setBoundary(null); setReason(''); request.current = null; setEditing(true); }}>Bổ sung / sửa chỉ số</Button>}
    </div>
    {value.state === 'MISSING' && <p className="text-muted-foreground">Hồ sơ còn thiếu mốc điện, nước. Phòng vẫn trống để sale; khách nhận phòng có mốc riêng.</p>}
    {value.state === 'REVIEW' && <p className="text-amber-700">Có hóa đơn liên quan cần kiểm tra lại theo mốc đã bổ sung.</p>}
    <ul className="space-y-1">{value.readings.map(row => <li key={row.id}>
      {row.meter_type === 'ELECTRICITY' ? 'Điện' : row.meter_type === 'WATER' ? 'Nước' : 'Đồng hồ'} · {row.meter_code || row.meter_id.slice(0, 8)}:
      {' '}<strong>{row.reading === null ? 'Chưa có số' : row.reading.toLocaleString('vi-VN')}</strong>
      {row.measured_at && <span className="text-muted-foreground"> · đo {new Date(row.measured_at).toLocaleString('vi-VN')}</span>}
    </li>)}</ul>
    {editing && <div className="space-y-3">
      <ContractMeterBoundaryFields roomId={roomId} disabled={revise.isPending} onChange={setBoundary} />
      <div className="space-y-1"><Label htmlFor={`meter-reason-${contractId}`}>Lý do bổ sung / sửa</Label>
        <Input id={`meter-reason-${contractId}`} value={reason} disabled={revise.isPending} onChange={event => setReason(event.target.value)} /></div>
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={revise.isPending} onClick={() => setEditing(false)}>Hủy</Button>
        <Button disabled={!boundary || !reason.trim() || revise.isPending} onClick={() => void save()}>{revise.isPending ? 'Đang lưu…' : 'Lưu chỉ số đã kiểm tra'}</Button></div>
    </div>}
    {!!value.history.length && <details><summary className="cursor-pointer">Lịch sử bổ sung ({value.history.length})</summary>
      <ul className="mt-2 space-y-1">{value.history.map(row => <li key={row.revision}>Lần {row.revision} · {row.reason} · {new Date(row.changed_at).toLocaleString('vi-VN')}</li>)}</ul>
    </details>}
  </div>;
}
