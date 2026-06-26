import { Image as ImageIcon } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import { InfoCard, CardLabel, mono } from './infoCards';
import type { ZaloProfile } from './types';

/** Panel thông tin cho môi giới (broker). */
export default function BrokerInfo({ p }: { p: ZaloProfile }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
      {/* CTV */}
      <div style={{ border: '1px solid hsl(269 50% 88%)', background: 'hsl(269 100% 98.5%)', borderRadius: 12, padding: '13px 14px', borderLeft: '4px solid hsl(273 67% 55%)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(210 10% 50%)', marginBottom: 6 }}>Cộng tác viên môi giới</div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{p.company}</div>
        <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', marginTop: 2, ...mono() }}>{p.phone}</div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        {(p.stats || []).map((st) => (
          <div key={st.label} style={{ flex: 1, border: '1px solid hsl(210 20% 90%)', borderRadius: 11, padding: '11px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: EMERALD, ...mono() }}>{st.value}</div>
            <div style={{ fontSize: 10.5, color: 'hsl(210 10% 45%)', marginTop: 2 }}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Đang chào khách */}
      <InfoCard>
        <CardLabel style={{ marginBottom: 6 }}>Đang chào khách</CardLabel>
        <div style={{ fontSize: 12.5, color: 'hsl(160 30% 22%)', fontWeight: 500 }}>{p.rooms}</div>
      </InfoCard>

      <button style={{ width: '100%', height: 40, borderRadius: 9, border: 'none', background: EMERALD, color: '#fff', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer', boxShadow: '0 5px 12px -5px hsl(152 69% 31% / .6)' }}>
        <ImageIcon size={15} /> Gửi bảng phòng trống
      </button>
    </div>
  );
}
