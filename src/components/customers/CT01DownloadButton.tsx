import { useRef, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { loadCT01Buildings } from '@/lib/ct01DownloadService';
import { CT01InputError, downloadCT01Document, type CT01Building, type CT01Customer } from '@/lib/ct01Document';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function CT01DownloadButton({ customer }: { customer: CT01Customer & { id: string } }) {
  const { data: permissions } = useMyPermissions();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [buildings, setBuildings] = useState<CT01Building[]>([]);
  const allowed = canUse(permissions, 'customers', 'print');

  const download = async (selected?: CT01Building) => {
    if (!allowed || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const choices = selected ? [selected] : await loadCT01Buildings(customer.id);
      if (choices.length === 0) {
        toast.error('Khách chưa có tòa nhà từ hợp đồng đang ở. Vui lòng kiểm tra hợp đồng trước khi tải CT01.');
        return;
      }
      if (choices.length > 1) {
        setBuildings(choices);
        return;
      }
      await downloadCT01Document(customer, choices[0]);
      setBuildings([]);
      toast.success('Đã tải tờ khai CT01');
    } catch (error) {
      toast.error(error instanceof CT01InputError ? error.message : 'Không tải được tờ khai CT01. Vui lòng thử lại.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!allowed) return null;
  return <>
    <button type="button" onClick={() => void download()} disabled={busy} aria-busy={busy}
      className="text-sm text-green-600 hover:text-green-700 hover:underline flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
      {busy ? 'Đang tạo tờ khai CT01…' : 'Bản khai nhân khẩu / Mẫu CT01 - Tờ khai thay đổi thông tin cư trú'}
    </button>
    <Dialog open={buildings.length > 1} onOpenChange={open => { if (!open && !busy) setBuildings([]); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chọn tòa nhà kê khai</DialogTitle>
          <DialogDescription>Khách đang có hợp đồng ở nhiều tòa. Chọn địa chỉ đăng ký tạm trú.</DialogDescription>
        </DialogHeader>
        {buildings.map(building => <Button key={building.id} variant="outline" disabled={busy} className="h-auto whitespace-normal text-left justify-start"
          onClick={() => void download(building)}>
          <span>{building.name}<span className="block text-xs font-normal">{[building.street_address, building.ward].filter(Boolean).join(', ')}</span></span>
        </Button>)}
      </DialogContent>
    </Dialog>
  </>;
}
