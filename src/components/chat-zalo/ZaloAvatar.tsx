import { useState, useEffect } from 'react';
import { avatarStyle } from './zaloTheme';
import type { ToneKey } from './types';

interface Props {
  url?: string | null;
  initials: string;
  tone?: ToneKey | null;
  size?: number;
  fontSize?: number;
}

/**
 * Avatar Zalo: hiện ảnh thật (referrerPolicy no-referrer để không bị Zalo CDN
 * chặn 403); lỗi tải hoặc không có URL → fallback chữ viết tắt theo tông.
 */
export default function ZaloAvatar({ url, initials, tone, size = 46, fontSize = 15 }: Props) {
  const [err, setErr] = useState(false);
  useEffect(() => { setErr(false); }, [url]);
  const base = avatarStyle(tone, size, fontSize);
  if (url && !err) {
    return (
      <img
        src={url}
        alt={initials}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setErr(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: 'none', background: base.background as string }}
      />
    );
  }
  return <div style={base}>{initials}</div>;
}
