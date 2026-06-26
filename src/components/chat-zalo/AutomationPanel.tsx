import { Image as ImageIcon, MessageSquare, Send } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import { mono } from './infoCards';
import type { ZaloAutomations } from './types';

interface Props {
  automations: ZaloAutomations;
  onToggle: (key: 'broadcastOn' | 'autoReplyOn') => void;
  templates: { title: string; color: string }[];
}

/** Công tắc gạt (toggle switch) port từ design. */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ position: 'relative', width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', flex: 'none', padding: 0, background: on ? 'hsl(152 69% 38%)' : 'hsl(210 16% 80%)', transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s' }} />
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'hsl(210 10% 45%)' }}>{label}</span>
      {children}
    </div>
  );
}

const KEYWORDS = ['giá', 'cọc', 'wifi', 'xem phòng'];

/** Tab "Tự động hoá": broadcast ảnh trống + auto-reply + thư viện mẫu tin. */
export default function AutomationPanel({ automations, onToggle, templates }: Props) {
  return (
    <div className="wz-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Gửi ảnh phòng trống */}
      <div style={{ border: '1px solid hsl(152 35% 84%)', background: 'hsl(152 40% 98%)', borderRadius: 12, padding: '13px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: EMERALD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><ImageIcon size={15} /></span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Gửi ảnh phòng trống</div>
              <div style={{ fontSize: 11, color: 'hsl(152 50% 35%)', fontWeight: 600 }}>{automations.broadcastOn ? 'Đang chạy' : 'Đã tắt'}</div>
            </div>
          </div>
          <Toggle on={automations.broadcastOn} onClick={() => onToggle('broadcastOn')} />
        </div>
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
          <Row label="Lịch gửi"><span style={{ fontWeight: 600, ...mono() }}>Mỗi giờ · 08–20h</span></Row>
          <Row label="Người nhận"><span style={{ fontWeight: 600 }}>8 môi giới</span></Row>
          <Row label="Lần gửi tiếp"><span style={{ background: 'hsl(214 95% 94%)', color: 'hsl(224 76% 46%)', fontWeight: 700, fontSize: 11.5, padding: '2px 8px', borderRadius: 7 }}>10:00 (52')</span></Row>
        </div>
      </div>

      {/* Tự động trả lời */}
      <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '13px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: 'hsl(214 95% 93%)', color: 'hsl(224 76% 48%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><MessageSquare size={15} /></span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Tự động trả lời</div>
              <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)' }}>Khách trọ &amp; lead</div>
            </div>
          </div>
          <Toggle on={automations.autoReplyOn} onClick={() => onToggle('autoReplyOn')} />
        </div>
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
          <Row label="Khung giờ"><span style={{ fontWeight: 600, ...mono() }}>22:00–07:00</span></Row>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ color: 'hsl(210 10% 45%)' }}>Từ khoá:</span>
            {KEYWORDS.map((k) => (
              <span key={k} style={{ background: 'hsl(210 20% 95%)', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6 }}>{k}</span>
            ))}
          </div>
          <Row label="Hôm nay"><span style={{ color: EMERALD, fontWeight: 700 }}>đã trả lời 24 tin</span></Row>
        </div>
      </div>

      {/* Thư viện mẫu tin */}
      <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '13px 14px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>Thư viện mẫu tin</span>
          <span style={{ fontSize: 11.5, color: EMERALD, fontWeight: 600, cursor: 'pointer' }}>+ Thêm</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {templates.map((t) => (
            <div key={t.title} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderTop: '1px solid hsl(210 20% 94%)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flex: 'none' }} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>{t.title}</span>
              <Send size={16} color={EMERALD} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
