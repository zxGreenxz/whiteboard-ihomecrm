import { Bell } from 'lucide-react';
import { avatarStyle, EMERALD } from './zaloTheme';
import { InfoCard, CardLabel, mono } from './infoCards';
import type { ZaloProfile } from './types';

/** Panel thông tin cho khách trọ (tenant). */
export default function TenantInfo({ p }: { p: ZaloProfile }) {
  const stf = p.staff;
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>
      {/* Phòng đang thuê */}
      <InfoCard style={{ borderLeft: '4px solid hsl(142 71% 45%)' }}>
        <CardLabel>Phòng đang thuê</CardLabel>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-.01em' }}>{p.room}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: EMERALD, ...mono() }}>{p.price}</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', marginTop: 3 }}>{p.roomSub}</div>
      </InfoCard>

      {/* Hợp đồng */}
      <InfoCard>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(210 10% 50%)' }}>Hợp đồng</span>
          <span style={{ background: 'hsl(138 76% 97%)', color: 'hsl(142 72% 29%)', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 7 }}>{p.contractStatus}</span>
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(160 30% 18%)', ...mono() }}>{p.contractCode}</div>
        <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', marginTop: 3 }}>{p.contractTerm}</div>
      </InfoCard>

      {/* Công nợ */}
      {p.debt && (
        <div style={{ border: '1px solid hsl(34 80% 86%)', background: 'hsl(34 100% 97%)', borderRadius: 12, padding: '13px 14px', borderLeft: '4px solid hsl(25 95% 53%)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(17 88% 40%)', marginBottom: 6 }}>Công nợ</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: 'hsl(17 88% 42%)', ...mono() }}>{p.debt.amount}</span>
            <span style={{ fontSize: 11.5, color: 'hsl(17 70% 48%)' }}>{p.debt.overdue}</span>
          </div>
          <div style={{ fontSize: 12, color: 'hsl(210 10% 45%)', marginTop: 3 }}>{p.debt.note}</div>
          <button style={{ marginTop: 10, width: '100%', height: 36, borderRadius: 8, border: 'none', background: 'hsl(25 95% 53%)', color: '#fff', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
            <Bell size={14} /> Gửi nhắc đóng tiền
          </button>
        </div>
      )}

      {/* Sự cố */}
      {p.issue && (
        <div style={{ border: '1px solid hsl(48 70% 80%)', background: 'hsl(55 97% 96%)', borderRadius: 12, padding: '13px 14px', borderLeft: '4px solid hsl(45 93% 47%)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(32 81% 32%)', marginBottom: 6 }}>Sự cố đang xử lý</div>
          <div style={{ fontSize: 12.5, color: 'hsl(160 30% 22%)', lineHeight: 1.45 }}>{p.issue.text}</div>
        </div>
      )}

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
            <button style={{ fontSize: 12, color: EMERALD, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Đổi</button>
          </div>
        </InfoCard>
      )}
    </div>
  );
}
