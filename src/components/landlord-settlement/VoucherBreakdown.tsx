// Danh sách phiếu đứng sau từng con số của bảng quyết toán, chia theo nhóm để chủ
// nhà và quản lý đối chiếu được với sổ của mình. Mọi dòng server trả về đều thuộc ít
// nhất một tab — kể cả dòng không tính (nội bộ, tắt KQKD) — để không khoản nào biến mất.
import { useMemo, useState } from 'react';
import { formatVND } from '@/lib/utils';
import {
  EXCLUDED_REASON_LABEL,
  VOUCHER_SOURCE_LABEL,
  type SettlementStatement,
  type SettlementVoucher,
} from '@/lib/landlordSettlement';

type GroupKey =
  | 'landlord_in' | 'manager_in' | 'landlord_out' | 'manager_out'
  | 'termination' | 'deposit' | 'pending' | 'excluded';

/** Dòng "Cộng" lấy đúng số tổng server đã tính — client không cộng tiền. */
const SERVER_TOTAL: Partial<Record<GroupKey, keyof SettlementStatement['totals']>> = {
  landlord_in: 'landlord_collected',
  manager_in: 'manager_collected',
  landlord_out: 'landlord_paid',
  manager_out: 'manager_paid',
};

const GROUPS: { key: GroupKey; label: string; match: (v: SettlementVoucher) => boolean }[] = [
  { key: 'landlord_in', label: 'Chủ nhà thu', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'INCOME' && v.side === 'LANDLORD' },
  { key: 'manager_in', label: 'Quản lý thu', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'INCOME' && v.side === 'MANAGER' },
  { key: 'landlord_out', label: 'Chủ nhà chi', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'EXPENSE' && v.side === 'LANDLORD' },
  { key: 'manager_out', label: 'Quản lý chi', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'EXPENSE' && v.side === 'MANAGER' },
  // Lát cắt khác của cùng các dòng trên + dòng cọc: mọi phiếu do thanh lý hợp đồng sinh ra.
  { key: 'termination', label: 'Thanh lý', match: (v) => v.source !== null },
  { key: 'deposit', label: 'Cọc & trả thừa', match: (v) => v.group === 'DEPOSIT' },
  // Đúng tập server đếm ở "phiếu chờ duyệt" (chặn chốt).
  { key: 'pending', label: 'Chờ duyệt', match: (v) => v.status === 'UNAPPROVED' && (v.group === 'PNL' || (v.group === 'DEPOSIT' && v.side === 'LANDLORD')) },
  { key: 'excluded', label: 'Không tính', match: (v) => v.group === 'EXCLUDED' },
];

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Link chủ nhà: tên sổ đã là nhãn bên giữ tiền ('Sổ chủ nhà' / 'Sổ quản lý' / 'Cấn trừ cọc') — in nguyên. */
const accountText = (name: string, mode: 'admin' | 'public') => (mode === 'public' ? name : `sổ ${name}`);

function rowNote(v: SettlementVoucher, key: GroupKey, mode: 'admin' | 'public', periodMonth: string): string {
  const parts: string[] = [];
  // dòng lãi lỗ xếp tháng THEO KỲ trên hạng mục: phiếu lập tháng khác vẫn có thể thuộc tháng này (vd thu
  // trước tiền phòng tháng sau). Số tiền là phần của kỳ tháng này.
  if (v.group === 'PNL' && v.voucher_date.slice(0, 7) !== periodMonth.slice(0, 7)) {
    parts.push(`tính theo kỳ tháng ${periodMonth.slice(5, 7)}/${periodMonth.slice(0, 4)}`);
  }
  if (v.source) parts.push(VOUCHER_SOURCE_LABEL[v.source]);
  if (key === 'termination' || key === 'deposit' || key === 'pending' || key === 'excluded') {
    if (v.group === 'DEPOSIT') parts.push(v.type === 'INCOME' ? 'thu cọc/trả thừa' : 'hoàn/cấn cọc');
    else if (v.group === 'PNL') parts.push(v.type === 'INCOME' ? 'doanh thu' : 'chi phí');
    // link chủ nhà: tên sổ đã là nhãn bên giữ tiền thì không nhắc lại
    if (mode === 'admin' || !v.account_name) parts.push(v.side === 'LANDLORD' ? 'sổ chủ nhà' : 'sổ quản lý');
  }
  if (v.excluded_reason) parts.push(`không tính: ${EXCLUDED_REASON_LABEL[v.excluded_reason]}`);
  if (v.cash_reversed) parts.push('bút toán sổ quỹ đã bị đảo');
  if (v.cash_unposted) parts.push('chưa ghi sổ quỹ');
  if (v.foreign_landlord_account) parts.push('sổ chủ nhà của toà khác — chặn chốt');
  if (v.status === 'UNAPPROVED') parts.push('chờ duyệt');
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export function VoucherBreakdown({ vouchers, totals, mode, periodMonth }: {
  vouchers: SettlementVoucher[];
  totals: SettlementStatement['totals'];
  mode: 'admin' | 'public';
  /** 'YYYY-MM-DD' — tháng của bảng quyết toán (để ghi chú phiếu lập tháng khác mà tính theo kỳ tháng này). */
  periodMonth: string;
}) {
  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, rows: vouchers.filter(g.match) })),
    [vouchers],
  );
  const firstNonEmpty = grouped.find((g) => g.rows.length > 0)?.key ?? 'landlord_in';
  const [active, setActive] = useState<GroupKey | null>(null);
  const current = grouped.find((g) => g.key === (active ?? firstNonEmpty)) ?? grouped[0];
  const totalKey = SERVER_TOTAL[current.key];

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Phiếu trong tháng</p>
      <div role="tablist" aria-label="Nhóm phiếu" className="mb-2 flex flex-wrap gap-1.5">
        {grouped.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={g.key === current.key}
            onClick={() => setActive(g.key)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              g.key === current.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            {g.label} ({g.rows.length})
          </button>
        ))}
      </div>
      {current.rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">Không có phiếu.</p>
      ) : (
        <div className="divide-y rounded-lg border" role="tabpanel">
          {current.rows.map((v, i) => (
            <div key={`${v.code ?? 'phieu'}-${v.group}-${i}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
              <span className="min-w-0 truncate" title={v.name ?? ''}>{v.name || '(không tên)'}</span>
              <span className="text-right font-medium tabular-nums">{formatVND(v.amount)}</span>
              <span className="text-xs text-muted-foreground">
                {fmtDay(v.voucher_date)}{v.code ? ` · ${v.code}` : ''}{v.account_name ? ` · ${accountText(v.account_name, mode)}` : ''}
                {rowNote(v, current.key, mode, periodMonth)}
              </span>
              <span />
            </div>
          ))}
          {totalKey && (
            <div className="flex justify-between bg-muted/40 px-3 py-2 text-sm font-medium">
              <span>Cộng</span>
              <span className="tabular-nums">{formatVND(totals[totalKey])}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
