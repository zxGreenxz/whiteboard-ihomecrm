// =============================================
// UtilityBookMenu — chip "Sổ quỹ ghi chi" + dropdown chọn sổ khác.
// Mặc định = sổ "…Thu" của user (defaultId); có thể chọn sổ khác.
// Tự đóng khi click ra ngoài / Escape. Dùng chung desktop + mobile.
// =============================================

import { useEffect, useRef, useState } from 'react';
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

export function UtilityBookMenu({ accounts, valueId, defaultId, onPick, compact, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentId = valueId ?? defaultId;
  const currentName = accounts.find((a) => a.id === currentId)?.name ?? 'Chọn sổ';

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={'ub-bookmenu' + (compact ? ' compact' : '')} ref={ref}>
      <button
        type="button"
        className="ub-bookbtn"
        title="Đổi sổ quỹ ghi chi"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <BookIcon size={14} className="ub-bookbtn-ic" />
        <span className="ub-bookbtn-nm">{currentName}</span>
        <ChevronDown className="ub-bookbtn-cv" />
      </button>
      {open && (
        <div className="ub-bookpop" role="listbox">
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
      )}
    </div>
  );
}

export default UtilityBookMenu;
