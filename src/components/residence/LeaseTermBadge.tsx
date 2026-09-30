// Hạn ghi trên ảnh hợp đồng ở nhờ: hiện ngay dưới hàng ảnh để chủ đối chiếu với
// tờ giấy trước khi bấm sang Cổng DVC, và sửa tay được khi ảnh mờ đọc không ra.
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useRef, useState } from 'react';
import { CalendarCheck, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { HanHopDong } from '@/lib/residenceLeaseTerm';
import { ngayHopLe } from '@/lib/residenceLeaseTerm';
import type { TrangThaiDocHan } from '@/hooks/useLeaseTermOcr';

export interface LeaseTermBadgeProps {
  trangThai: TrangThaiDocHan;
  han: HanHopDong | null;
  coAnh: boolean;
  canEdit: boolean;
  onDocLai: () => void;
  onSua: (from: string, to: string) => Promise<void>;
}

const isoToVn = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const vnToIso = (vn: string) => { const [d, m, y] = vn.split('/'); return `${y}-${m}-${d}`; };

export default function LeaseTermBadge({ trangThai, han, coAnh, canEdit, onDocLai, onSua }: LeaseTermBadgeProps) {
  const [suaMo, setSuaMo] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [blocked,setBlocked] = useState(false);
  const busy = useRef(false);
  const fromInput=useRef<HTMLInputElement>(null);
  const toInput=useRef<HTMLInputElement>(null);
  const [invalidField,setInvalidField]=useState<'from'|'to'|null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!coAnh) return null;

  const moSua = () => {
    if (!saveError) {
      setFrom(han ? vnToIso(han.from) : '');
      setTo(han ? vnToIso(han.to) : '');
    }
    setSuaMo(true);
  };
  const luu = async () => {
    if (busy.current || saving || blocked) return;
    const hopLe = (iso: string) => {
      const [y, m, d] = iso.split('-');
      return !!(y && m && d && ngayHopLe(Number(d), Number(m), Number(y)));
    };
    if (!hopLe(from)) {setSaveError('Nhập ngày bắt đầu hợp lệ.');setInvalidField('from');fromInput.current?.focus();return;}
    if (!hopLe(to) || to <= from) {setSaveError('Ngày kết thúc phải hợp lệ và sau ngày bắt đầu.');setInvalidField('to');toInput.current?.focus();return;}
    setInvalidField(null);
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSua(isoToVn(from), isoToVn(to));
      setSuaMo(false);
    } catch (error) {
      setSaveError(`Chưa lưu được thời hạn hợp đồng. ${recordWriteMessage(error, 'lưu thời hạn hợp đồng')}`);
      setBlocked(recordWriteBlocked(error));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  if (suaMo) {
    return (
      <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-2 text-xs" aria-label="Sửa thời hạn hợp đồng">
        <label className="flex flex-col gap-1">Từ ngày
          <input type="date" ref={fromInput} aria-invalid={invalidField === 'from'} aria-label="Hợp đồng từ ngày" disabled={saving || blocked} value={from} onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1">Đến ngày
          <input type="date" ref={toInput} aria-invalid={invalidField === 'to'} aria-label="Hợp đồng đến ngày" disabled={saving || blocked} value={to} onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
        </label>
        {saveError && <span role="alert" className="basis-full text-destructive">{saveError}</span>}
        <Button type="button" size="sm" onClick={() => { void luu(); }} disabled={!from || !to || saving || blocked}>{saving ? 'Đang lưu...' : 'Lưu'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setSuaMo(false)} disabled={saving}>Huỷ</Button>
      </div>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Thời hạn trên hợp đồng">
      {trangThai === 'dang-doc' && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang đọc ngày trên ảnh hợp đồng…</>}
      {trangThai === 'xong' && han && (
        <><CalendarCheck className="h-3.5 w-3.5 text-green-600" />
          <span>Hợp đồng ghi: <b>{han.from}</b> đến <b>{han.to}</b>. Hạn tạm trú sẽ khai theo ngày này.</span></>
      )}
      {(trangThai === 'khong-doc-duoc' || trangThai === 'loi') && (
        <span className="text-muted-foreground">
          {trangThai === 'loi' ? 'Chưa đọc được ảnh hợp đồng.' : 'Không đọc được thời hạn trên ảnh hợp đồng.'} Hạn tạm trú sẽ tính theo số tháng chọn bên dưới.
        </span>
      )}
      {canEdit && trangThai !== 'dang-doc' && (
        <>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={onDocLai}>
            <RefreshCw className="h-3 w-3" /> Đọc lại
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={moSua}>
            <Pencil className="h-3 w-3" /> Sửa ngày
          </Button>
        </>
      )}
    </p>
  );
}
