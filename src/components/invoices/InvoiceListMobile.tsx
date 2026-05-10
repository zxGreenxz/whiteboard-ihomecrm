import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/ui/EmptyState';
import { Receipt } from 'lucide-react';
import type { InvoiceWithRelations, InvoiceStatus } from '@/types/invoice';

interface Props {
  invoices: InvoiceWithRelations[];
  isLoading: boolean;
  onViewDetail: (invoice: InvoiceWithRelations) => void;
}

const formatCompact = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'tỷ';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'tr';
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toLocaleString('vi-VN');
};

interface StatusStyle {
  label: string;
  accent: string;
  badge: string;
  amount: string;
}

const STATUS: Record<InvoiceStatus, StatusStyle> = {
  PAID: {
    label: 'Đã thu',
    accent: '#10b981',
    badge: 'bg-emerald-100 text-emerald-700',
    amount: 'text-emerald-600',
  },
  PARTIAL_PAID: {
    label: 'Một phần',
    accent: '#3b82f6',
    badge: 'bg-blue-100 text-blue-700',
    amount: 'text-blue-600',
  },
  OVERDUE: {
    label: 'Quá hạn',
    accent: '#ef4444',
    badge: 'bg-red-100 text-red-700',
    amount: 'text-red-600',
  },
  APPROVED: {
    label: 'Đã duyệt',
    accent: '#0ea5e9',
    badge: 'bg-sky-100 text-sky-700',
    amount: 'text-zinc-900',
  },
  DRAFT: {
    label: 'Nháp',
    accent: '#a1a1aa',
    badge: 'bg-zinc-100 text-zinc-600',
    amount: 'text-zinc-900',
  },
  CANCELLED: {
    label: 'Đã huỷ',
    accent: '#a1a1aa',
    badge: 'bg-zinc-100 text-zinc-600',
    amount: 'text-zinc-500',
  },
};

const formatBillingMonth = (m: string | null | undefined) => {
  if (!m) return null;
  const [year, month] = m.split('-');
  if (!year || !month) return m;
  return `Th${parseInt(month, 10)}/${year}`;
};

export function InvoiceListMobile({ invoices, isLoading, onViewDetail }: Props) {
  if (isLoading) {
    return (
      <div className="px-3 py-3 space-y-2.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={Receipt}
          title="Chưa có hoá đơn nào"
          description="Hãy tạo hoá đơn đầu tiên hoặc nới bộ lọc."
        />
      </div>
    );
  }

  return (
    <ul role="list" className="px-3 py-3 space-y-2.5 pb-24">
      {invoices.map((inv) => {
        const status = STATUS[inv.status] ?? STATUS.DRAFT;
        const isCancelled = inv.status === 'CANCELLED';
        const buildingName = inv.building?.name?.trim();
        const roomName = inv.room?.name?.trim();
        const voucherTitle =
          buildingName && roomName
            ? `${buildingName} - ${roomName}`
            : roomName || buildingName || '—';
        const billingLabel = formatBillingMonth(inv.billing_month);

        return (
          <li key={inv.id}>
            <article
              role="button"
              tabIndex={0}
              onClick={() => onViewDetail(inv)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onViewDetail(inv);
                }
              }}
              className={`relative bg-white border border-zinc-200 rounded-xl p-3.5 shadow-sm active:scale-[0.985] active:shadow-none transition-transform cursor-pointer ${
                isCancelled ? 'opacity-60' : ''
              }`}
              style={{ borderLeft: `3px solid ${status.accent}` }}
            >
              {/* Row 1: Toà nhà - Phòng + (status badge nếu khác Đã duyệt) + tổng tiền */}
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="font-medium text-sm text-zinc-900 truncate">
                    {voucherTitle}
                  </span>
                  {/* Mặc định mọi hoá đơn = Đã duyệt → ẩn badge này, chỉ hiện
                      khi trạng thái khác (Nháp/Một phần/Đã thu/Quá hạn/Đã huỷ) */}
                  {inv.status !== 'APPROVED' && (
                    <span
                      className={`px-2 py-0.5 text-[11px] font-medium rounded-full ${status.badge}`}
                    >
                      {status.label}
                    </span>
                  )}
                </div>
                <span
                  className={`shrink-0 text-[15px] font-bold tabular-nums ${status.amount}`}
                >
                  {formatCompact(inv.total_amount)}
                </span>
              </div>

              {/* Row 2: kỳ · đã thu */}
              <div className="flex items-center justify-between gap-2 text-[12px] text-zinc-400">
                <span className="truncate min-w-0">
                  {billingLabel ? `Kỳ ${billingLabel}` : '—'}
                </span>
                <span className="shrink-0 tabular-nums">
                  Đã thu {formatCompact(inv.paid_amount)}
                </span>
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default InvoiceListMobile;
