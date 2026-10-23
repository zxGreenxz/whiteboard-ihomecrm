import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MeterEvidenceViewer } from '../MeterEvidenceViewer';
import { confirmMeterCapture } from '@/lib/meter-capture/service';
import type { MeterCapture, MeterCaptureMeter } from '@/lib/meter-capture/types';
import { captureIssueLabel, captureReaderStatus } from '@/lib/meter-capture/feedback';

const statusLabels: Record<MeterCapture['status'], string> = { UPLOADING: 'Chưa nhận đủ tệp', QUEUED: 'Chờ đọc', PROCESSING: 'Đang đọc', REVIEW: 'Chờ xác nhận', CONFIRMED: 'Đã chốt', FAILED: 'Cần xem lại' };

export function MeterCaptureReview({ capture, meter, onChanged }: { capture: MeterCapture; meter?: MeterCaptureMeter; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState(capture.proposedValue ?? '');
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [replacementVerified, setReplacementVerified] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setVerified(false); setReplacementVerified(false); }, [capture.id, capture.version, capture.previousValue, capture.replacement?.id, capture.replacement?.version]);
  const consumption = value && capture.previousValue != null ? Number(value) - Number(capture.previousValue) : null;
  const decreased = consumption != null && consumption < 0;
  const hasEvidence = !!capture.evidenceUrl || !!capture.videoUrl || capture.evidenceFrames.length > 0;
  const needsReason = !!capture.replacement || decreased || capture.issues.length > 0 || !capture.proposedValue || value !== capture.proposedValue;
  const canConfirm = capture.mediaReceived && capture.mediaValidated === true && !['UPLOADING', 'CONFIRMED'].includes(capture.status);
  const confirm = async () => {
    setBusy(true); setError('');
    try {
      if (!verified) throw new Error('Đối chiếu đúng phòng, mặt số, thanh ghi và phần thập phân trước khi chốt.');
      if (capture.replacement && !replacementVerified) throw new Error('Xác nhận thay thế chỉ số đã chốt bằng lượt chứng cứ này.');
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('Nhập chỉ số không âm; dùng dấu chấm cho phần thập phân.');
      if (needsReason && reason.trim().length < 5) throw new Error('Ghi lý do xác nhận thủ công hoặc sửa số (ít nhất 5 ký tự).');
      await confirmMeterCapture({ orgId: capture.orgId, captureId: capture.id, expectedVersion: capture.version,
        expectedPreviousValue: capture.previousValue,
        ...(capture.replacement ? { supersedesCaptureId: capture.replacement.id, expectedSupersededVersion: capture.replacement.version } : {}),
        value, reason: reason.trim() || undefined });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa xác nhận được chỉ số. Tải lại để kiểm tra.'); }
    finally { setBusy(false); }
  };
  return <article className="rounded-lg border p-3 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div><p className="font-medium">{meter ? `${meter.buildingName} · ${meter.roomName} · ${meter.code}` : 'Đồng hồ đang tải'}</p><p className="text-xs text-muted-foreground">{capture.readingDate} · {capture.purpose === 'MOVE_OUT' ? 'Thanh lý' : 'Kỳ tháng'} · {capture.supersededBy ? 'Đã thay bằng bản điều chỉnh' : statusLabels[capture.status]}</p></div>
      <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? 'Thu gọn' : 'Xem / xác nhận'}</Button>
    </div>
    <div className="flex flex-wrap gap-4 text-sm"><span>AI: <strong>{capture.aiResult?.value ?? 'Chưa đọc được'}</strong> · {captureReaderStatus(capture.aiResult?.status)}</span><span>OCR: <strong>{capture.serverResult?.value ?? 'Chưa đọc được'}</strong> · {captureReaderStatus(capture.serverResult?.status)}</span></div>
    {capture.status === 'CONFIRMED' && <p className="text-sm font-medium">Chỉ số đã chốt: {capture.proposedValue} kWh</p>}
    {capture.supersededBy && <p className="text-sm text-amber-700">Đã có bản chốt thay thế. Bản này và chứng cứ được giữ để đối chiếu lịch sử.</p>}
    {capture.issues.length > 0 && <p className="text-sm text-amber-700">Cần xem lại: {[...new Set(capture.issues.map(captureIssueLabel))].join(' · ')}</p>}
    {expanded && <>
      {hasEvidence ? <MeterEvidenceViewer imageUrl={capture.evidenceUrl} videoUrl={capture.videoUrl} evidenceFrames={capture.evidenceFrames} />
        : <p className="text-sm text-muted-foreground">Chờ ảnh chứng cứ từ server trước khi xác nhận.</p>}
      <p className="text-sm">Chỉ số trước đã lưu: <strong>{capture.previousValue == null ? 'Chưa có mốc đối chiếu' : `${Number(capture.previousValue).toLocaleString('vi-VN')} kWh`}</strong>
        {consumption != null && Number.isFinite(consumption) && <> · Chênh lệch: <strong>{Number(consumption.toFixed(6)).toLocaleString('vi-VN')} kWh</strong></>}</p>
      {decreased && <p role="alert" className="text-sm text-destructive">Chỉ số mới nhỏ hơn chỉ số trước đã lưu. Đối chiếu lại đồng hồ, ngày chốt và ghi lý do; hệ thống sẽ kiểm tra lại khi xác nhận.</p>}
      {capture.mediaReceived && capture.mediaValidated !== true && capture.status !== 'CONFIRMED' && <p className="text-sm text-muted-foreground">Đã nhận tệp. Chờ máy chủ kiểm tra ảnh/clip gốc đọc được trước khi chốt chỉ số.</p>}
      {canConfirm && <div className="space-y-3">
        {capture.replacement && <div className="rounded border border-amber-300 p-3 text-sm space-y-2">
          <p>Ngày này đã chốt {capture.replacement.value} kWh. Lượt này sẽ tạo bản thay thế và giữ nguyên bản cũ. Nếu bản cũ đã dùng cho hóa đơn hoặc thanh lý, kế toán cần xử lý điều chỉnh; số tiền cũ không tự đổi.</p>
          <label className="flex gap-2"><input type="checkbox" checked={replacementVerified} onChange={event => setReplacementVerified(event.target.checked)} />Tôi xác nhận thay thế chỉ số đã chốt này.</label>
        </div>}
        <Label htmlFor={`meter-value-${capture.id}`}>Chỉ số xác nhận (kWh)</Label>
        <Input id={`meter-value-${capture.id}`} inputMode="decimal" value={value} onChange={event => { setValue(event.target.value.trim()); setVerified(false); }} />
        <Label htmlFor={`meter-reason-${capture.id}`}>{needsReason ? 'Lý do xác nhận thủ công / sửa số (bắt buộc)' : 'Ghi chú đối chiếu'}</Label>
        <Input id={`meter-reason-${capture.id}`} value={reason} onChange={event => setReason(event.target.value)} />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />Tôi đã đối chiếu ảnh/clip, đúng đồng hồ và thanh ghi {meter?.profile?.registerCode ?? 'kWh'}; chỉ số và phần thập phân chính xác.</label>
        <Button disabled={busy || !verified || !hasEvidence || (!!capture.replacement && !replacementVerified) || (needsReason && reason.trim().length < 5)} onClick={() => void confirm()}>{busy ? 'Đang chốt…' : 'Xác nhận chốt chỉ số'}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>}
  </article>;
}
