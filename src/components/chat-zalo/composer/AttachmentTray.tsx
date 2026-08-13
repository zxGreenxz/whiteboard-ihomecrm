import { useEffect, useMemo } from 'react';
import { X, FileText, Loader2, Send } from 'lucide-react';
import { EMERALD } from '../zaloTheme';

export interface PendingFile {
  file: File;
  /** objectURL preview cho ảnh */
  previewUrl?: string;
}

interface Props {
  items: PendingFile[];
  caption: string;
  onCaption: (v: string) => void;
  onRemove: (index: number) => void;
  onSend: () => void;
  onCancel: () => void;
  uploading: boolean;
}

function fmtSize(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Khay xem trước tệp đã chọn (ảnh thumbnail / icon tệp) + caption + nút gửi. */
export default function AttachmentTray({ items, caption, onCaption, onRemove, onSend, onCancel, uploading }: Props) {
  const allImages = useMemo(() => items.every((i) => i.file.type.startsWith('image/')), [items]);

  // revoke objectURL khi unmount (tránh leak)
  useEffect(() => () => { items.forEach((i) => { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); }); }, [items]);

  if (!items.length) return null;
  return (
    <div style={{ border: '1px solid hsl(210 20% 88%)', borderRadius: 12, background: '#fff', padding: 10, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'hsl(160 30% 18%)' }}>
          {allImages ? `Gửi ${items.length} ảnh` : `Gửi ${items.length} tệp`}
        </span>
        <button onClick={onCancel} disabled={uploading} title="Huỷ" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'hsl(210 10% 50%)', display: 'flex', padding: 2 }}>
          <X size={16} />
        </button>
      </div>
      <div className="wz-scroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {items.map((it, i) => (
          <div key={i} style={{ position: 'relative', flex: 'none' }}>
            {it.previewUrl ? (
              <img src={it.previewUrl} alt={it.file.name} style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 9, border: '1px solid hsl(210 20% 88%)' }} />
            ) : (
              <div style={{ width: 130, height: 76, borderRadius: 9, border: '1px solid hsl(210 20% 88%)', background: 'hsl(210 20% 97%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 6 }}>
                <FileText size={20} color="hsl(152 69% 32%)" />
                <span style={{ fontSize: 10.5, fontWeight: 600, maxWidth: 116, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.file.name}</span>
                <span style={{ fontSize: 10, color: 'hsl(210 10% 50%)' }}>{fmtSize(it.file.size)}</span>
              </div>
            )}
            {!uploading && (
              <button onClick={() => onRemove(i)} title="Bỏ tệp này" style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: '1px solid hsl(210 20% 85%)', background: '#fff', color: 'hsl(0 60% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 1px 3px rgba(16,24,40,.15)' }}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          value={caption}
          onChange={(e) => onCaption(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) { e.preventDefault(); onSend(); } }}
          placeholder="Thêm chú thích…"
          disabled={uploading}
          style={{ flex: 1, border: '1px solid hsl(210 20% 88%)', borderRadius: 9, padding: '7px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <button
          onClick={onSend}
          disabled={uploading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 16px', borderRadius: 9, border: 'none', background: EMERALD, color: '#fff', fontWeight: 600, fontSize: 13, cursor: uploading ? 'default' : 'pointer', opacity: uploading ? 0.75 : 1 }}
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {uploading ? 'Đang gửi…' : 'Gửi'}
        </button>
      </div>
    </div>
  );
}
