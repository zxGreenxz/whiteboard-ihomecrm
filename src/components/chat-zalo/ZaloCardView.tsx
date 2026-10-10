import { useState } from 'react';
import { IdCard, Link2 } from 'lucide-react';
import { tenTrang } from '@/lib/zaloContent';
import type { ZaloCard } from './types';

/**
 * Thân của tin dạng thẻ: link có ảnh xem trước, danh thiếp, thẻ khác. Ảnh nhỏ là link máy chủ
 * Zalo nên có thể đã hết hạn — lỗi thì thay bằng biểu tượng, không để ảnh vỡ.
 */
export default function ZaloCardView({ card }: { card: ZaloCard }) {
  const [anhLoi, setAnhLoi] = useState(false);
  const site = tenTrang(card.href);
  const danhThiep = card.kind === 'contact';
  const tieuDe = card.title || card.description || site || (danhThiep ? 'Danh thiếp Zalo' : 'Tin dạng thẻ');
  const dongPhu = danhThiep ? 'Danh thiếp Zalo' : card.title ? card.description : null;
  const Icon = danhThiep ? IdCard : Link2;

  const than = (
    <div style={{ display: 'flex', flexDirection: danhThiep ? 'row' : 'column', alignItems: danhThiep ? 'center' : 'stretch', gap: danhThiep ? 10 : 0, padding: danhThiep ? '10px 12px' : 0 }}>
      {card.thumb && !anhLoi ? (
        <img
          src={card.thumb}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setAnhLoi(true)}
          style={danhThiep
            ? { width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flex: 'none' }
            : { width: '100%', maxHeight: 150, objectFit: 'cover', display: 'block', borderBottom: '1px solid hsl(210 20% 90%)' }}
        />
      ) : danhThiep ? (
        <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'hsl(152 40% 94%)', color: 'hsl(152 69% 30%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Icon size={18} />
        </span>
      ) : null}
      <div style={{ padding: danhThiep ? 0 : '9px 12px', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'hsl(160 30% 14%)', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{tieuDe}</div>
        {dongPhu && (
          <div style={{ fontSize: 12.5, color: 'hsl(210 10% 40%)', marginTop: 2, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{dongPhu}</div>
        )}
        {site && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'hsl(152 50% 32%)', marginTop: 4 }}>
            <Link2 size={12} />{site}
          </div>
        )}
      </div>
    </div>
  );

  return card.href ? (
    <a href={card.href} target="_blank" rel="noopener noreferrer" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
      {than}
    </a>
  ) : than;
}
