import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Bottom-sheet dùng chung cho redesign Sale Phòng mobile. Render qua portal vào
 * khung điện thoại (.cm-app) để phủ đúng vùng app, không tràn ra ngoài. Đóng khi
 * chạm backdrop hoặc nhấn Escape.
 */
export default function SaleSheet({
  open, onClose, children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Gắn vào .cm-app gần nhất (khung phone) nếu có, fallback body.
  const host = (typeof document !== "undefined" && document.querySelector(".cm-app")) || document.body;

  return createPortal(
    <>
      <div className="sp-backdrop" onClick={onClose} />
      <div className="sp-sheet" role="dialog" aria-modal="true">
        <div className="grip"><span /></div>
        <div className="sp-sheet-body">{children}</div>
      </div>
    </>,
    host,
  );
}
