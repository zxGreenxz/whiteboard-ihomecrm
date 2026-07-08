// =============================================
// UtilityReceiptThumb — ô ảnh phiếu chi: có ảnh → hiện thumbnail thật (ký signed
// URL qua StorageImage, tự cache → mở lightbox tức thì); chưa có → placeholder
// mờ "chưa có ảnh" (viền nét đứt). Bấm khi có ảnh → mở lightbox.
// Thumbnail render sẵn = tải nền ảnh trước, xem khi cần là hiện ngay.
// =============================================

import { ImageOff } from 'lucide-react';
import { StorageImage } from '@/components/ui/storage-image';

interface Props {
  attachments: string[];
  onView: (attachments: string[]) => void;
  size?: 'sm' | 'md';
}

export function UtilityReceiptThumb({ attachments, onView, size = 'md' }: Props) {
  if (!attachments || attachments.length === 0) {
    return (
      <span className={'urt urt-none ' + size} title="Chưa có ảnh phiếu">
        <ImageOff />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={'urt urt-has ' + size}
      title={'Xem ảnh phiếu' + (attachments.length > 1 ? ` (${attachments.length})` : '')}
      onClick={() => onView(attachments)}
    >
      <StorageImage value={attachments[0]} alt="Ảnh phiếu chi" className="urt-img" />
      {attachments.length > 1 && <span className="urt-cnt">{attachments.length}</span>}
    </button>
  );
}

export default UtilityReceiptThumb;
