import { Loader2, Link2, UserRound, FileSignature, DoorOpen, Target } from 'lucide-react';
import { EMERALD } from './zaloTheme';
import { useZaloCrmSummary } from '@/hooks/chat-zalo/useZaloCrmProfile';
import type { ZaloConversation } from './types';

interface Props {
  conv: ZaloConversation;
  onLinkCrm?: (c: ZaloConversation) => void;
}

const fmtMoney = (n?: number | null) => (n == null ? '—' : new Intl.NumberFormat('vi-VN').format(n) + ' đ');
const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 12.5 }}>
      <span style={{ color: 'hsl(210 10% 48%)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: 'hsl(160 30% 16%)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid hsl(210 20% 91%)', borderRadius: 12, padding: '10px 13px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'hsl(152 69% 28%)', marginBottom: 4 }}>
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

/** Hồ sơ CRM LIVE của hội thoại (khách hàng/lead/HĐ/phòng) — dữ liệu thật, không snapshot. */
export default function CrmInfoCard({ conv, onLinkCrm }: Props) {
  const linked = !!(conv.customerId || conv.leadId);
  const { data, isLoading, isError } = useZaloCrmSummary(conv.id, linked);

  return (
    <div style={{ padding: '14px 16px' }}>
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'hsl(210 10% 50%)', fontSize: 13, padding: '8px 0' }}>
          <Loader2 size={15} className="animate-spin" />Đang tải hồ sơ CRM…
        </div>
      )}
      {isError && <div style={{ fontSize: 12.5, color: 'hsl(0 60% 45%)', padding: '6px 0' }}>Không tải được hồ sơ CRM.</div>}

      {data?.customer && (
        <Card icon={<UserRound size={14} />} title="Khách hàng">
          <Row label="Họ tên" value={data.customer.full_name} />
          <Row label="SĐT" value={data.customer.phone} />
          {data.customer.customer_type && <Row label="Nhóm" value={data.customer.customer_type} />}
        </Card>
      )}
      {data?.lead && (
        <Card icon={<Target size={14} />} title="Lead">
          <Row label="Tên" value={data.lead.customer_name || '—'} />
          <Row label="SĐT" value={data.lead.phone} />
          {data.lead.status && <Row label="Trạng thái" value={data.lead.status} />}
          {data.lead.source && <Row label="Nguồn" value={data.lead.source} />}
          {(data.lead.budget_min || data.lead.budget_max) && (
            <Row label="Ngân sách" value={`${fmtMoney(data.lead.budget_min)} – ${fmtMoney(data.lead.budget_max)}`} />
          )}
          {data.lead.move_in_date && <Row label="Ngày dọn vào" value={fmtDate(data.lead.move_in_date)} />}
        </Card>
      )}
      {data?.contract && (
        <Card icon={<FileSignature size={14} />} title="Hợp đồng">
          <Row label="Số HĐ" value={data.contract.contract_number || '—'} />
          <Row label="Trạng thái" value={data.contract.status === 'ACTIVE' ? 'Đang hiệu lực' : (data.contract.status || '—')} />
          <Row label="Thời hạn" value={`${fmtDate(data.contract.start_date)} → ${fmtDate(data.contract.end_date)}`} />
          <Row label="Giá thuê" value={fmtMoney(data.contract.rent_price)} />
        </Card>
      )}
      {data?.room && (
        <Card icon={<DoorOpen size={14} />} title="Phòng">
          <Row label="Phòng" value={data.room.name || data.room.code || '—'} />
          {data.room.building_name && <Row label="Toà nhà" value={data.room.building_name} />}
          {data.room.floor != null && <Row label="Tầng" value={String(data.room.floor)} />}
        </Card>
      )}

      {onLinkCrm && (
        <button
          onClick={() => onLinkCrm(conv)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', padding: '8px 0', borderRadius: 10, border: `1px solid hsl(152 40% 82%)`, background: 'hsl(152 40% 96%)', color: EMERALD, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Link2 size={14} />
          {linked ? 'Đổi / tháo hồ sơ CRM' : 'Gắn hồ sơ CRM'}
        </button>
      )}
    </div>
  );
}
