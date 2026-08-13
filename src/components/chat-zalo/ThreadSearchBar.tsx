import { useEffect, useMemo, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { normalizeVn } from './threadItems';
import type { ZaloMessage } from './types';

interface Props {
  messages: ZaloMessage[];
  onNavigate: (messageId: string) => void;
  onTerm: (term: string) => void;
  onClose: () => void;
}

/**
 * Thanh tìm trong hội thoại (trượt dưới header): tìm client-side trên các tin
 * ĐÃ TẢI (≤1000 tin mới nhất), bỏ dấu tiếng Việt, điều hướng ↑↓.
 */
export default function ThreadSearchBar({ messages, onNavigate, onTerm, onClose }: Props) {
  const [term, setTerm] = useState('');
  const [pos, setPos] = useState(0);

  const hits = useMemo(() => {
    const q = normalizeVn(term.trim());
    if (!q) return [];
    return messages
      .filter((m) => m.id && m.text && normalizeVn(m.text).includes(q))
      .map((m) => m.id!) ;
  }, [messages, term]);

  useEffect(() => { setPos(hits.length ? hits.length - 1 : 0); }, [hits.length]);
  useEffect(() => { onTerm(term.trim()); }, [term, onTerm]);
  useEffect(() => {
    if (hits.length && hits[pos]) onNavigate(hits[pos]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, hits.length]);

  const step = (d: number) => {
    if (!hits.length) return;
    setPos((p) => (p + d + hits.length) % hits.length);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px', background: '#fff', borderBottom: '1px solid hsl(210 20% 90%)', flex: 'none' }}>
      <Search size={15} color="hsl(210 10% 50%)" />
      <input
        autoFocus
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') step(e.shiftKey ? 1 : -1);
        }}
        placeholder="Tìm trong hội thoại (trong tin đã tải)…"
        style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', background: 'transparent' }}
      />
      <span style={{ fontSize: 12, color: 'hsl(210 10% 50%)', minWidth: 44, textAlign: 'right' }}>
        {term.trim() ? (hits.length ? `${pos + 1}/${hits.length}` : '0/0') : ''}
      </span>
      <button onClick={() => step(-1)} disabled={!hits.length} title="Kết quả trước (cũ hơn)" style={{ border: '1px solid hsl(210 20% 88%)', background: '#fff', borderRadius: 7, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'hsl(160 20% 30%)' }}>
        <ChevronUp size={15} />
      </button>
      <button onClick={() => step(1)} disabled={!hits.length} title="Kết quả sau (mới hơn)" style={{ border: '1px solid hsl(210 20% 88%)', background: '#fff', borderRadius: 7, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'hsl(160 20% 30%)' }}>
        <ChevronDown size={15} />
      </button>
      <button onClick={onClose} title="Đóng (Esc)" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(210 10% 50%)', display: 'flex', padding: 3 }}>
        <X size={16} />
      </button>
    </div>
  );
}
