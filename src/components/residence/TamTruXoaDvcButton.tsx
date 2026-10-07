// Nút "Huỷ đăng ký tạm trú trên DVC": dựng gói Xóa đăng ký tạm trú (TAMTRU_06) từ
// khách + toà + ảnh CT01 huỷ và biên bản thanh lý, giao cho extension iHome Tạm trú
// mở cổng và điền. Người dùng tự đăng nhập, xem lại rồi tự bấm Nộp.
import { useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CT01XoaTenancy } from '@/lib/ct01DownloadService';
import { createSignedUrlFromStored } from '@/lib/storage';
import { dossierStorageValue, pickDeregistrationFiles, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import { buildTamTruXoaPayload, TamTruInputError, type TamTruAttachment, type TamTruCustomerInput } from '@/lib/tamTruPayload';
import { banExtensionDu, detectTamTruExtension, sendTamTruPayload, TAM_TRU_EXT_XOA_TU_BAN } from '@/lib/tamTruBridge';
import TamTruInstallDialog from './TamTruInstallDialog';
import { friendlyError } from '@/lib/friendlyError';

export interface TamTruXoaDvcButtonProps {
  customer: TamTruCustomerInput;
  tenancy: CT01XoaTenancy | null;
  customerFiles: ResidenceDossierFile[];
}

const TEN_NUT = 'Huỷ đăng ký tạm trú trên DVC';

export default function TamTruXoaDvcButton({ customer, tenancy, customerFiles }: TamTruXoaDvcButtonProps) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ banCu: string | null } | null>(null);
  const pending = useRef(false);

  const send = async () => {
    if (pending.current || !tenancy) return;
    const ban = detectTamTruExtension();
    // Bản cũ chỉ biết đăng ký: gửi gói xoá cho nó thì nó từ chối, nên chặn từ đây và chỉ cách nạp lại.
    if (!banExtensionDu(ban, TAM_TRU_EXT_XOA_TU_BAN)) { setDialog({ banCu: ban }); return; }
    pending.current = true;
    setBusy(true);
    try {
      const files = pickDeregistrationFiles(customerFiles, tenancy.contractId);
      const attachments: TamTruAttachment[] = await Promise.all(files.map(async (f) => ({
        kind: f.kind, fileName: f.file_name || f.object_name.split('/').pop() || 'anh', contentType: f.content_type || 'image/jpeg',
        url: await createSignedUrlFromStored(dossierStorageValue(f)),
      })));
      const payload = buildTamTruXoaPayload({
        customer, building: tenancy.building, roomNumber: tenancy.roomNumber,
        buildingId: tenancy.building.id, organizationId: tenancy.building.organization_id ?? undefined,
        contractId: tenancy.contractId, attachments,
      });
      await sendTamTruPayload(payload);
      setDialog(null);
      toast.success('Đã mở trang Xoá đăng ký tạm trú ở tab mới. Đăng nhập VNeID nếu cần, bấm "Điền ngay", kiểm tra rồi nộp.');
    } catch (error) {
      if (error instanceof TamTruInputError ||
          (error instanceof Error && /^Extension iHome Tạm trú không phản hồi\.( Kiểm tra extension đã bật chưa rồi thử lại\.)?$/.test(error.message))) {
        toast.error(error.message);
      } else {
        const feedback = friendlyError(error, 'Chưa gửi được hồ sơ huỷ tạm trú sang Cổng DVC', { operation: 'gửi hồ sơ huỷ tạm trú sang Cổng DVC' });
        toast.error(feedback.title, { description: feedback.description });
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" onClick={() => void send()} disabled={busy || !tenancy} aria-busy={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {busy ? 'Đang chuẩn bị hồ sơ…' : TEN_NUT}
      </Button>
      <TamTruInstallDialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}
        onRetry={() => void send()} banCu={dialog?.banCu} tenNut={TEN_NUT} />
    </div>
  );
}
