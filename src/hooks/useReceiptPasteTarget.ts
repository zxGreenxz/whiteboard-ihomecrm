// =============================================================================
// useReceiptPasteTarget — đích dán ảnh chứng từ (Ctrl+V) cho các bảng "đóng
// tiền theo kỳ" của trang Thu tiền (Điện & Nước + các hạng mục GRID).
//
// GOTCHA (28/07/2026 — bug user báo): trang Thu tiền mount ĐỒNG THỜI panel
// desktop (PeriodFeePanel → UtilityEnContent) và sheet trong khung điện thoại
// (PeriodFeeSheet) → 2 instance state, mỗi instance 1 listener 'paste' trên
// document. Bản cũ để mỗi instance giữ attachKeyRef RIÊNG rồi đánh dấu event
// "đã xử lý", nên instance đăng ký trước (sheet, mount ngay khi mở Điện nước)
// luôn nuốt event trong khi key của nó rỗng → dán ảnh ở bảng desktop chỉ ra
// toast "Chạm vào ô Số tiền…" dù đã bấm đúng dòng.
//
// Cách chữa: đích dán nằm ở MỘT biến module (owner + key) chứ không phải ref
// của từng instance; instance nào KHÔNG sở hữu đích thì bỏ qua event. Đồng
// thời hover THẮNG focus — đưa chuột vào dòng nào thì Ctrl+V đính vào dòng đó
// (đúng thao tác user mong đợi), khỏi phải bấm ô Số tiền trước.
// =============================================================================

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

interface Target {
  owner: number;
  key: string;
}

let ownerSeq = 0;
/** Dòng đang rê chuột — ưu tiên cao nhất, xoá khi chuột rời. */
let hoverTarget: Target | null = null;
/** Dòng vừa bấm (ô Số tiền / nút ảnh) — giữ lại cho tới lần bấm sau. */
let focusTarget: Target | null = null;

const HINT = 'Đưa chuột vào dòng cần đính ảnh (hoặc bấm ô Số tiền) rồi dán lại';

/** Ảnh đầu tiên trong clipboard. Đọc `files` trước, `items` chỉ là fallback cho
 *  trình duyệt cũ — đọc cả hai sẽ nhân đôi cùng một ảnh. */
export function clipboardImageFile(e: ClipboardEvent): File | null {
  const dt = e.clipboardData;
  if (!dt) return null;
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    if (f && f.type.startsWith('image/')) return f;
  }
  for (let i = 0; i < dt.items.length; i++) {
    const it = dt.items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/**
 * @param onImage  gọi khi dán ảnh trúng đích của instance này (key = key dòng).
 *                 Callback được đọc qua ref nên KHÔNG cần memo hoá.
 */
export function useReceiptPasteTarget(onImage: (key: string, file: File) => void) {
  const ownerRef = useRef(0);
  if (ownerRef.current === 0) ownerRef.current = ++ownerSeq;
  const owner = ownerRef.current;

  const cbRef = useRef(onImage);
  cbRef.current = onImage;

  /** Đánh dấu dòng đang thao tác (focus ô Số tiền / bấm nút ảnh). */
  const setActiveKey = useCallback((key: string) => {
    focusTarget = { owner, key };
  }, [owner]);

  const setHoverKey = useCallback((key: string | null) => {
    if (key) hoverTarget = { owner, key };
    else if (hoverTarget?.owner === owner) hoverTarget = null;
  }, [owner]);

  /** Spread vào <tr>/<div> của dòng: rê chuột tới đâu, Ctrl+V đính vào đó. */
  const pasteProps = useCallback((key: string) => ({
    onMouseEnter: () => setHoverKey(key),
    onMouseLeave: () => setHoverKey(null),
  }), [setHoverKey]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = clipboardImageFile(e);
      if (!file) return; // dán text bình thường — không can thiệp
      const t = hoverTarget ?? focusTarget;
      if (t && t.owner !== owner) return; // instance khác đang giữ đích
      e.preventDefault();
      if (!t) {
        // Không bên nào có đích → chỉ MỘT bên được nhắc (nhiều instance cùng nghe).
        const marked = e as ClipboardEvent & { __receiptPasteHinted?: boolean };
        if (marked.__receiptPasteHinted) return;
        marked.__receiptPasteHinted = true;
        toast.info(HINT);
        return;
      }
      cbRef.current(t.key, file);
    };
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('paste', onPaste);
      // Nhả đích khi unmount, kẻo instance còn sống bị chặn vĩnh viễn.
      if (hoverTarget?.owner === owner) hoverTarget = null;
      if (focusTarget?.owner === owner) focusTarget = null;
    };
  }, [owner]);

  return { setActiveKey, setHoverKey, pasteProps };
}
