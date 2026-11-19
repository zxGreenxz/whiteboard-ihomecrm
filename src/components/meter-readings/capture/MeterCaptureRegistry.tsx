import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { MeterCaptureMeter } from '@/lib/meter-capture/types';
import { saveMeterCaptureProfile, revokeMeterCaptureQr, rotateMeterCaptureQr } from '@/lib/meter-capture/service';
import { createMeterQrLabel, printMeterQrLabel } from '@/lib/meter-capture/qrLabel';

export function MeterCaptureRegistry({ orgId, meters, onChanged }: { orgId: string; meters: MeterCaptureMeter[]; onChanged: () => Promise<void> }) {
  const [meterId, setMeterId] = useState('');
  const meter = meters.find(item => item.id === meterId);
  const [serial, setSerial] = useState('');
  const [displayKind, setDisplayKind] = useState<'DIGITAL' | 'MECHANICAL'>('DIGITAL');
  const [decimalPlaces, setDecimalPlaces] = useState(0);
  const [registerCode, setRegisterCode] = useState('1.8.0');
  const [reference, setReference] = useState<File | null>(null);
  const [verified, setVerified] = useState(false);
  const [reason, setReason] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setSerial(meter?.profile?.serial ?? ''); setDisplayKind(meter?.profile?.displayKind ?? 'DIGITAL');
    setDecimalPlaces(meter?.profile?.decimalPlaces ?? 0); setRegisterCode(meter?.profile?.registerCode ?? '1.8.0');
    setVerified(false); setReference(null); setLabel(''); setError(''); setNotice('');
  }, [meterId]);
  const makeLabel = async (qrText: string, labelSerial = meter?.profile?.serial ?? serial) => {
    if (meter) setLabel(await createMeterQrLabel(qrText, [meter.buildingName, `Phòng ${meter.roomName ?? 'chưa gán'}`, `${meter.code} · S/N ${labelSerial}`]));
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa cập nhật được tem đồng hồ.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!meter || !reference || !verified || !serial.trim() || !registerCode.trim()) throw new Error('Cần serial, thanh ghi, ảnh đăng ký và xác nhận đúng phòng thực tế.');
    if (!reference.type.startsWith('image/') || reference.size > 20 * 1024 * 1024) throw new Error('Ảnh đăng ký tối đa 20 MB.');
    const result = await saveMeterCaptureProfile({ orgId, meterId: meter.id, serial: serial.trim(), displayKind, decimalPlaces, registerCode: registerCode.trim(), referenceFile: reference, verified: true, expectedVersion: meter.profile?.version ?? 0 });
    await makeLabel(result.qrText, serial.trim()); setNotice('Đã đăng ký. In tem và đối chiếu tên tòa/phòng trước khi dán.');
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Mỗi đồng hồ vật lý có một tem riêng. Khi thay đồng hồ, tạo công tơ mới ở danh mục rồi đăng ký; thu hồi tem của công tơ cũ để giữ đúng lịch sử.</p>
    <Label htmlFor="registry-meter">Đồng hồ cần đăng ký / quản lý tem</Label>
    <select id="registry-meter" value={meterId} onChange={event => setMeterId(event.target.value)} className="h-10 w-full rounded border bg-background px-2"><option value="">Chọn tòa · phòng · đồng hồ</option>{meters.map(item => <option key={item.id} value={item.id}>{item.buildingName} · {item.roomName} · {item.code}{item.profile ? ' (đã đăng ký)' : ''}</option>)}</select>
    {meter && <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1"><Label htmlFor="meter-serial">Serial trên đồng hồ</Label><Input id="meter-serial" value={serial} onChange={event => setSerial(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="meter-kind">Loại mặt số</Label><select id="meter-kind" className="h-10 w-full rounded border bg-background px-2" value={displayKind} onChange={event => { const kind = event.target.value === 'MECHANICAL' ? 'MECHANICAL' : 'DIGITAL'; setDisplayKind(kind); if (registerCode === '1.8.0' || registerCode === 'total') setRegisterCode(kind === 'MECHANICAL' ? 'total' : '1.8.0'); }}><option value="DIGITAL">Điện tử / LCD</option><option value="MECHANICAL">Dãy số cơ</option></select></div>
        <div className="space-y-1"><Label htmlFor="meter-decimal">Chữ số sau dấu thập phân</Label><Input id="meter-decimal" type="number" min={0} max={2} step={1} value={decimalPlaces} onChange={event => setDecimalPlaces(Number(event.target.value))} /></div>
        <div className="space-y-1"><Label htmlFor="meter-register">Thanh ghi điện năng cần lấy</Label><Input id="meter-register" value={registerCode} onChange={event => setRegisterCode(event.target.value)} placeholder="Ví dụ 1.8.0; cơ: total" /></div>
      </div>
      <p className="text-xs text-muted-foreground">Kiểm tra mã thực tế trên mặt đồng hồ; 1.8.0 là ví dụ, không chọn chỉ vì màn hình có kWh. Với đồng hồ cơ một thanh ghi, dùng total.</p>
      <Label htmlFor="meter-reference">Ảnh đăng ký thấy mặt số, serial và vị trí (tối đa 20 MB)</Label>
      <Input id="meter-reference" type="file" accept="image/*" capture="environment" onChange={event => { setReference(event.target.files?.[0] ?? null); setVerified(false); }} />
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />Tôi đã đối chiếu serial và vị trí thực tế: {meter.buildingName}, phòng {meter.roomName}, công tơ {meter.code}.</label>
      <Button disabled={busy || !reference || !verified} onClick={() => void run(save)}>{busy ? 'Đang lưu…' : meter.profile ? 'Lưu cấu hình và ảnh mới' : 'Đăng ký và tạo tem'}</Button>
      {meter.profile && <div className="space-y-2 border-t pt-3">
        <Label htmlFor="meter-qr-reason">Lý do thu hồi / cấp lại tem</Label><Input id="meter-qr-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder="Ví dụ tem cũ hỏng, thay đồng hồ…" />
        <div className="flex flex-wrap gap-2">
          {meter.qrText && <Button variant="outline" disabled={busy} onClick={() => void run(() => makeLabel(meter.qrText!))}>Xem tem hiện tại</Button>}
          <Button variant="outline" disabled={busy || reason.trim().length < 5} onClick={() => void run(async () => { const result = await rotateMeterCaptureQr(orgId, meter.id, meter.profile!.version, reason.trim()); await makeLabel(result.qrText); setNotice('Đã cấp tem mới và thu hồi tem cũ.'); })}>Cấp lại tem</Button>
          <Button variant="destructive" disabled={busy || !meter.qrText || reason.trim().length < 5} onClick={() => void run(async () => { await revokeMeterCaptureQr(orgId, meter.id, meter.profile!.version, reason.trim()); setLabel(''); setNotice('Đã thu hồi tem. Không dùng tem cũ để chốt mới.'); })}>Thu hồi tem</Button>
        </div>
      </div>}
      {label && <div className="space-y-2"><img src={label} alt="Tem QR có tên tòa, phòng và mã đồng hồ" className="w-56 border" /><div className="flex gap-2"><Button variant="outline" onClick={() => { try { printMeterQrLabel(label); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa mở được cửa sổ in.'); } }}>In tem</Button><Button variant="outline" asChild><a href={label} download={`tem-dong-ho-${meter.code}.png`}>Tải tem PNG</a></Button></div></div>}
    </>}
    {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
