import { CalendarDays } from 'lucide-react';
import { avatarStyle, EMERALD } from './zaloTheme';
import { InfoCard, CardLabel, mono } from './infoCards';
import type { ZaloProfile } from './types';

const STAGES = ['Mới', 'Liên hệ', 'Quan tâm', 'Hẹn xem'];

/** Panel thông tin cho khách hẹn (lead). */
export default function LeadInfo({ p }: { p: ZaloProfile }) {
  const stf = p.staff;
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
      {/* Phòng quan tâm */}
      <div style={{ border: '1px solid hsl(214 60% 85%)', background: 'hsl(214 95% 98%)', borderRadius: 12, padding: '13px 14px', borderLeft: '4px solid hsl(214 90% 56%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(210 10% 50%)' }}>Phòng quan tâm</span>
          <span style={{ background: 'hsl(138 76% 97%)', color: 'hsl(142 72% 29%)', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6 }}>Còn trống</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{p.room}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: EMERALD, ...mono() }}>{p.price}</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', marginTop: 3 }}>{p.roomSub}</div>
      </div>

      {/* Pipeline */}
      <InfoCard>
        <CardLabel style={{ marginBottom: 10 }}>Giai đoạn (pipeline)</CardLabel>
        <div style={{ display: 'flex', gap: 5 }}>
          {STAGES.map((s) => {
            const on = s === p.stage;
            return (
              <span key={s} style={{ flex: 1, textAlign: 'center', fontSize: 10.5, fontWeight: on ? 700 : 500, padding: '5px 2px', borderRadius: 6, background: on ? 'hsl(214 95% 93%)' : 'hsl(210 20% 96%)', color: on ? 'hsl(224 76% 46%)' : 'hsl(210 10% 50%)' }}>{s}</span>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12.5 }}>
          <span style={{ color: 'hsl(210 10% 45%)' }}>Nguồn</span>
          <span style={{ fontWeight: 600 }}>{p.source}</span>
        </div>
      </InfoCard>

      {/* Nhân viên phụ trách */}
      {stf && (
        <InfoCard>
          <CardLabel style={{ marginBottom: 9 }}>Nhân viên phụ trách</CardLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={avatarStyle(stf.tone, 32, 12)}>{stf.initials}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{stf.name}</div>
              <div style={{ fontSize: 11.5, color: 'hsl(210 10% 45%)' }}>{stf.role}</div>
            </div>
          </div>
        </InfoCard>
      )}

      <button style={{ width: '100%', height: 40, borderRadius: 9, border: '1px solid hsl(214 70% 80%)', background: 'hsl(214 95% 96%)', color: 'hsl(224 76% 46%)', fontWeight: 600, fontSize: 13, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer' }}>
        <CalendarDays size={15} /> Tạo lịch hẹn xem phòng
      </button>
    </div>
  );
}
