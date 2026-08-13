import { ArrowLeft, Search, Phone, PanelRightOpen } from 'lucide-react';
import { tagStyle } from './zaloTheme';
import ZaloAvatar from './ZaloAvatar';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  /** Mobile: quay lại danh sách */
  onBack?: () => void;
  /** Mobile: mở panel thông tin */
  onOpenInfo?: () => void;
  /** Bật/tắt thanh tìm trong hội thoại */
  onSearch?: () => void;
}

const actBtn = {
  width: 38, height: 38, borderRadius: 8, border: '1px solid hsl(210 20% 90%)', background: '#fff',
  color: 'hsl(160 20% 30%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
} as const;

/** Đầu khung chat: avatar + tên + tag + nút thao tác. */
export default function ThreadHeader({ conv, onBack, onOpenInfo, onSearch }: Props) {
  return (
    <div style={{ height: 64, flex: 'none', padding: '0 18px', background: '#fff', borderBottom: '1px solid hsl(210 20% 90%)', display: 'flex', alignItems: 'center', gap: 12 }}>
      {onBack && (
        <button onClick={onBack} className="lg:hidden" style={{ ...actBtn, width: 34, height: 34 }} title="Quay lại">
          <ArrowLeft size={18} />
        </button>
      )}
      <ZaloAvatar url={conv.avatarUrl} initials={conv.initials} tone={conv.tone} size={42} fontSize={15} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15.5, fontWeight: 700 }}>{conv.name}</span>
          <span style={tagStyle(conv.headerTag.t, { fontSize: '10.5px', padding: '2px 8px', borderRadius: '7px' })}>{conv.headerTag.l}</span>
        </div>
        <div style={{ fontSize: 12, color: 'hsl(210 10% 45%)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.headerSub}</div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={onSearch} style={actBtn} title="Tìm trong hội thoại"><Search size={17} /></button>
        {conv.phone && (
          <a href={`tel:${conv.phone}`} style={{ ...actBtn, textDecoration: 'none' }} title={`Gọi ${conv.phone}`}><Phone size={17} /></a>
        )}
        {onOpenInfo && (
          <button onClick={onOpenInfo} className="lg:hidden" style={actBtn} title="Thông tin"><PanelRightOpen size={17} /></button>
        )}
      </div>
    </div>
  );
}
