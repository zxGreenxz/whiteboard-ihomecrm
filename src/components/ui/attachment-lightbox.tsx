// =============================================================================
// AttachmentLightbox — xem ảnh/PDF đính kèm phủ TOÀN TRANG (overlay), KHÔNG mở
// tab mới. Tách từ IncomeExpenseDetailDialog để dùng lại ở danh sách thu chi,
// chi tiết mobile, và đợt phiếu.
//   - Esc đóng; ← / → chuyển ảnh khi có nhiều file.
//   - Chạm nền tối để đóng; bấm vào ảnh không đóng.
//   - Ảnh ký signed URL qua StorageImage; PDF nhúng iframe qua useSignedUrl.
//   - Render qua portal lên <body> để luôn nổi trên mọi layout (kể cả trong bảng
//     hoặc Dialog) mà không vướng stacking context của cha.
// =============================================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { StorageImage } from '@/components/ui/storage-image';
import { useSignedUrl } from '@/hooks/useSignedUrl';

const isPdf = (url: string) =>
  url.toLowerCase().endsWith('.pdf') || url.includes('.pdf');

interface AttachmentLightboxProps {
  /** Danh sách giá trị file đã lưu (URL public cũ / path Storage). */
  attachments: string[];
  /** Index file đang mở; null = đóng. */
  index: number | null;
  /** Đổi index, hoặc null để đóng. */
  onIndexChange: (index: number | null) => void;
}

export function AttachmentLightbox({
  attachments,
  index,
  onIndexChange,
}: AttachmentLightboxProps) {
  const isOpen = index !== null;
  const url = index !== null ? attachments[index] ?? null : null;
  const signedUrl = useSignedUrl(url);
  const hasMultiple = attachments.length > 1;

  const close = () => onIndexChange(null);
  const goPrev = () =>
    onIndexChange(
      index === null || attachments.length === 0
        ? index
        : (index - 1 + attachments.length) % attachments.length
    );
  const goNext = () =>
    onIndexChange(
      index === null || attachments.length === 0
        ? index
        : (index + 1) % attachments.length
    );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowLeft' && hasMultiple) {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' && hasMultiple) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // index/attachments.length nằm trong deps để goPrev/goNext không bị stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, hasMultiple, index, attachments.length]);

  if (!url) return null;

  // Phủ toàn màn hình (fixed) qua portal lên <body> để nổi trên mọi layout (bảng,
  // Dialog, bottom-sheet) mà không vướng stacking/transform của cha. Trên điện
  // thoại thật / PWA, viewport == khung .cm-app nên overlay vừa khít cả màn hình.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6 pointer-events-auto"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Ảnh đính kèm"
    >
      <button
        type="button"
        className="absolute top-4 right-4 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        title="Đóng (Esc)"
      >
        <X className="h-5 w-5" />
      </button>
      {hasMultiple && (
        <>
          <button
            type="button"
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            title="Ảnh trước (←)"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            title="Ảnh sau (→)"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/90 text-sm bg-black/40 rounded-full px-3 py-1">
            {(index ?? 0) + 1} / {attachments.length}
          </div>
        </>
      )}
      {isPdf(url) ? (
        <iframe
          src={signedUrl}
          className="w-full h-full max-w-5xl max-h-[90vh] bg-white rounded-md"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <StorageImage
          value={url}
          alt="Đính kèm phóng lớn"
          className="max-w-[95vw] max-h-[90vh] object-contain rounded-md shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>,
    document.body
  );
}

export default AttachmentLightbox;
