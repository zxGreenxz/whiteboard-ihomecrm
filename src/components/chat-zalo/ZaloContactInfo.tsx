import { InfoCard, CardLabel, mono } from './infoCards';
import type { ZaloConversation } from './types';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: 'hsl(210 10% 45%)' }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{children}</span>
    </div>
  );
}

/** Panel thông tin cho danh bạ / nhóm Zalo thật (chưa phân loại tenant/lead/broker). */
export default function ZaloContactInfo({ conv }: { conv: ZaloConversation }) {
  const p = conv.profile;
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
      <InfoCard>
        <CardLabel>Thông tin Zalo</CardLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Row label="Loại">{p.isGroup ? 'Nhóm Zalo' : 'Bạn bè Zalo'}</Row>
          {p.isGroup && p.members ? <Row label="Thành viên">{p.members}</Row> : null}
          {!p.isGroup && conv.phone ? <Row label="SĐT"><span style={mono()}>{conv.phone}</span></Row> : null}
        </div>
        {p.desc ? (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid hsl(210 20% 94%)', fontSize: 12.5, color: 'hsl(160 30% 22%)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{p.desc}</div>
        ) : null}
      </InfoCard>
      <div style={{ fontSize: 11.5, color: 'hsl(210 10% 55%)', textAlign: 'center', lineHeight: 1.5 }}>
        Liên kết hồ sơ CRM (khách trọ / lead / môi giới) sẽ bổ sung sau để hiện hợp đồng, công nợ…
      </div>
    </div>
  );
}
