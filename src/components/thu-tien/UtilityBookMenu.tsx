// =============================================
// UtilityBookMenu — chip "Sổ quỹ ghi chi" + dropdown chọn sổ khác.
// Mặc định = sổ "…Thu" của user (defaultId); có thể chọn sổ khác.
// Tự đóng khi click ra ngoài / Escape. Dùng chung desktop + mobile.
//
// Popup render qua PORTAL (document.body, position fixed) và TỰ LẬT hướng
// lên/xuống theo không gian còn lại — fix lỗi owner báo 24/07: card ở cuối
// màn hình mobile mở dropdown bị container overflow che mất (không thấy sổ).
// Wrapper portal mang class "tt-stage" để CSS scoped .tt-stage .ub-bookpop
// vẫn áp cho popup nằm ngoài stage.
// =============================================

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { BookIcon } from './utilityIcons';

interface BookOption {
  id: string;
  name: string;
}

interface Props {
  accounts: BookOption[];
  valueId: string | null;   // sổ đang chọn (null = dùng mặc định)
  defaultId: string | null; // sổ "…Thu" tự chọn
  onPick: (id: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

/** Ước lượng chiều cao popup để quyết định lật hướng (khớp max-height CSS). */
const POP_MAX_HEIGHT = 260;
const POP_GAP = 5;

export function UtilityBookMenu({ accounts, valueId, defaultId, onPick, compact, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const currentId = valueId ?? defaultId;
  const currentName = accounts.find((a) => a.id === currentId)?.name ?? 'Chọn sổ';

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    // Giữ popup trong màn hình theo chiều ngang (min-width 190, max 260).
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 268));
    if (spaceBelow < Math.min(POP_MAX_HEIGHT, accounts.length * 38 + 16) + POP_GAP) {
      // Thiếu chỗ bên dưới → mở LÊN trên nút.
      setPos({ left, bottom: window.innerHeight - r.top + POP_GAP });
    } else {
      setPos({ left, top: r.bottom + POP_GAP });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // Cuộn/resize làm vị trí fixed lệch khỏi nút → đóng cho an toàn.
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  return (
    <div className={'ub-bookmenu' + (compact ? ' compact' : '')}>
      <button
        ref={btnRef}
        type="button"
        className="ub-bookbtn"
        title="Đổi sổ quỹ ghi chi"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <BookIcon size={14} className="ub-bookbtn-ic" />
        <span className="ub-bookbtn-nm">{currentName}</span>
        <ChevronDown className="ub-bookbtn-cv" />
      </button>
      {open && pos &&
        createPortal(
          <div
            className="tt-stage"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              zIndex: 300,
            }}
          >
            <div className="ub-bookpop" style={{ position: 'static' }} role="listbox" ref={popRef}>
              {accounts.length === 0 && <div className="ub-bookpop-empty">Không có sổ quỹ</div>}
              {accounts.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  role="option"
                  aria-selected={a.id === currentId}
                  className={'ub-bookopt' + (a.id === currentId ? ' on' : '')}
                  onClick={() => { onPick(a.id); setOpen(false); }}
                >
                  <BookIcon size={14} />
                  <span className="ub-bookopt-nm">{a.name}</span>
                  {a.id === defaultId && <span className="ub-bookopt-def">mặc định</span>}
                  {a.id === currentId && <Check className="ub-bookopt-ck" />}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default UtilityBookMenu;
