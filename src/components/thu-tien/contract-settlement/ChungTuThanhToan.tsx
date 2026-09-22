// =============================================================================
// ChungTuThanhToan — ảnh/chứng từ đang đính trên phiếu chi.
//
// Cùng nguồn dữ liệu với dòng phiếu bên Thu chi (`income_expenses.attachments`),
// nên ảnh dán ở đâu cũng hiện ở cả hai chỗ. Bấm ảnh thì phóng to bằng
// `AttachmentLightbox` sẵn có — không tự dựng lightbox riêng.
//
// Giá trị trong `attachments` có hai đời: URL public cũ và path Storage mới.
// `useSignedUrl` tự nhận ra và ký path; URL cũ thì trả nguyên.
//
// ── VÌ SAO CÓ `anhTrongPhien` VÀ `boQua` ────────────────────────────────────
// `row.attachments` là ảnh chụp lúc ĐỌC danh sách, nên ảnh vừa tải/dán trong
// hộp thoại chưa có trong đó — phải hiện ngay chứ không đợi refetch. Khi refetch
// về thì cùng một URL nằm ở CẢ HAI nguồn; `buildPostingEvidenceItems` (dùng
// chung với hộp thoại Thu chi) khử trùng theo URL nên danh sách KHÔNG nhân đôi.
//
// `boQua` là các ảnh server KHÔNG nhận làm chứng từ cho lần ghi sổ đang mở (đã
// dùng cho lần chi trước, file mất, file của tổ chức khác…). Chúng vẫn hiện —
// im lặng bỏ qua là cách chắc chắn làm người dùng tưởng hệ thống nuốt mất ảnh —
// nhưng mờ đi và nói rõ lý do. MỘT ảnh hỏng không phủ nhận ảnh còn lại.
//
// Không có nút xoá ảnh ở đây: gỡ bằng chứng là hành vi SỬA phiếu, thuộc Thu chi.
// =============================================================================

import { useMemo, useState } from 'react';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { useSignedUrl } from '@/hooks/useSignedUrl';
import {
  buildPostingEvidenceItems,
  type PostingEvidenceItem,
  type PostingEvidenceSkip,
} from '@/lib/postingEvidenceItems';

function AnhNho({ anh, onClick }: { anh: PostingEvidenceItem; onClick: () => void }) {
  const src = useSignedUrl(anh.url);
  return (
    <button
      type="button"
      className="cs-anh"
      onClick={onClick}
      style={anh.usable ? undefined : { opacity: 0.45, filter: 'grayscale(1)' }}
      title={
        anh.usable
          ? (anh.addedNow ? 'Ảnh vừa thêm — bấm để phóng to' : 'Ảnh đã đính trên phiếu — bấm để phóng to')
          : anh.reasonText
      }
    >
      {src
        ? <img src={src} alt="Chứng từ đã đính" loading="lazy" />
        : <span className="cs-anh-cho" />}
    </button>
  );
}

interface Props {
  attachments: string[];
  /** URL vừa tải/dán trong phiên này — chưa kịp về trong `attachments`. */
  anhTrongPhien?: string[];
  /** Ảnh server không nhận làm chứng từ cho lần ghi sổ đang mở, kèm lý do. */
  boQua?: PostingEvidenceSkip[];
}

export function ChungTuThanhToan({ attachments, anhTrongPhien, boQua }: Props) {
  const [mo, setMo] = useState<number | null>(null);

  const anh = useMemo(
    () => buildPostingEvidenceItems({
      attachments,
      sessionUploaded: anhTrongPhien ?? [],
      skipped: boQua ?? [],
    }),
    [attachments, anhTrongPhien, boQua],
  );

  if (anh.length === 0) {
    return (
      <div className="cs-note-s">
        Chưa có chứng từ chi. Bổ sung khi ghi nhận đã trả tiền.
      </div>
    );
  }

  const soMo = anh.filter((a) => !a.usable).length;

  return (
    <>
      <div className="cs-anh-hang">
        {anh.map((a, i) => <AnhNho key={a.url} anh={a} onClick={() => setMo(i)} />)}
      </div>
      <div className="cs-note-s" style={{ marginTop: 6 }}>
        {anh.length} ảnh đã đính trên phiếu · bấm để phóng to.
      </div>
      {soMo > 0 && (
        <div className="cs-note-s" style={{ color: 'var(--c-partial)' }}>
          {soMo} ảnh mờ là ảnh không tính cho lần chi này — đưa chuột lên ảnh để xem lý do.
        </div>
      )}
      <AttachmentLightbox attachments={anh.map((a) => a.url)} index={mo} onIndexChange={setMo} />
    </>
  );
}
