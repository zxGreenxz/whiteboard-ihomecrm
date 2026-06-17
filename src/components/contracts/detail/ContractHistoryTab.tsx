import { Clock } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { formatCurrency } from '@/lib/utils';
import type { ContractHistoryItem } from './types';

const TYPE_LABEL: Record<string, string> = { extension: 'Gia hạn hợp đồng', transfer: 'Chuyển đổi', termination: 'Thanh lý' };
const TYPE_TONE: Record<string, string> = { extension: '#2563eb', transfer: '#7c3aed', termination: '#d6453f' };
const ST_LABEL: Record<string, string> = {
  DRAFT: 'Nháp', PENDING_APPROVAL: 'Chờ duyệt', APPROVED: 'Đã duyệt', COMPLETED: 'Hoàn thành', CANCELLED: 'Đã huỷ',
};

/** Tab "Lịch sử" — timeline .cd-tl trong 1 .cd-card. */
export function ContractHistoryTab({ history }: { history: ContractHistoryItem[] }) {
  if (!history.length) return <div className="stub">Chưa có lịch sử thay đổi.</div>;
  return (
    <div className="cd-card" style={{ marginBottom: 4 }}>
      <div className="cd-card-h"><span className="cd-card-t"><Clock size={16} />Nhật ký hợp đồng</span></div>
      <div className="cd-tl">
        {history.map((h, i) => {
          const tone = TYPE_TONE[h.type] ?? '#8d8678';
          let detail = '';
          if (h.type === 'extension' && h.details?.extension_months) {
            detail = ` ${h.details.extension_months} tháng`;
            if (h.details.new_rent_price) detail += ` · ${formatCurrency(h.details.new_rent_price)}`;
          }
          if (h.type === 'termination' && h.details?.termination_type) detail = ` · ${h.details.termination_type}`;
          if (h.type === 'transfer' && h.details?.transfer_type) detail = ` · ${String(h.details.transfer_type).replace('_', ' ')}`;
          return (
            <div className="cd-tl-it" key={i}>
              <span className="cd-tl-dot" style={{ background: tone }} />
              <div className="cd-tl-body">
                <div className="cd-tl-action">{(TYPE_LABEL[h.type] ?? h.type) + detail}</div>
                <div className="cd-tl-meta">{ST_LABEL[h.status] ?? h.status}{h.details?.notes ? ` · ${h.details.notes}` : ''}</div>
                <div className="cd-tl-when">{format(new Date(h.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
