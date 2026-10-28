import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StorageImage } from '@/components/ui/storage-image';
import { LoadingState } from '@/components/loading/LoadingState';
import { MeterEvidenceViewer } from '../MeterEvidenceViewer';
import { MeterCaptureReview } from './MeterCaptureReview';
import { assignPanelDetection, confirmMeterCapture, getPanelEvidence } from '@/lib/meter-capture/service';
import { isBulkConfirmable } from '@/lib/meter-capture/panel';
import { captureIssueLabel } from '@/lib/meter-capture/feedback';
import type { MeterCapture, MeterCaptureMeter, MeterPanel, MeterPanelDetection } from '@/lib/meter-capture/types';

const statusLabels: Record<MeterPanel['status'], string> = { UPLOADING: 'Chưa nhận đủ tệp', QUEUED: 'Chờ đọc', PROCESSING: 'Đang đọc', REVIEW: 'Chờ xác nhận' };
const stateLabels: Record<MeterPanelDetection['state'], string> = {
  MATCHED: 'Đã khớp', UNMATCHED: 'Chưa khớp', AMBIGUOUS: 'Khớp nhiều phòng', DUPLICATE: 'Trùng đồng hồ',
  NO_PROFILE: 'Đồng hồ chưa đăng ký', NO_CONTRACT: 'Chưa xác định hợp đồng', OTHER_BUILDING: 'Tem thuộc tòa khác',
};
const matchKindLabels: Record<NonNullable<MeterPanelDetection['matchKind']>, string> = { QR: 'theo tem QR', LABEL: 'theo nhãn phòng', MANUAL: 'gán tay' };
// Not a discriminated union: tsconfig.app.json has no strictNullChecks, so it cannot narrow on `ok`.
type RowResult = { ok: boolean; message: string };

function stateLabel(detection: MeterPanelDetection): string {
  const label = stateLabels[detection.state];
  return detection.state === 'MATCHED' && detection.matchKind ? `${label} ${matchKindLabels[detection.matchKind]}` : label;
}
function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** One panel photo/clip: each detected meter is a row; matched rows reuse the single-capture review. */
export function MeterPanelReview({ panel, captures, meters, onChanged }: {
  panel: MeterPanel; captures: MeterCapture[]; meters: MeterCaptureMeter[]; onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [assigning, setAssigning] = useState<number | null>(null);
  const [assignErrors, setAssignErrors] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const original = useQuery({ queryKey: ['meter-panel-evidence', panel.orgId, panel.id], queryFn: () => getPanelEvidence(panel.orgId, panel.id),
    enabled: showOriginal, staleTime: 60_000, retry: false });

  const byId = new Map(captures.map(capture => [capture.id, capture]));
  const rows = [...panel.detections].sort((a, b) => a.index - b.index)
    .map(detection => ({ detection, child: detection.captureId ? byId.get(detection.captureId) : undefined }));
  const buildingMeters = meters.filter(meter => meter.buildingId === panel.buildingId);
  const assignedMeterIds = new Set(panel.detections.flatMap(detection => detection.captureId && detection.meterId ? [detection.meterId] : []));
  const eligible = rows.flatMap(({ child }) => child && isBulkConfirmable(child) ? [child] : []);
  const open = rows.filter(({ child }) => child?.status !== 'CONFIRMED').length;
  const matched = rows.filter(({ detection }) => detection.state === 'MATCHED').length;
  // A changed set of rows (polling, refresh after confirming) needs a fresh acknowledgement.
  const eligibleKey = eligible.map(capture => `${capture.id}:${capture.version}:${capture.proposedValue}:${capture.previousValue}`).join('|');
  useEffect(() => { setVerified(false); }, [eligibleKey]);
  const outcomes = Object.values(results);
  const failedCount = outcomes.filter(outcome => !outcome.ok).length;
  const status = panel.status === 'REVIEW' && rows.length > 0 && open === 0 ? 'Đã chốt hết các dòng' : statusLabels[panel.status];

  const meterName = (detection: MeterPanelDetection) => {
    const meter = detection.meterId ? meters.find(item => item.id === detection.meterId) : undefined;
    const code = detection.meterCode ?? meter?.code;
    return code ? `${detection.roomName ?? meter?.roomName ?? 'Chưa gán phòng'} · ${code}` : null;
  };
  const assign = async (detection: MeterPanelDetection) => {
    const meterId = picks[detection.index];
    if (!meterId || assigning !== null) return;
    setAssigning(detection.index); setAssignErrors(current => ({ ...current, [detection.index]: '' }));
    try {
      await assignPanelDetection({ orgId: panel.orgId, panelId: panel.id, detectionIndex: detection.index, meterId });
      await onChanged();
    } catch (cause) {
      if (mounted.current) setAssignErrors(current => ({ ...current, [detection.index]: messageOf(cause, 'Chưa gán được đồng hồ. Tải lại để kiểm tra.') }));
    } finally { if (mounted.current) setAssigning(null); }
  };
  const confirmAll = async () => {
    const note = reason.trim();
    if (bulkBusy || !verified || note.length < 5 || !eligible.length) return;
    const batch = eligible;
    setBulkBusy(true); setResults({});
    const outcome: Record<string, RowResult> = {};
    try {
      // Strictly one row after another, one attempt each: a failed row is reported, never retried here.
      for (const capture of batch) {
        if (!mounted.current) return;
        try {
          await confirmMeterCapture({ orgId: capture.orgId, captureId: capture.id, expectedVersion: capture.version,
            expectedPreviousValue: capture.previousValue, value: capture.proposedValue, reason: note });
          outcome[capture.id] = { ok: true, message: '' };
        } catch (cause) {
          outcome[capture.id] = { ok: false, message: messageOf(cause, 'Chưa xác nhận được chỉ số. Tải lại để kiểm tra.') };
        }
        if (mounted.current) setResults({ ...outcome });
      }
      await onChanged();
    } finally {
      if (mounted.current) { setBulkBusy(false); setVerified(false); }
    }
  };

  return <section aria-label={`Bảng đồng hồ ${panel.buildingName} ngày ${panel.readingDate}`} className="space-y-3 rounded-lg border border-primary/40 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium">{panel.buildingName} · Cả bảng đồng hồ</p>
        <p className="text-xs text-muted-foreground">{panel.readingDate} · {panel.purpose === 'MOVE_OUT' ? 'Thanh lý' : 'Kỳ tháng'} · {status}{panel.status === 'REVIEW' ? ` · ${rows.length} đồng hồ · ${matched} đã khớp` : ''}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {panel.mediaReceived && <Button variant="outline" size="sm" aria-expanded={showOriginal} onClick={() => setShowOriginal(current => !current)}>{showOriginal ? 'Ẩn ảnh/clip gốc' : 'Xem ảnh/clip gốc'}</Button>}
        {rows.length > 0 && <Button variant="outline" size="sm" aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? 'Thu gọn bảng' : 'Xem từng đồng hồ'}</Button>}
      </div>
    </div>
    {panel.aiStatus === 'unreadable' && <p className="text-sm text-amber-700">AI chưa đọc rõ bảng này; quay lại rõ hơn hoặc ghi từng đồng hồ.</p>}
    {panel.aiStatus === 'error' && <p className="text-sm text-amber-700">Bộ đọc chưa xử lý được bảng này; gửi lượt mới hoặc ghi từng đồng hồ.</p>}
    {panel.issues.length > 0 && <p className="text-sm text-amber-700">Cần xem lại: {[...new Set(panel.issues.map(captureIssueLabel))].join(' · ')}</p>}
    {showOriginal && (original.isError
      ? <p role="alert" className="text-sm text-destructive">Không tải được ảnh/clip gốc. {messageOf(original.error, '')} <button type="button" className="underline" onClick={() => void original.refetch()}>Thử lại</button></p>
      : original.data
        ? <MeterEvidenceViewer imageUrl={original.data.imageUrl} videoUrl={original.data.videoUrl} evidenceFrames={original.data.evidenceFrames} label="Ảnh cả bảng đồng hồ nội bộ" />
        : <LoadingState label="ảnh/clip cả bảng" rows={2} />)}
    {expanded && <>
      <ol className="space-y-2">
        {rows.map(({ detection, child }) => {
          const title = detection.label ?? `dòng ${detection.index + 1}`;
          const name = meterName(detection);
          const assignable = !detection.captureId && detection.state !== 'DUPLICATE';
          const result = child ? results[child.id] : undefined;
          const pickId = `panel-${panel.id}-meter-${detection.index}`;
          return <li key={detection.index} aria-label={`Dòng ${detection.label ?? detection.index + 1}`} className="space-y-2 rounded border p-2">
            <div className="flex items-start gap-3">
              {detection.cropUrl
                ? <button type="button" className="h-14 w-20 shrink-0 overflow-hidden rounded border bg-muted" aria-pressed={enlarged === detection.index}
                    aria-label={`Phóng to ảnh cắt ${title}`} onClick={() => setEnlarged(current => current === detection.index ? null : detection.index)}>
                    <StorageImage value={detection.cropUrl} alt={`Ảnh cắt ${title}`} className="h-full w-full object-contain" />
                  </button>
                : <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded border text-center text-xs text-muted-foreground">Không có ảnh cắt</span>}
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{detection.label ?? 'Không thấy nhãn'}{name ? ` → ${name}` : ''}</p>
                <p>{stateLabel(detection)} · AI: <strong>{detection.value ?? 'Chưa đọc rõ'}</strong>{detection.registerCode ? ` · ${detection.registerCode}` : ''}</p>
                {child && isBulkConfirmable(child) && <p className="text-xs text-muted-foreground">Xác nhận chung được: {child.previousValue} → {child.proposedValue} kWh</p>}
              </div>
            </div>
            {enlarged === detection.index && detection.cropUrl && <StorageImage value={detection.cropUrl} alt={`Ảnh cắt phóng to ${title}`} className="max-h-72 w-full rounded border object-contain" />}
            {child
              ? <MeterCaptureReview key={`${child.id}:${child.version}`} capture={child} meter={meters.find(item => item.id === child.meterId)} onChanged={onChanged} />
              : detection.captureId && <p className="text-xs text-muted-foreground">Chưa thấy lượt đọc của dòng này trong kỳ đang xem; bấm Tải lại kết quả.</p>}
            {detection.state === 'DUPLICATE' && <p className="text-xs text-amber-700">Hai dòng cùng khớp một đồng hồ; chụp riêng đồng hồ này ở chế độ Một đồng hồ.</p>}
            {assignable && <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={pickId}>Đồng hồ cho {title}</Label>
                <select id={pickId} className="h-10 w-full rounded border bg-background px-2" value={picks[detection.index] ?? ''} disabled={assigning !== null}
                  onChange={event => { const meterId = event.target.value; setPicks(current => ({ ...current, [detection.index]: meterId })); }}>
                  <option value="">Chọn đồng hồ của {panel.buildingName}</option>
                  {buildingMeters.map(meter => {
                    const used = assignedMeterIds.has(meter.id);
                    return <option key={meter.id} value={meter.id} disabled={!meter.profile || used}>{meter.roomName ?? 'Chưa gán phòng'} · {meter.code}{!meter.profile ? ' (chưa đăng ký)' : used ? ' (đã có trong bảng)' : ''}</option>;
                  })}
                </select>
              </div>
              <Button size="sm" disabled={assigning !== null || !picks[detection.index]} onClick={() => void assign(detection)}>{assigning === detection.index ? 'Đang gán…' : 'Gán'}</Button>
            </div>}
            {assignErrors[detection.index] && <p role="alert" className="text-sm text-destructive">{assignErrors[detection.index]}</p>}
            {result && (result.ok
              ? <p role="status" className="text-sm text-green-700">Đã chốt trong lượt xác nhận chung.</p>
              : <p role="alert" className="text-sm text-destructive">Chưa chốt: {result.message}</p>)}
          </li>;
        })}
      </ol>
      {panel.status === 'REVIEW' && open > 0 && <div className="space-y-2 rounded border border-dashed p-3">
        <p className="text-sm font-medium">{eligible.length}/{open} dòng đủ điều kiện; các dòng còn lại xác nhận từng dòng.</p>
        <Label htmlFor={`panel-reason-${panel.id}`}>Lý do xác nhận chung (bắt buộc)</Label>
        <Input id={`panel-reason-${panel.id}`} value={reason} disabled={bulkBusy} onChange={event => setReason(event.target.value)} />
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} disabled={bulkBusy} onChange={event => setVerified(event.target.checked)} />Tôi đã xem ảnh từng đồng hồ và đối chiếu số, phần thập phân.</label>
        <Button disabled={bulkBusy || !verified || !eligible.length || reason.trim().length < 5} onClick={() => void confirmAll()}>{bulkBusy ? 'Đang chốt…' : 'Xác nhận tất cả'}</Button>
        {outcomes.length > 0 && !bulkBusy && <p role="status" className="text-sm">Đã chốt {outcomes.length - failedCount}/{outcomes.length} dòng.{failedCount ? ` ${failedCount} dòng chưa chốt; xem lỗi ở từng dòng.` : ''}</p>}
      </div>}
    </>}
  </section>;
}
