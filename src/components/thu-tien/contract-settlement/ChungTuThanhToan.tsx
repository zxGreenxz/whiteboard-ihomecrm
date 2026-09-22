// =============================================================================
// ChungTuThanhToan — ảnh/chứng từ đang đính trên phiếu chi.
//
// Cùng nguồn dữ liệu với dòng phiếu bên Thu chi (`income_expenses.attachments`),
// nên ảnh dán ở đâu cũng hiện ở cả hai chỗ. Bấm ảnh thì phóng to bằng
// `AttachmentLightbox` sẵn có — không tự dựng lightbox riêng.
//
// Giá trị trong `attachments` có hai đời: URL public cũ và path Storage mới.
// `useSignedUrl` tự nhận ra và ký path; URL cũ thì trả nguyên.
// =============================================================================

import { useState } from 'react';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { useSignedUrl } from '@/hooks/useSignedUrl';

function AnhNho({ gt, onClick }: { gt: string; onClick: () => void }) {
  const src = useSignedUrl(gt);
  return (
    <button type="button" className="cs-anh" onClick={onClick} title="Bấm để phóng to">
      {src
        ? <img src={src} alt="Chứng từ đã đính" loading="lazy" />
        : <span className="cs-anh-cho" />}
    </button>
  );
}

export function ChungTuThanhToan({ attachments }: { attachments: string[] }) {
  const [mo, setMo] = useState<number | null>(null);

  if (attachments.length === 0) {
    return (
      <div className="cs-note-s">
        Chưa có chứng từ chi. Bổ sung khi ghi nhận đã trả tiền.
      </div>
    );
  }

  return (
    <>
      <div className="cs-anh-hang">
        {attachments.map((a, i) => <AnhNho key={a} gt={a} onClick={() => setMo(i)} />)}
      </div>
      <div className="cs-note-s" style={{ marginTop: 6 }}>
        {attachments.length} ảnh đã đính trên phiếu · bấm để phóng to.
      </div>
      <AttachmentLightbox attachments={attachments} index={mo} onIndexChange={setMo} />
    </>
  );
}
