// Nút "Đăng ký tạm trú trên DVC": dựng gói dữ liệu từ khách + toà + ảnh hồ sơ,
// giao cho extension iHome Tạm trú mở cổng và điền. Người dùng xem lại rồi tự bấm Nộp.
import { useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CT01Tenancy } from '@/lib/ct01DownloadService';
import { createSignedUrlFromStored } from '@/lib/storage';
import { dossierStorageValue, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import { buildTamTruPayload, TamTruInputError, type TamTruAttachment, type TamTruCustomerInput } from '@/lib/tamTruPayload';
import { detectTamTruExtension, sendTamTruPayload } from '@/lib/tamTruBridge';
import TamTruInstallDialog from './TamTruInstallDialog';

export interface TamTruDvcButtonProps {
  customer: TamTruCustomerInput;
  tenancy: CT01Tenancy | null;
  customerFiles: ResidenceDossierFile[];
  ownershipFiles: ResidenceDossierFile[];
}

/** Ảnh CT01/LEASE ưu tiên đúng hợp đồng đang chọn; không có thì lấy mọi ảnh của khách. */
export function pickDossierFiles(customerFiles: ResidenceDossierFile[], ownershipFiles: ResidenceDossierFile[], contractId: string): ResidenceDossierFile[] {
  const perKind = (kind: 'CT01' | 'LEASE') => {
    const ofKind = customerFiles.filter(f => f.kind === kind);
    const ofContract = ofKind.filter(f => f.contract_id === contractId);
    return ofContract.length > 0 ? ofContract : ofKind;
  };
  return [...perKind('CT01'), ...perKind('LEASE'), ...ownershipFiles.filter(f => f.kind === 'OWNERSHIP')];
}

export default function TamTruDvcButton({ customer, tenancy, customerFiles, ownershipFiles }: TamTruDvcButtonProps) {
  const [durationMonths, setDurationMonths] = useState<12 | 24>(24);
  const [busy, setBusy] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const pending = useRef(false);

  const send = async () => {
    if (pending.current || !tenancy) return;
    if (!detectTamTruExtension()) { setInstallOpen(true); return; }
    pending.current = true;
    setBusy(true);
    try {
      const files = pickDossierFiles(customerFiles, ownershipFiles, tenancy.contractId);
      const attachments: TamTruAttachment[] = await Promise.all(files.map(async (f) => ({
        kind: f.kind, fileName: f.file_name || f.object_name.split('/').pop() || 'anh', contentType: f.content_type || 'image/jpeg',
        url: await createSignedUrlFromStored(dossierStorageValue(f)),
      })));
      const payload = buildTamTruPayload({ customer, building: tenancy.building, roomNumber: tenancy.roomNumber, durationMonths, attachments });
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
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Thời hạn tạm trú
        <select aria-label="Thời hạn tạm trú trên DVC" value={durationMonths} disabled={busy}
          onChange={(e) => setDurationMonths(e.target.value === '12' ? 12 : 24)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50">
          <option value="12">12 tháng</option>
          <option value="24">24 tháng</option>
        </select>
      </label>
      <Button type="button" onClick={() => void send()} disabled={busy || !tenancy} aria-busy={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {busy ? 'Đang chuẩn bị hồ sơ…' : 'Đăng ký tạm trú trên DVC'}
      </Button>
      <TamTruInstallDialog open={installOpen} onOpenChange={setInstallOpen} onRetry={() => void send()} />
    </div>
  );
}
