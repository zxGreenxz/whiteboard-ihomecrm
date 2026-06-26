import { useMemo, useState } from 'react';
import { Search, Send, Loader2, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EMERALD } from './zaloTheme';
import { labelColor } from './LabelFilter';
import LabelFilter from './LabelFilter';
import ZaloAvatar from './ZaloAvatar';
import type { ZaloConversation, ZaloLabel } from './types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversations: ZaloConversation[];
  labels: ZaloLabel[];
  sending?: boolean;
  onSend: (ids: string[], body: string) => void;
}

/** Dialog "Chia sẻ / Gửi hàng loạt": chọn nhiều hội thoại (lọc theo nhãn) + gửi 1 nội dung. */
export default function BroadcastDialog({ open, onOpenChange, conversations, labels, sending, onSend }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (labelFilter != null && !(c.labelIds || []).includes(labelFilter)) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q);
    });
  }, [conversations, search, labelFilter]);

  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAllVisible = () => setSelected((p) => { const n = new Set(p); filtered.forEach((c) => n.add(c.id)); return n; });
  const clearAll = () => setSelected(new Set());

  const labelDots = (ids?: number[]) => (ids || []).slice(0, 3).map((id) => labels.find((l) => l.labelId === id)).filter(Boolean) as ZaloLabel[];

  const submit = () => {
    if (!selected.size || !message.trim()) return;
    onSend([...selected], message.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Send className="h-5 w-5" style={{ color: EMERALD }} /> Chia sẻ / Gửi hàng loạt</DialogTitle>
          <DialogDescription>Chọn hội thoại (lọc theo nhãn phân loại) rồi gửi cùng một nội dung tới tất cả.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <LabelFilter labels={labels} selectedLabel={labelFilter} onSelect={setLabelFilter} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1, height: 34, padding: '0 10px', background: 'hsl(210 20% 96%)', borderRadius: 8, color: 'hsl(210 10% 50%)' }}>
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm hội thoại…" style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 13, outline: 'none', fontFamily: 'inherit' }} />
          </div>
          <button onClick={selectAllVisible} style={{ fontSize: 12, fontWeight: 600, color: EMERALD, background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Chọn tất cả</button>
        </div>

        <div className="wz-scroll" style={{ height: 260, overflowY: 'auto', border: '1px solid hsl(210 20% 90%)', borderRadius: 10 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'hsl(210 10% 50%)', fontSize: 13 }}>Không có hội thoại phù hợp</div>
          ) : filtered.slice(0, 400).map((c) => {
            const on = selected.has(c.id);
            return (
              <button key={c.id} onClick={() => toggle(c.id)} className="w-full" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', border: 'none', borderBottom: '1px solid hsl(210 20% 95%)', background: on ? 'hsl(152 30% 96%)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', border: on ? 'none' : '1.5px solid hsl(210 20% 80%)', background: on ? EMERALD : '#fff' }}>{on && <Check size={13} color="#fff" strokeWidth={3} />}</span>
                <ZaloAvatar url={c.avatarUrl} initials={c.initials} tone={c.tone} size={30} fontSize={12} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: 'hsl(210 10% 50%)' }}>{c.sub || c.phone}</span>
                </span>
                <span style={{ display: 'flex', gap: 3, flex: 'none' }}>{labelDots(c.labelIds).map((l) => <span key={l.labelId} title={l.name} style={{ width: 8, height: 8, borderRadius: 2, background: labelColor(l.color) }} />)}</span>
              </button>
            );
          })}
        </div>

        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Nhập nội dung gửi tới các hội thoại đã chọn…" style={{ width: '100%', border: '1px solid hsl(210 20% 88%)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'inherit', resize: 'none', outline: 'none' }} />

        <div className="flex items-center justify-between">
          <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)' }}>
            Đã chọn <b style={{ color: EMERALD }}>{selected.size}</b> hội thoại
            {selected.size > 0 && <button onClick={clearAll} style={{ marginLeft: 8, fontSize: 12, color: 'hsl(0 70% 50%)', background: 'none', border: 'none', cursor: 'pointer' }}>Bỏ chọn</button>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
            <Button onClick={submit} disabled={!selected.size || !message.trim() || sending} style={{ background: EMERALD }}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />} Gửi tới {selected.size}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
