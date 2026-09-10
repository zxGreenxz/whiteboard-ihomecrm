import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { useAuth } from "@/hooks/useAuth";
import type { StorageOrganizationSource } from "@/lib/storageOrganization";

export function ReservationRefundAttachments({ attachments, onChange, disabled, onUploadingChange, organization }: {
  organization: StorageOrganizationSource;
  attachments: string[];
  onChange: (urls: string[]) => void;
  disabled: boolean;
  onUploadingChange: (busy: boolean) => void;
}) {
  const { data: user } = useAuth();
  return <section className="space-y-2" aria-label="Chứng từ hoàn tiền">
    <p className="text-sm font-medium">Ảnh chuyển khoản / chứng từ hoàn tiền</p>
    <p className="text-xs text-muted-foreground">Không bắt buộc · Tối đa 10 tệp. Ảnh sẽ lưu trên phiếu chi và hiển thị trong thông tin bỏ cọc của phiếu thu gốc.</p>
    <AttachmentUpload attachments={attachments} onChange={onChange} userId={user?.id ?? ""}
      organization={organization}
      disabled={disabled || !user} maxFiles={10} onUploadingChange={onUploadingChange}
      deleteOnRemove={false} />
  </section>;
}
