// Nút "Tải CT01+BBTL" của khối Huỷ đăng ký tạm trú: một tệp Word gồm tờ khai CT01
// ghi "Hủy tạm trú tại …" và biên bản thanh lý hợp đồng thuê, in ra cho hai bên ký.
// Ngày thanh lý do hệ thống quyết (ngày kết thúc của hợp đồng), không có ô nhập.
import { useRef, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { loadBuildingLegalOwner } from '@/lib/buildingLegalOwner';
import { CT01InputError, downloadCT01HuyDocument, type CT01Customer } from '@/lib/ct01Document';
import type { CT01XoaTenancy } from '@/lib/ct01DownloadService';
import { friendlyError } from '@/lib/friendlyError';

export interface CT01HuyDownloadButtonProps {
  customer: CT01Customer & { id: string };
  tenancy: CT01XoaTenancy;
}

export default function CT01HuyDownloadButton({ customer, tenancy }: CT01HuyDownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const download = async () => {
    if (pending.current) return;
    const requestedAt = new Date();
    pending.current = true;
    setBusy(true);
    try {
      const owner = await loadBuildingLegalOwner(tenancy.building.id);
      if (!owner) throw new CT01InputError('Tòa nhà chưa có thông tin người đứng tên chủ quyền. Vui lòng bổ sung trong chỉnh sửa tòa nhà.');
      await downloadCT01HuyDocument(customer, tenancy.building,
        { roomNumber: tenancy.roomNumber, owner, endDate: tenancy.endDate }, requestedAt);
      toast.success('Đã chuẩn bị tệp CT01 huỷ tạm trú và biên bản thanh lý để tải xuống.');
    } catch (error) {
      toast.error(error instanceof CT01InputError ? error.message
        : friendlyError(error, 'Chưa chuẩn bị được giấy huỷ tạm trú', { operation: 'xuất CT01 huỷ tạm trú' }).description);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <button type="button" onClick={() => void download()} disabled={busy} aria-busy={busy}
      title="Tải tờ khai CT01 huỷ tạm trú và biên bản thanh lý (Word) để in ra ký"
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-green-700 hover:bg-accent disabled:opacity-50 disabled:cursor-wait">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
      {busy ? 'Đang tạo…' : 'Tải CT01+BBTL'}
    </button>
  );
}
