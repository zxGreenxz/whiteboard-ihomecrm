// Hạn ghi trên ảnh hợp đồng ở nhờ: hiện ngay dưới hàng ảnh để chủ đối chiếu với
// tờ giấy trước khi bấm sang Cổng DVC, và sửa tay được khi ảnh mờ đọc không ra.
import { useState } from 'react';
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
  onSua: (from: string, to: string) => void;
}

const isoToVn = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const vnToIso = (vn: string) => { const [d, m, y] = vn.split('/'); return `${y}-${m}-${d}`; };

export default function LeaseTermBadge({ trangThai, han, coAnh, canEdit, onDocLai, onSua }: LeaseTermBadgeProps) {
  const [suaMo, setSuaMo] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (!coAnh) return null;

  const moSua = () => {
    setFrom(han ? vnToIso(han.from) : '');
    setTo(han ? vnToIso(han.to) : '');
    setSuaMo(true);
  };
  const luu = () => {
    const hopLe = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return !!ngayHopLe(d, m, y); };
    if (!hopLe(from) || !hopLe(to) || vnToIso(isoToVn(to)) <= vnToIso(isoToVn(from))) return;
    onSua(isoToVn(from), isoToVn(to));
    setSuaMo(false);
  };

  if (suaMo) {
    return (
      <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-2 text-xs" aria-label="Sửa thời hạn hợp đồng">
        <label className="flex flex-col gap-1">Từ ngày
          <input type="date" aria-label="Hợp đồng từ ngày" value={from} onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1">Đến ngày
          <input type="date" aria-label="Hợp đồng đến ngày" value={to} onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
        </label>
        <Button type="button" size="sm" onClick={luu} disabled={!from || !to}>Lưu</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setSuaMo(false)}>Huỷ</Button>
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
