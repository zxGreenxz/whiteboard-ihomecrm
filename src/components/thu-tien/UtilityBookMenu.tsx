// =============================================
// UtilityBookMenu — chip "Sổ quỹ ghi chi" + dropdown chọn sổ khác.
// Mặc định = sổ "…Thu" của user (defaultId); có thể chọn sổ khác.
// Tự đóng khi click ra ngoài / Escape. Dùng chung desktop + mobile.
//
// Popup render qua PORTAL (document.body, position fixed) và TỰ LẬT hướng
// lên/xuống theo không gian còn lại — fix lỗi owner báo 24/07: card ở cuối
// màn hình mobile mở dropdown bị container overflow che mất (không thấy sổ).
//
// GOTCHA 28/07 (user báo): wrapper portal mượn class "tt-stage" để kế thừa
// token màu, nhưng .tt-stage còn có background/padding/overflow của cả màn
// hình → vẽ một mảng nền to đè lên bảng. Nay wrapper thêm class
// .ub-bookportal trung hoà hết (nền trong suốt, không padding, không bắt
// chuột). Kèm đó: listener 'scroll' capture trước đây đóng menu ngay cả khi
// cuộn CHÍNH danh sách → "lướt xuống không được"; nay bỏ qua scroll phát ra
// từ trong popup.
//
// Nhiều sổ (>6) thì hiện ô lọc nhanh ở đầu danh sách (Enter = chọn kết quả
// đầu) — owner yêu cầu 28/07.
// =============================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
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
const POP_MAX_HEIGHT = 300;
const POP_GAP = 5;
const ROW_H = 38;
const SEARCH_H = 40;
/** Từ ngần này sổ trở lên mới cần ô lọc. */
const SEARCH_MIN = 6;

/** So khớp không dấu, không phân biệt hoa thường (gõ "hkdtam" ra "HKDTâm"). */
const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

export function UtilityBookMenu({ accounts, valueId, defaultId, onPick, compact, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const currentId = valueId ?? defaultId;
  const currentName = accounts.find((a) => a.id === currentId)?.name ?? 'Chọn sổ';
  const showSearch = accounts.length >= SEARCH_MIN;

  const shown = useMemo(() => {
    const k = norm(q.trim());
    return k ? accounts.filter((a) => norm(a.name).includes(k)) : accounts;
  }, [accounts, q]);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const need = Math.min(POP_MAX_HEIGHT, accounts.length * ROW_H + (showSearch ? SEARCH_H : 0) + 16);
    // Giữ popup trong màn hình theo chiều ngang (min-width 190, max 260).
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 268));
    if (spaceBelow < need + POP_GAP) {
      // Thiếu chỗ bên dưới → mở LÊN trên nút.
      setPos({ left, bottom: window.innerHeight - r.top + POP_GAP });
    } else {
      setPos({ left, top: r.bottom + POP_GAP });
    }
    setQ('');
    setOpen(true);
  };

  const pick = (id: string) => { onPick(id); setOpen(false); };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // Cuộn TRANG/resize làm vị trí fixed lệch khỏi nút → đóng cho an toàn.
    // Nhưng cuộn CHÍNH danh sách thì phải kệ (scroll bắt ở capture nên event
    // của popup cũng chạy qua đây).
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
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
            className="tt-stage ub-bookportal"
            style={{ left: pos.left, top: pos.top ?? 'auto', bottom: pos.bottom ?? 'auto' }}
          >
            <div className="ub-bookpop" role="listbox" ref={popRef}>
              {showSearch && (
                <div className="ub-booksearch">
                  <Search />
                  <input
                    autoFocus
                    className="ub-booksearch-in"
                    placeholder="Lọc sổ quỹ…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && shown.length > 0) { e.preventDefault(); pick(shown[0].id); }
                    }}
                  />
                </div>
              )}
              <div className="ub-booklist">
                {accounts.length === 0 && <div className="ub-bookpop-empty">Không có sổ quỹ</div>}
                {accounts.length > 0 && shown.length === 0 && (
                  <div className="ub-bookpop-empty">Không có sổ nào khớp “{q.trim()}”</div>
                )}
                {shown.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    role="option"
                    aria-selected={a.id === currentId}
                    className={'ub-bookopt' + (a.id === currentId ? ' on' : '')}
                    onClick={() => pick(a.id)}
                  >
                    <BookIcon size={14} />
                    <span className="ub-bookopt-nm">{a.name}</span>
                    {a.id === defaultId && <span className="ub-bookopt-def">mặc định</span>}
                    {a.id === currentId && <Check className="ub-bookopt-ck" />}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default UtilityBookMenu;
