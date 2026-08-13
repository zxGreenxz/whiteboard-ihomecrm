import { useState } from 'react';
import { Sticker as StickerIcon, Search, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useStickerSearch, type StickerItem } from '@/hooks/chat-zalo/useZaloMedia';

interface Props {
  accountId?: string | null;
  onPick: (sticker: StickerItem) => void;
}

/** Popover tìm sticker theo từ khoá (job async qua worker) + grid kết quả. */
export default function StickerPicker({ accountId, onPick }: Props) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<StickerItem[]>([]);
  const search = useStickerSearch();

  const doSearch = () => {
    if (!accountId || !keyword.trim() || search.isPending) return;
    search.mutate({ accountId, keyword: keyword.trim() }, { onSuccess: setResults });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title="Sticker" style={{ width: 32, height: 32, border: 'none', background: 'transparent', borderRadius: 7, color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <StickerIcon size={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-2">
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: '1px solid hsl(210 20% 88%)', borderRadius: 8, padding: '0 9px', height: 32 }}>
            <Search size={13} color="hsl(210 10% 50%)" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } }}
              placeholder="Tìm sticker (vd: cảm ơn, hello)…"
              style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12.5, fontFamily: 'inherit', background: 'transparent' }}
            />
          </div>
          <button onClick={doSearch} disabled={!accountId || search.isPending} style={{ padding: '0 12px', borderRadius: 8, border: 'none', background: 'hsl(152 40% 94%)', color: 'hsl(152 69% 28%)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>
            {search.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Tìm'}
          </button>
        </div>
        {!accountId && <div style={{ fontSize: 12, color: 'hsl(210 10% 50%)', padding: 6 }}>Cần tài khoản Zalo đã kết nối để tìm sticker.</div>}
        <div className="wz-scroll" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
          {results.map((s) => (
            <button key={s.id} type="button" onClick={() => onPick(s)} title={s.text || ''} style={{ border: '1px solid hsl(210 20% 92%)', borderRadius: 9, background: '#fff', cursor: 'pointer', padding: 4 }}>
              {s.url
                ? <img src={s.url} alt={s.text || 'Sticker'} referrerPolicy="no-referrer" loading="lazy" style={{ width: '100%', aspectRatio: '1', objectFit: 'contain' }} />
                : <span style={{ fontSize: 11 }}>{s.text || s.id}</span>}
            </button>
          ))}
        </div>
        {search.isSuccess && results.length === 0 && (
          <div style={{ fontSize: 12, color: 'hsl(210 10% 50%)', padding: 6, textAlign: 'center' }}>Không có kết quả</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
