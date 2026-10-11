import type { ReactNode } from 'react';
import ZaloAvatar from './ZaloAvatar';
import type { ZaloMessage } from './types';

/** One avatar per sender run; keep the avatar column aligned for subsequent bubbles. */
export default function MessageSender({ message, grouped, isGroup, children }: {
  message: ZaloMessage; grouped: boolean; isGroup: boolean; children: ReactNode;
}) {
  if (message.type === 'sys') return <>{children}</>;
  const outgoing = message.dir === 'out';
  const name = message.sender?.name || (outgoing ? 'Bạn' : 'Người gửi');
  const initials = name.startsWith('Thành viên') ? '?' : name.trim().split(/\s+/).slice(-2).map(word => word[0]).join('').toUpperCase();
  return <div style={{ display: 'flex', flexDirection: outgoing ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
    <div style={{ width: 32, flex: '0 0 32px', paddingTop: 8 }}>
      {!grouped && <span role="img" aria-label={`Ảnh đại diện ${name}`} title={name} style={{ display: 'block' }}>
        <ZaloAvatar url={message.sender?.avatarUrl} initials={initials || '?'} size={32} fontSize={11} />
      </span>}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      {isGroup && !outgoing && !grouped && <div className="break-words text-xs font-medium text-muted-foreground" style={{ paddingTop: 7 }}>{name}</div>}
      {children}
    </div>
  </div>;
}
