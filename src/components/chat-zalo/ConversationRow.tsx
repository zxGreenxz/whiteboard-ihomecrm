import { useState } from 'react';
import { Pin, BellOff, MailPlus, MailCheck, Link2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toneOf, tagStyle, EMERALD } from './zaloTheme';
import ZaloAvatar from './ZaloAvatar';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  active: boolean;
  onSelect: (id: string) => void;
  /** context menu (chuột phải): ghim / tắt thông báo / đánh dấu chưa đọc / gắn hồ sơ */
  onTogglePin?: (c: ZaloConversation) => void;
  onToggleMute?: (c: ZaloConversation) => void;
  onToggleUnread?: (c: ZaloConversation) => void;
  onLinkCrm?: (c: ZaloConversation) => void;
}

/** 1 dòng hội thoại trong cột danh sách (avatar + tên + preview + badge + menu chuột phải). */
export default function ConversationRow({ conv, active, onSelect, onTogglePin, onToggleMute, onToggleUnread, onLinkCrm }: Props) {
  const subColor = conv.subTone ? toneOf(conv.subTone).fg : 'hsl(210 10% 50%)';
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = !!(onTogglePin || onToggleMute || onToggleUnread || onLinkCrm);
  const showUnreadDot = conv.markedUnread && conv.unread === 0;

  const row = (
    <div
      onClick={() => onSelect(conv.id)}
      onContextMenu={hasMenu ? (e) => { e.preventDefault(); setMenuOpen(true); } : undefined}
      style={{
        display: 'flex',
        gap: 11,
        padding: '12px 16px',
        cursor: 'pointer',
        background: active ? 'hsl(152 30% 96%)' : 'transparent',
        borderLeft: active ? `3px solid ${EMERALD}` : '3px solid transparent',
        borderBottom: '1px solid hsl(210 20% 95%)',
      }}
    >
      <div style={{ position: 'relative', flex: 'none' }}>
        <ZaloAvatar url={conv.avatarUrl} initials={conv.initials} tone={conv.tone} size={46} fontSize={15} />
        {conv.online && (
          <span style={{ position: 'absolute', bottom: 0, right: 0, width: 13, height: 13, borderRadius: '50%', background: 'hsl(142 71% 45%)', border: '2.5px solid #fff' }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: active ? 700 : 600, color: active ? 'hsl(160 30% 12%)' : 'hsl(160 30% 18%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.name}</span>
            {conv.pinned && <Pin size={12} color={EMERALD} style={{ flex: 'none' }} />}
            {conv.muted && <BellOff size={12} color="hsl(210 10% 55%)" style={{ flex: 'none' }} />}
          </span>
          <span style={{ fontSize: 11, color: 'hsl(210 10% 50%)', flex: 'none' }}>{conv.time}</span>
        </div>
        <div style={{ fontSize: 11.5, color: subColor, fontWeight: conv.subTone ? 600 : 400, margin: '1px 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.sub}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.preview}</span>
          {conv.unread > 0 && (
            <span style={{ marginLeft: 'auto', background: EMERALD, color: '#fff', fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{conv.unread}</span>
          )}
          {showUnreadDot && (
            <span title="Đã đánh dấu chưa đọc" style={{ marginLeft: conv.unread > 0 ? undefined : 'auto', width: 9, height: 9, borderRadius: '50%', background: EMERALD, flex: 'none' }} />
          )}
          {conv.listTag && (
            <span style={tagStyle(conv.listTag.t, { fontSize: '10px', padding: '2px 7px', borderRadius: '7px', flex: 'none', marginLeft: (conv.unread > 0 || showUnreadDot) ? undefined : 'auto' })}>{conv.listTag.l}</span>
          )}
        </div>
      </div>
    </div>
  );

  if (!hasMenu) return row;
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{row}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {onTogglePin && (
          <DropdownMenuItem onClick={() => onTogglePin(conv)}>
            <Pin className="mr-2 h-4 w-4" />
            {conv.pinned ? 'Bỏ ghim' : 'Ghim hội thoại'}
          </DropdownMenuItem>
        )}
        {onToggleMute && (
          <DropdownMenuItem onClick={() => onToggleMute(conv)}>
            <BellOff className="mr-2 h-4 w-4" />
            {conv.muted ? 'Bật thông báo' : 'Tắt thông báo'}
          </DropdownMenuItem>
        )}
        {onToggleUnread && (
          <DropdownMenuItem onClick={() => onToggleUnread(conv)}>
            {conv.markedUnread ? <MailCheck className="mr-2 h-4 w-4" /> : <MailPlus className="mr-2 h-4 w-4" />}
            {conv.markedUnread ? 'Bỏ đánh dấu chưa đọc' : 'Đánh dấu chưa đọc'}
          </DropdownMenuItem>
        )}
        {onLinkCrm && !conv.isGroup && (
          <DropdownMenuItem onClick={() => onLinkCrm(conv)}>
            <Link2 className="mr-2 h-4 w-4" />
            Gắn hồ sơ CRM…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
