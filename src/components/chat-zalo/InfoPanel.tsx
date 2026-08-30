import { User, Settings, BadgeCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { tagStyle, EMERALD } from './zaloTheme';
import ZaloAvatar from './ZaloAvatar';
import { mono } from './infoCards';
import BrokerInfo from './BrokerInfo';
import ZaloContactInfo from './ZaloContactInfo';
import CrmInfoCard from './CrmInfoCard';
import AutomationPanel from './AutomationPanel';
import { useMarkSalePartner } from '@/hooks/useZaloChat';
import type { ZaloConversation, ZaloAutomations, RightTab } from './types';

interface Props {
  conv: ZaloConversation;
  tab: RightTab;
  onTab: (t: RightTab) => void;
  automations: ZaloAutomations;
  onToggle: (key: 'broadcastOn' | 'autoReplyOn') => void;
  templates: { title: string; color: string }[];
  /** Toàn bộ hội thoại — tab Tự động hoá cần để đối chiếu người nhận đã lưu. */
  conversations: ZaloConversation[];
  /** Mở màn cài đặt tự động hoá đầy đủ (dialog nằm ở trang, không nằm ở cột này). */
  onOpenSettings: () => void;
  className?: string;
  /** mở dialog gắn/tháo hồ sơ CRM */
  onLinkCrm?: (c: ZaloConversation) => void;
}

/** Công tắc "hội thoại này là sale/môi giới".
 *
 *  VÌ SAO NẰM Ở ĐÂY chứ không ở màn cài đặt tự động hoá: cờ này là thuộc tính
 *  của MỘT hội thoại, và người ta chỉ biết ai là môi giới khi đang đọc đúng
 *  cuộc trò chuyện đó. Nó cũng là điều kiện cổng của cả hai tính năng tự động —
 *  RecipientPicker chỉ liệt kê nhóm và hội thoại đã bật cờ này, còn auto-reply
 *  chỉ trả lời những hội thoại đã bật. Khách đang thuê phòng không bao giờ nhận
 *  bản tin rao phòng, và đó là do cái công tắc này. */
function HangSale({ conv }: { conv: ZaloConversation }) {
  const danhDau = useMarkSalePartner();
  const bat = conv.isSalePartner;
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid hsl(210 20% 93%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: bat ? 'hsl(152 40% 92%)' : 'hsl(210 20% 95%)', color: bat ? EMERALD : 'hsl(210 10% 50%)' }}>
            <BadgeCheck size={15} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Sale / Môi giới</span>
        </div>
        <Switch
          checked={bat}
          disabled={danhDau.isPending}
          onCheckedChange={(v) => danhDau.mutate({ conversationId: conv.id, isSale: v })}
          aria-label="Đánh dấu hội thoại là sale/môi giới"
        />
      </div>
      <p style={{ fontSize: 11.5, color: 'hsl(210 10% 50%)', margin: '6px 0 0', lineHeight: 1.5 }}>
        Bật để hội thoại này nhận tin phòng trống định kỳ và được tự động trả lời.
      </p>
    </div>
  );
}

function tabBtn(on: boolean, hasText: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: hasText ? '0 11px' : '0 9px',
    border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
    background: on ? '#fff' : 'transparent', color: on ? 'hsl(152 69% 30%)' : 'hsl(210 10% 45%)',
    boxShadow: on ? '0 1px 3px rgba(16,24,40,.14)' : 'none',
  };
}

/** Cột 3: tabs Thông tin / Tự động hoá. */
export default function InfoPanel({ conv, tab, onTab, automations, onToggle, templates, conversations, onOpenSettings, className, onLinkCrm }: Props) {
  const p = conv.profile;
  // Rẽ nhánh theo FK LIVE (customer_id/lead_id do matcher/gắn tay set) — snapshot
  // profile.kind chỉ còn cho 'broker' (legacy) và nhóm/danh bạ chưa gắn.
  const linkedCrm = !!(conv.customerId || conv.leadId);
  return (
    <section className={cn('flex-col flex-none bg-white border-l overflow-hidden', className)}>
      {/* Tabs header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid hsl(210 20% 93%)', flex: 'none' }}>
        <span style={{ fontSize: 14.5, fontWeight: 700 }}>{tab === 'auto' ? 'Tự động hoá' : 'Thông tin khách'}</span>
        <div style={{ display: 'flex', gap: 3, background: 'hsl(210 20% 95%)', padding: 3, borderRadius: 9 }}>
          <button onClick={() => onTab('info')} style={tabBtn(tab === 'info', true)}><User size={14} />Thông tin</button>
          <button onClick={() => onTab('auto')} title="Tự động hoá" style={tabBtn(tab === 'auto', false)}><Settings size={15} /></button>
        </div>
      </div>

      {tab === 'info' ? (
        <div className="wz-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {/* Customer header */}
          <div style={{ padding: '20px 18px 14px', textAlign: 'center', borderBottom: '1px solid hsl(210 20% 93%)' }}>
            <div style={{ margin: '0 auto', width: 'fit-content' }}><ZaloAvatar url={conv.avatarUrl} initials={conv.initials} tone={conv.tone} size={72} fontSize={24} /></div>
            <div style={{ fontSize: 16.5, fontWeight: 700, marginTop: 10 }}>{conv.name}</div>
            <div style={{ fontSize: 12.5, color: 'hsl(210 10% 45%)', marginTop: 2, ...mono() }}>{conv.phone}</div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {(p.tags || []).map((t) => (
                <span key={t.l} style={tagStyle(t.t, { fontWeight: 600 })}>{t.l}</span>
              ))}
            </div>
          </div>
          {/* Đặt ngay dưới đầu trang, TRƯỚC mọi nhánh hồ sơ: cờ sale áp dụng cho
              mọi loại hội thoại (nhóm, danh bạ, khách đã gắn CRM), nên nó không
              được nằm trong một nhánh mà nhánh khác lại không có. */}
          <HangSale conv={conv} />
          {linkedCrm ? (
            <CrmInfoCard conv={conv} onLinkCrm={onLinkCrm} />
          ) : p.kind === 'broker' ? (
            <BrokerInfo p={p} />
          ) : (
            <>
              <ZaloContactInfo conv={conv} />
              {!conv.isGroup && <CrmInfoCard conv={conv} onLinkCrm={onLinkCrm} />}
            </>
          )}
        </div>
      ) : (
        <AutomationPanel
          automations={automations}
          onToggle={onToggle}
          templates={templates}
          conversations={conversations}
          onOpenSettings={onOpenSettings}
        />
      )}
    </section>
  );
}
