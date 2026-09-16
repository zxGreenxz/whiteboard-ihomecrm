import { useRef, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { loadCT01Tenancies, type CT01Tenancy } from '@/lib/ct01DownloadService';
import { loadBuildingLegalOwner } from '@/lib/buildingLegalOwner';
import { CT01InputError, downloadCT01Document, type CT01Customer } from '@/lib/ct01Document';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface CT01DownloadButtonProps {
  customer: CT01Customer & { id: string };
  /** Số tháng do khối Hồ sơ tạm trú giữ; truyền vào thì nút không hiện ô chọn riêng. */
  durationMonths?: 12 | 24;
  /** Nhãn ngắn để đứng chung hàng với nút Đăng ký tạm trú. */
  gonNhe?: boolean;
}

export default function CT01DownloadButton({ customer, durationMonths: durationProp, gonNhe }: CT01DownloadButtonProps) {
  const { data: permissions } = useMyPermissions();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [tenancies, setTenancies] = useState<CT01Tenancy[]>([]);
  const [durationRieng, setDurationMonths] = useState<12 | 24>(24);
  const durationMonths = durationProp ?? durationRieng;
  const allowed = canUse(permissions, 'customers', 'print');

  const download = async (selected?: CT01Tenancy) => {
    if (!allowed || pending.current) return;
    const requestedAt = new Date();
    pending.current = true;
    setBusy(true);
    try {
      const choices = selected ? [selected] : await loadCT01Tenancies(customer.id);
      if (choices.length === 0) {
        toast.error('Khách chưa có tòa nhà từ hợp đồng đang ở. Vui lòng kiểm tra hợp đồng trước khi tải CT01.');
        return;
      }
      if (choices.length > 1) {
        setTenancies(choices);
        return;
      }
      const tenancy = choices[0];
      if (!tenancy) return;
      const owner = await loadBuildingLegalOwner(tenancy.building.id);
      if (!owner) throw new CT01InputError('Tòa nhà chưa có thông tin người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà.');
      await downloadCT01Document(customer, tenancy.building, { durationMonths, roomNumber: tenancy.roomNumber, owner }, requestedAt);
      setTenancies([]);
      toast.success('Đã tải CT01 và hợp đồng thuê nhà');
    } catch (error) {
      toast.error(error instanceof CT01InputError ? error.message : 'Không tải được tờ khai CT01. Vui lòng thử lại.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!allowed) return null;
  return <>
    <div className="flex flex-wrap items-center gap-3">
      {durationProp === undefined && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Thời hạn tạm trú
          <select aria-label="Thời hạn tạm trú" value={durationMonths} disabled={busy}
            onChange={event => setDurationMonths(event.target.value === '12' ? 12 : 24)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50">
            <option value="12">12 tháng</option><option value="24">24 tháng</option>
          </select>
        </label>
      )}
    <button type="button" onClick={() => void download()} disabled={busy} aria-busy={busy}
      title="Tải tờ khai CT01 và hợp đồng cho thuê, mượn, ở nhờ (Word) để in ra ký"
      className={gonNhe
        ? 'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-green-700 hover:bg-accent disabled:opacity-50 disabled:cursor-wait'
        : 'text-sm text-green-600 hover:text-green-700 hover:underline flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait'}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
      {busy ? (gonNhe ? 'Đang tạo…' : 'Đang tạo tờ khai CT01…')
        : gonNhe ? 'Tải CT01+HĐT' : 'Bản khai nhân khẩu / Mẫu CT01 - Tờ khai thay đổi thông tin cư trú'}
    </button>
    </div>
    <Dialog open={tenancies.length > 1} onOpenChange={open => { if (!open && !busy) setTenancies([]); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chọn phòng kê khai</DialogTitle>
          <DialogDescription>Khách đang có hợp đồng ở nhiều phòng. Chọn phòng để điền CT01 và hợp đồng thuê nhà.</DialogDescription>
        </DialogHeader>
        {tenancies.map(tenancy => <Button key={tenancy.roomId} variant="outline" disabled={busy} className="h-auto whitespace-normal text-left justify-start"
          onClick={() => void download(tenancy)}>
          <span>{tenancy.building.name} · Phòng {tenancy.roomNumber}<span className="block text-xs font-normal">{tenancy.building.street_address?.trim()}</span></span>
        </Button>)}
      </DialogContent>
    </Dialog>
  </>;
}
