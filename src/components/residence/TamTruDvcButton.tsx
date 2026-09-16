// Nút "Đăng ký tạm trú trên DVC": dựng gói dữ liệu từ khách + toà + ảnh hồ sơ,
// giao cho extension iHome Tạm trú mở cổng và điền. Người dùng xem lại rồi tự bấm Nộp.
import { useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CT01Tenancy } from '@/lib/ct01DownloadService';
import { createSignedUrlFromStored } from '@/lib/storage';
import { dossierStorageValue, pickDossierFilesForContract, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import { buildTamTruPayload, ngayHanHopLe, TamTruInputError, type TamTruAttachment, type TamTruCustomerInput } from '@/lib/tamTruPayload';
import { detectTamTruExtension, sendTamTruPayload } from '@/lib/tamTruBridge';
import TamTruInstallDialog from './TamTruInstallDialog';

export interface TamTruDvcButtonProps {
  customer: TamTruCustomerInput;
  tenancy: CT01Tenancy | null;
  customerFiles: ResidenceDossierFile[];
  ownershipFiles: ResidenceDossierFile[];
  /** Han doc duoc tren anh hop dong (dd/mm/yyyy). Co thi khai dung ngay do. */
  tempResidentTo?: string | null;
}

export default function TamTruDvcButton({ customer, tenancy, customerFiles, ownershipFiles, tempResidentTo }: TamTruDvcButtonProps) {
  const [durationMonths, setDurationMonths] = useState<12 | 24>(24);
  // Han doc tu giay thang o chon so thang: giay la thu can bo doi chieu.
  const theoHopDong = ngayHanHopLe(tempResidentTo);
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
        durationMonths, tempResidentTo, attachments,
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
      {theoHopDong ? (
        <p className="text-sm text-muted-foreground">Hạn tạm trú <b className="text-foreground">{tempResidentTo}</b> theo hợp đồng</p>
      ) : (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Hạn tạm trú
          <select aria-label="Hạn tạm trú trên DVC" value={durationMonths} disabled={busy}
            onChange={(e) => setDurationMonths(e.target.value === '12' ? 12 : 24)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50">
            <option value="12">12 tháng</option>
            <option value="24">24 tháng</option>
          </select>
        </label>
      )}
      <Button type="button" onClick={() => void send()} disabled={busy || !tenancy} aria-busy={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {busy ? 'Đang chuẩn bị hồ sơ…' : 'Đăng ký tạm trú trên DVC'}
      </Button>
      <TamTruInstallDialog open={installOpen} onOpenChange={setInstallOpen} onRetry={() => void send()} />
    </div>
  );
}
