import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MeterCamera } from './MeterCamera';
import { MeterCaptureReview } from './MeterCaptureReview';
import { MeterCaptureRegistry } from './MeterCaptureRegistry';
import { useMeterCaptureDesk } from './useMeterCaptureDesk';
import { inspectCaptureMedia, sha256Media } from '@/lib/meter-capture/media';
import { savePendingCapture } from '@/lib/meter-capture/offlineQueue';
import { resolveCaptureQr } from '@/lib/meter-capture/service';
import { vnTodayISO } from '@/lib/vnDate';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useAuth } from '@/hooks/useAuth';

function CaptureDesk({ month, setMonth, desk }: { month: string; setMonth: (month: string) => void; desk: ReturnType<typeof useMeterCaptureDesk> }) {
  const [readingDate, setReadingDate] = useState(vnTodayISO());
  const [purpose, setPurpose] = useState<'MONTHLY' | 'MOVE_OUT'>('MONTHLY');
  const [meterId, setMeterId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [details, setDetails] = useState<{ qrText: string | null; durationSeconds?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [notice, setNotice] = useState('');
  const meter = desk.meters.find(item => item.id === meterId);
  const buildings = [...new Map(desk.meters.map(item => [item.buildingId, item.buildingName])).entries()];
  const filtered = desk.meters.filter(item => !buildingId || item.buildingId === buildingId);

  const receiveFile = async (nextFile: File, recordedDurationSeconds?: number) => {
    setBusy(true); desk.setError(''); setNotice(''); setVerified(false); setFile(null); setDetails(null); setMeterId('');
    try {
      const inspected = await inspectCaptureMedia(nextFile, recordedDurationSeconds);
      if (inspected.qrText) {
        const matched = desk.online && desk.owner
          ? await resolveCaptureQr(desk.owner.orgId, inspected.qrText)
          : desk.meters.find(item => item.qrText === inspected.qrText);
        if (!matched) throw new Error('QR chưa có trong danh mục đã tải. Kết nối mạng để xác minh, hoặc đăng ký đúng tem.');
        setMeterId(matched.id); setBuildingId(matched.buildingId);
      }
      setFile(nextFile); setDetails(inspected);
    } catch (cause) { desk.setError(cause instanceof Error ? cause.message : 'Chưa đọc được tệp. Chọn hoặc quay lại.'); }
    finally { setBusy(false); }
  };
  const keep = async () => {
    if (!file || !details || !meter || !desk.owner || !verified) return;
    setBusy(true); desk.setError(''); setNotice('');
    try {
      if (!meter.profile) throw new Error('Đăng ký cấu hình và ảnh tham chiếu cho đồng hồ trước khi ghi bằng ảnh.');
      if (!month || !readingDate) throw new Error('Chọn kỳ tháng và ngày chốt.');
      await savePendingCapture({ ...desk.owner, clientId: crypto.randomUUID(), file, fileName: file.name,
        sha256: await sha256Media(file), durationSeconds: details.durationSeconds, meterId: meter.id,
        qrText: details.qrText, purpose, readingDate, month, capturedAt: new Date().toISOString() });
      setNotice('Đã giữ ảnh/clip trên máy. Bạn có thể chụp đồng hồ tiếp theo.');
      setFile(null); setDetails(null); setVerified(false);
      await desk.refresh();
      void desk.sync();
    } catch (cause) { desk.setError(cause instanceof Error ? cause.message : 'Chưa giữ được ảnh trên máy. Kiểm tra dung lượng và thử lại.'); }
    finally { setBusy(false); }
  };
  if (!desk.owner) return <p role="alert">Cần đăng nhập và chọn tổ chức để ghi chỉ số.</p>;
  return <div className="space-y-4">
    <p className="text-sm">{desk.online ? 'Đang có mạng' : 'Đang ngoại tuyến'} · {desk.pending.length} ảnh/clip đang giữ trên máy{desk.busy ? ' · Đang đồng bộ…' : ''}</p>
    <p className="text-xs text-muted-foreground">Mở màn này khi có mạng để tải danh mục trước chuyến đi. Giữ màn Ghi chỉ số mở để tải tiếp, có thể đóng hộp chụp. Ảnh chưa tải xong vẫn ở thiết bị này. Ảnh/clip chỉ dùng nội bộ.</p>
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1"><Label htmlFor="capture-month">Kỳ chốt</Label><Input id="capture-month" type="month" value={month} onChange={event => setMonth(event.target.value)} disabled={busy} /></div>
      <div className="space-y-1"><Label htmlFor="capture-building">Tòa</Label><select id="capture-building" className="h-10 w-full rounded border bg-background px-2" value={buildingId} onChange={event => setBuildingId(event.target.value)}><option value="">Tất cả tòa</option>{buildings.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
    </div>
    <Tabs defaultValue="capture">
      <TabsList className="w-full"><TabsTrigger value="capture">Chụp / quay</TabsTrigger><TabsTrigger value="review">Đối chiếu ({desk.captures.length})</TabsTrigger><TabsTrigger value="registry">Tem QR</TabsTrigger></TabsList>
      <TabsContent value="capture" className="space-y-4">
        <div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label htmlFor="capture-purpose">Mục đích</Label><select id="capture-purpose" className="h-10 w-full rounded border bg-background px-2" value={purpose} onChange={event => setPurpose(event.target.value === 'MOVE_OUT' ? 'MOVE_OUT' : 'MONTHLY')}><option value="MONTHLY">Chốt kỳ tháng</option><option value="MOVE_OUT">Chốt thanh lý</option></select></div><div className="space-y-1"><Label htmlFor="capture-date">Ngày chốt</Label><Input id="capture-date" type="date" value={readingDate} onChange={event => setReadingDate(event.target.value)} /></div></div>
        {!desk.catalogReady && <p role="status" className="text-sm">Chưa tải xong danh mục đồng hồ; cần kết nối mạng trước khi chụp.</p>}
        <MeterCamera onFile={(next, duration) => void receiveFile(next, duration)} disabled={busy || !desk.catalogReady} />
        {busy && <p role="status" className="text-sm">Đang kiểm tra / giữ tệp…</p>}
        {file && <div className="space-y-3 rounded border p-3">
          <p className="text-sm">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB{details?.durationSeconds ? ` · ${Math.ceil(details.durationSeconds)} giây` : ''}</p>
          <Label htmlFor="capture-meter">{details?.qrText ? 'Đồng hồ xác định từ QR' : 'Chưa đọc được QR — chọn đồng hồ để đối chiếu thủ công'}</Label>
          <select id="capture-meter" className="h-10 w-full rounded border bg-background px-2" value={meterId} disabled={!!details?.qrText} onChange={event => { setMeterId(event.target.value); setVerified(false); }}><option value="">Chọn đúng đồng hồ</option>{filtered.map(item => <option key={item.id} value={item.id}>{item.buildingName} · {item.roomName} · {item.code}</option>)}</select>
          {!details?.qrText && <p className="text-sm text-amber-700">Lượt này cần người có quyền xác minh danh tính và nhập lý do khi chốt. Ưu tiên chụp/quay lại có QR rõ.</p>}
          {meter && <p className="text-sm">Serial: {meter.profile?.serial ?? 'Chưa đăng ký'} · Thanh ghi: {meter.profile?.registerCode ?? 'Chưa cấu hình'}</p>}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />Đã kiểm tra đúng tòa/phòng, serial và một đồng hồ xuyên suốt ảnh/clip.</label>
          <Button disabled={busy || !verified || !meter?.profile} onClick={() => void keep()}>Giữ ảnh/clip và gửi đọc số</Button>
        </div>}
        <div className="space-y-2"><div className="flex justify-between gap-2"><p className="text-sm font-medium">Tiến độ kỳ {month}</p><Button variant="outline" size="sm" disabled={!desk.online || desk.busy} onClick={() => void desk.sync()}>Đồng bộ lại</Button></div>
          {filtered.map(item => {
            const local = desk.pending.some(row => row.meterId === item.id && row.month === month);
            const rows = desk.captures.filter(row => row.meterId === item.id);
            const label = local ? 'Đang giữ trên máy' : rows.some(row => row.status === 'CONFIRMED') ? 'Đã chốt' : rows.some(row => ['REVIEW', 'FAILED'].includes(row.status)) ? 'Cần đối chiếu' : rows.length ? 'Đang đọc' : 'Chưa chụp';
            return <div key={item.id} className="flex justify-between gap-2 border-b py-1 text-sm"><span>{item.roomName ?? 'Chưa gán phòng'} · {item.code}</span><span>{label}</span></div>;
          })}
          {desk.pending.map(item => <p key={item.clientId} className="text-xs text-muted-foreground">Đang giữ: {item.fileName} · {item.month} · {item.readingDate}</p>)}
        </div>
      </TabsContent>
      <TabsContent value="review" className="space-y-3">
        <p className="text-sm text-muted-foreground">Server và AI đọc độc lập. Mọi lượt đều cần người có quyền kiểm tra chứng cứ và xác nhận trước khi tính tiền.</p>
        <Button variant="outline" size="sm" onClick={() => void desk.refresh()}>Tải lại kết quả</Button>
        {desk.captures.filter(row => !buildingId || desk.meters.some(item => item.id === row.meterId && item.buildingId === buildingId)).map(row => <MeterCaptureReview key={`${row.id}:${row.version}`} capture={row} meter={desk.meters.find(item => item.id === row.meterId)} onChanged={desk.changed} />)}
        {!desk.captures.length && <p className="text-sm text-muted-foreground">Chưa có lượt đọc trên server trong kỳ này.</p>}
      </TabsContent>
      <TabsContent value="registry">{desk.online && desk.catalogReady ? <MeterCaptureRegistry orgId={desk.owner.orgId} meters={filtered} onChanged={desk.refresh} /> : <p>Cần tải được danh mục đồng hồ và bộ đọc đã được bật trước khi đăng ký tem.</p>}</TabsContent>
    </Tabs>
    {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
    {desk.error && <p role="alert" className="text-sm text-destructive">{desk.error}</p>}
  </div>;
}

export default function MeterCaptureDialog({ open, onOpenChange, month }: { open: boolean; onOpenChange: (open: boolean) => void; month: string }) {
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const [captureMonth, setCaptureMonth] = useState(month || vnTodayISO().slice(0, 7));
  // This host remains mounted after closing the dialog; original uploads continue
  // while the Ghi chỉ số page is open. Camera components still unmount on close.
  const desk = useMeterCaptureDesk(captureMonth);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-3xl max-h-[92dvh] overflow-y-auto"><DialogHeader><DialogTitle>Ghi điện bằng QR, ảnh / clip</DialogTitle><DialogDescription>Nhận diện đúng đồng hồ, đối chiếu số và giữ chứng cứ nội bộ.</DialogDescription></DialogHeader>{open && <CaptureDesk key={`${user?.id ?? ''}:${selectedOrganizationId ?? ''}`} month={captureMonth} setMonth={setCaptureMonth} desk={desk} />}</DialogContent></Dialog>;
}
