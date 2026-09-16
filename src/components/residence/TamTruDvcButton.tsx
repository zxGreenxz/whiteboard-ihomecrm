// Nút "Đăng ký tạm trú trên DVC": dựng gói dữ liệu từ khách + toà + ảnh hồ sơ,
// giao cho extension iHome Tạm trú mở cổng và điền. Người dùng xem lại rồi tự bấm Nộp.
import { useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CT01Tenancy } from '@/lib/ct01DownloadService';
import { createSignedUrlFromStored } from '@/lib/storage';
import { dossierStorageValue, pickDossierFilesForContract, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import { buildTamTruPayload, TamTruInputError, type TamTruAttachment, type TamTruCustomerInput } from '@/lib/tamTruPayload';
import { detectTamTruExtension, sendTamTruPayload } from '@/lib/tamTruBridge';
import TamTruInstallDialog from './TamTruInstallDialog';

export interface TamTruDvcButtonProps {
  customer: TamTruCustomerInput;
  tenancy: CT01Tenancy | null;
  customerFiles: ResidenceDossierFile[];
  ownershipFiles: ResidenceDossierFile[];
  /** Ngày ký hợp đồng ở nhờ (dd/mm/yyyy) — ngày bắt đầu tạm trú khai trên cổng. */
  tempResidentFrom?: string | null;
  /** Hạn tạm trú (dd/mm/yyyy) do khối Hồ sơ tạm trú tính từ giấy hoặc số tháng. */
  tempResidentTo?: string | null;
  /** Số tháng dự phòng khi không có hạn nào dùng được. */
  durationMonths?: 12 | 24;
}

export default function TamTruDvcButton({
  customer, tenancy, customerFiles, ownershipFiles, tempResidentFrom, tempResidentTo, durationMonths = 24,
}: TamTruDvcButtonProps) {
  const [busy, setBusy] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const pending = useRef(false);

  const send = async () => {
    if (pending.current || !tenancy) return;
    if (!detectTamTruExtension()) { setInstallOpen(true); return; }
    pending.current = true;
    setBusy(true);
    try {
      const files = pickDossierFilesForContract(customerFiles, ownershipFiles, tenancy.contractId);
      const attachments: TamTruAttachment[] = await Promise.all(files.map(async (f) => ({
        kind: f.kind, fileName: f.file_name || f.object_name.split('/').pop() || 'anh', contentType: f.content_type || 'image/jpeg',
        url: await createSignedUrlFromStored(dossierStorageValue(f)),
      })));
      const payload = buildTamTruPayload({
        customer, building: tenancy.building, roomNumber: tenancy.roomNumber,
        buildingId: tenancy.building.id, organizationId: tenancy.building.organization_id ?? undefined,
        contractId: tenancy.contractId,
        durationMonths, tempResidentFrom, tempResidentTo, attachments,
      });
      await sendTamTruPayload(payload);
      setInstallOpen(false);
      toast.success('Đã mở Cổng DVC ở tab mới. Đăng nhập VNeID nếu cần, bấm "Điền ngay", kiểm tra rồi nộp.');
    } catch (error) {
      toast.error(error instanceof TamTruInputError || error instanceof Error
        ? error.message
        : 'Không gửi được hồ sơ sang Cổng DVC. Vui lòng thử lại.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" onClick={() => void send()} disabled={busy || !tenancy} aria-busy={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {busy ? 'Đang chuẩn bị hồ sơ…' : 'Đăng ký tạm trú trên DVC'}
      </Button>
      <TamTruInstallDialog open={installOpen} onOpenChange={setInstallOpen} onRetry={() => void send()} />
    </div>
  );
}
