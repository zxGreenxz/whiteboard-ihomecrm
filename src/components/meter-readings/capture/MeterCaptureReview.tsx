import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StorageImage } from '@/components/ui/storage-image';
import { useSignedUrl } from '@/hooks/useSignedUrl';
import { confirmMeterCapture } from '@/lib/meter-capture/service';
import type { MeterCapture, MeterCaptureMeter } from '@/lib/meter-capture/types';
import { captureIssueLabel, captureReaderStatus } from '@/lib/meter-capture/feedback';

const statusLabels: Record<MeterCapture['status'], string> = { UPLOADING: 'Chưa nhận đủ tệp', QUEUED: 'Chờ đọc', PROCESSING: 'Đang đọc', REVIEW: 'Chờ xác nhận', CONFIRMED: 'Đã chốt', FAILED: 'Cần xem lại' };

export function MeterCaptureReview({ capture, meter, onChanged }: { capture: MeterCapture; meter?: MeterCaptureMeter; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState(capture.proposedValue ?? '');
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const videoUrl = useSignedUrl(expanded ? capture.videoUrl : null);
  const needsReason = capture.issues.length > 0 || !capture.proposedValue || value !== capture.proposedValue;
  const canConfirm = capture.mediaReceived && capture.mediaValidated === true && !['UPLOADING', 'CONFIRMED'].includes(capture.status);
  const confirm = async () => {
    setBusy(true); setError('');
    try {
      if (!verified) throw new Error('Đối chiếu đúng phòng, mặt số, thanh ghi và phần thập phân trước khi chốt.');
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('Nhập chỉ số không âm; dùng dấu chấm cho phần thập phân.');
      if (needsReason && reason.trim().length < 5) throw new Error('Ghi lý do xác nhận thủ công hoặc sửa số (ít nhất 5 ký tự).');
      await confirmMeterCapture({ orgId: capture.orgId, captureId: capture.id, expectedVersion: capture.version, value, reason: reason.trim() || undefined });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa xác nhận được chỉ số. Tải lại để kiểm tra.'); }
    finally { setBusy(false); }
  };
  return <article className="rounded-lg border p-3 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div><p className="font-medium">{meter ? `${meter.buildingName} · ${meter.roomName} · ${meter.code}` : 'Đồng hồ đang tải'}</p><p className="text-xs text-muted-foreground">{capture.readingDate} · {capture.purpose === 'MOVE_OUT' ? 'Thanh lý' : 'Kỳ tháng'} · {statusLabels[capture.status]}</p></div>
      <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? 'Thu gọn' : 'Xem / xác nhận'}</Button>
    </div>
    <div className="flex gap-4 text-sm"><span>Server: <strong>{capture.serverResult?.value ?? 'Chưa đọc được'}</strong> · {captureReaderStatus(capture.serverResult?.status)}</span><span>AI: <strong>{capture.aiResult?.value ?? 'Chưa đọc được'}</strong> · {captureReaderStatus(capture.aiResult?.status)}</span></div>
    {capture.issues.length > 0 && <p className="text-sm text-amber-700">Cần xem lại: {[...new Set(capture.issues.map(captureIssueLabel))].join(' · ')}</p>}
    {expanded && <>
      {capture.evidenceUrl && <StorageImage value={capture.evidenceUrl} alt="Ảnh đối chiếu đồng hồ nội bộ" className="max-h-96 w-full object-contain" />}
      {videoUrl && <video src={videoUrl} controls playsInline preload="metadata" className="max-h-96 w-full rounded" />}
      {!capture.evidenceUrl && !videoUrl && <p className="text-sm text-muted-foreground">Chờ ảnh chứng cứ từ server trước khi xác nhận.</p>}
      {capture.mediaReceived && capture.mediaValidated !== true && capture.status !== 'CONFIRMED' && <p className="text-sm text-muted-foreground">Đã nhận tệp. Chờ máy chủ kiểm tra ảnh/clip gốc đọc được trước khi chốt chỉ số.</p>}
      {canConfirm && <div className="space-y-3">
        <Label htmlFor={`meter-value-${capture.id}`}>Chỉ số xác nhận (kWh)</Label>
        <Input id={`meter-value-${capture.id}`} inputMode="decimal" value={value} onChange={event => { setValue(event.target.value.trim()); setVerified(false); }} />
        <Label htmlFor={`meter-reason-${capture.id}`}>{needsReason ? 'Lý do xác nhận thủ công / sửa số (bắt buộc)' : 'Ghi chú đối chiếu'}</Label>
        <Input id={`meter-reason-${capture.id}`} value={reason} onChange={event => setReason(event.target.value)} />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />Tôi đã đối chiếu ảnh/clip, đúng đồng hồ và thanh ghi {meter?.profile?.registerCode ?? 'kWh'}; chỉ số và phần thập phân chính xác.</label>
        <Button disabled={busy || !verified || (!capture.evidenceUrl && !videoUrl) || (needsReason && reason.trim().length < 5)} onClick={() => void confirm()}>{busy ? 'Đang chốt…' : 'Xác nhận chốt chỉ số'}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>}
  </article>;
}
