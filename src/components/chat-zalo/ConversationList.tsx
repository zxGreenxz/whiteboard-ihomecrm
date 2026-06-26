import type { ReactNode } from 'react';
import { Search, MessageSquarePlus, Zap, Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EMERALD } from './zaloTheme';
import ConversationRow from './ConversationRow';
import LabelFilter from './LabelFilter';
import type { ZaloConversation, FilterKey, ZaloLabel } from './types';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'unread', label: 'Chưa đọc' },
  { key: 'tenant', label: 'Khách trọ' },
  { key: 'lead', label: 'Lead' },
];

interface Props {
  conversations: ZaloConversation[];
  totalCount: number;
  activeId: string;
  filter: FilterKey;
  search: string;
  automationActive: number;
  automationRuns: number;
  onFilter: (f: FilterKey) => void;
  onSearch: (s: string) => void;
  onSelect: (id: string) => void;
  className?: string;
  /** Thanh chọn/kết nối tài khoản Zalo render trên cùng. */
  topSlot?: ReactNode;
  labels?: ZaloLabel[];
  selectedLabel?: number | null;
  onSelectLabel?: (id: number | null) => void;
  onBroadcast?: () => void;
}

/** Cột 1: danh sách hội thoại + tìm + lọc + footer tự động hoá. */
export default function ConversationList({
  conversations, totalCount, activeId, filter, search, automationActive, automationRuns,
  onFilter, onSearch, onSelect, className, topSlot,
  labels = [], selectedLabel = null, onSelectLabel, onBroadcast,
}: Props) {
  return (
    <section className={cn('flex-col flex-none bg-white border-r', className)}>
      {topSlot}
      {/* Header + search + chips */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid hsl(210 20% 93%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: '-.01em' }}>Hội thoại</h2>
            <span style={{ background: 'hsl(152 30% 94%)', color: 'hsl(152 69% 28%)', fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 8 }}>{totalCount}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={onBroadcast} title="Chia sẻ / Gửi hàng loạt" style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid hsl(210 20% 88%)', background: '#fff', color: EMERALD, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <Megaphone size={17} />
            </button>
            <button title="Soạn tin mới" style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid hsl(210 20% 88%)', background: '#fff', color: EMERALD, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <MessageSquarePlus size={17} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 11px', background: 'hsl(210 20% 96%)', borderRadius: 8, color: 'hsl(210 10% 50%)', marginBottom: 11 }}>
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Tìm theo tên, SĐT, mã phòng…"
            style={{ flex: 1, border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 13, color: 'hsl(160 30% 14%)' }}
          />
        </div>
        <div className="wz-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 2 }}>
          {FILTERS.map((f) => {
            const on = f.key === filter;
            return (
              <button
                key={f.key}
                onClick={() => onFilter(f.key)}
                style={{
                  background: on ? EMERALD : '#fff',
                  border: on ? 'none' : '1px solid hsl(210 20% 88%)',
                  color: on ? '#fff' : 'hsl(160 20% 30%)',
                  fontSize: 12, fontWeight: on ? 600 : 500, padding: '5px 12px', borderRadius: 8,
                  whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit', flex: 'none',
                }}
              >{f.label}</button>
            );
          })}
          {onSelectLabel && <LabelFilter labels={labels} selectedLabel={selectedLabel} onSelect={onSelectLabel} />}
        </div>
      </div>

      {/* List (giới hạn render để mượt với danh bạ lớn; lọc/tìm để thu hẹp) */}
      <div className="wz-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {conversations.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'hsl(210 10% 50%)', fontSize: 13 }}>
            Không có hội thoại phù hợp
          </div>
        ) : (
          <>
            {conversations.slice(0, 300).map((c) => (
              <ConversationRow key={c.id} conv={c} active={c.id === activeId} onSelect={onSelect} />
            ))}
            {conversations.length > 300 && (
              <div style={{ padding: '12px 16px', textAlign: 'center', color: 'hsl(210 10% 50%)', fontSize: 12 }}>
                Hiển thị 300/{conversations.length} — gõ tìm kiếm để thu hẹp
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer automation */}
      <div style={{ borderTop: '1px solid hsl(210 20% 93%)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, background: 'hsl(152 35% 97%)' }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: 'hsl(152 40% 92%)', color: 'hsl(152 69% 30%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Zap size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'hsl(152 69% 28%)' }}>Tự động hoá: {automationActive} luồng bật</div>
          <div style={{ fontSize: 11, color: 'hsl(210 10% 45%)' }}>Đã chạy {automationRuns} lượt hôm nay</div>
        </div>
      </div>
    </section>
  );
}
