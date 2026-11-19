// Danh sách phiếu đứng sau từng con số của bảng quyết toán, chia theo nhóm để chủ
// nhà và quản lý đối chiếu được với sổ của mình. Mọi dòng server trả về đều thuộc ít
// nhất một tab — kể cả dòng không tính (nội bộ, tắt KQKD) — để không khoản nào biến mất.
// Giao diện v3: bốn nhóm thu/chi hiện ở thẻ Khoản thu / Khoản chi (tab Thu chi); các nhóm còn lại
// (thanh lý, cọc, chờ duyệt, không tính) hiện ở khối "Khoản khác" bằng chính thành phần này (`only`).
import { useMemo, useState } from 'react';
import { formatVND } from '@/lib/utils';
import {
  settlementVoucherName,
  voucherRowNote,
  type DepositHolder,
  type SettlementStatement,
  type SettlementVoucher,
  type VoucherGroupKey,
} from '@/lib/landlordSettlement';

export type GroupKey = VoucherGroupKey;

/** Dòng "Cộng" lấy đúng số tổng server đã tính — client không cộng tiền. */
const SERVER_TOTAL: Partial<Record<GroupKey, keyof SettlementStatement['totals']>> = {
  landlord_in: 'landlord_collected',
  manager_in: 'manager_collected',
  landlord_out: 'landlord_paid',
  manager_out: 'manager_paid',
};

/** Bên sổ có cọc tính vào quyết toán: quản lý giữ cọc ⇒ cọc ở sổ chủ nhà phải bàn giao, và ngược lại. */
const countedDepositSide = (holder: DepositHolder): SettlementVoucher['side'] => (holder === 'MANAGER' ? 'LANDLORD' : 'MANAGER');

const GROUPS: { key: GroupKey; label: string; match: (v: SettlementVoucher, holder: DepositHolder) => boolean }[] = [
  { key: 'landlord_in', label: 'Chủ nhà thu', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'INCOME' && v.side === 'LANDLORD' },
  { key: 'manager_in', label: 'Quản lý thu', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'INCOME' && v.side === 'MANAGER' },
  { key: 'landlord_out', label: 'Chủ nhà chi', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'EXPENSE' && v.side === 'LANDLORD' },
  { key: 'manager_out', label: 'Quản lý chi', match: (v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === 'EXPENSE' && v.side === 'MANAGER' },
  // Lát cắt khác của cùng các dòng trên + dòng cọc: mọi phiếu do thanh lý hợp đồng sinh ra.
  { key: 'termination', label: 'Thanh lý', match: (v) => v.source !== null },
  { key: 'deposit', label: 'Cọc & trả thừa', match: (v) => v.group === 'DEPOSIT' },
  // Đúng tập server đếm ở "phiếu chờ duyệt" (chặn chốt).
  { key: 'pending', label: 'Chờ duyệt', match: (v, holder) => v.status === 'UNAPPROVED'
    && (v.group === 'PNL' || (v.group === 'DEPOSIT' && v.side === countedDepositSide(holder))) },
  { key: 'excluded', label: 'Không tính', match: (v) => v.group === 'EXCLUDED' },
];

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Link chủ nhà: tên sổ đã là nhãn bên giữ tiền ('Sổ chủ nhà' / 'Sổ quản lý' / 'Cấn trừ cọc') — in nguyên. */
const accountText = (name: string, mode: 'admin' | 'public') => (mode === 'public' ? name : `sổ ${name}`);

export function VoucherBreakdown({
  vouchers, totals, mode, periodMonth, only, depositHolder = 'MANAGER', title = 'Phiếu trong tháng',
}: {
  vouchers: SettlementVoucher[];
  totals: SettlementStatement['totals'];
  mode: 'admin' | 'public';
  /** 'YYYY-MM-DD' — tháng của bảng quyết toán (để ghi chú phiếu lập tháng khác mà tính theo kỳ tháng này). */
  periodMonth: string;
  /** Chỉ hiện các nhóm này (mặc định: mọi nhóm). */
  only?: readonly GroupKey[];
  /** Người giữ cọc của tháng — quyết định cọc chờ duyệt ở sổ nào thuộc nhóm "Chờ duyệt". */
  depositHolder?: DepositHolder;
  title?: string;
}) {
  const grouped = useMemo(
    () => GROUPS.filter((g) => !only || only.includes(g.key))
      .map((g) => ({ ...g, rows: vouchers.filter((v) => g.match(v, depositHolder)) })),
    [vouchers, only, depositHolder],
  );
  const firstNonEmpty = grouped.find((g) => g.rows.length > 0)?.key ?? grouped[0]?.key ?? 'landlord_in';
  const [active, setActive] = useState<GroupKey | null>(null);
  const current = grouped.find((g) => g.key === (active ?? firstNonEmpty)) ?? grouped[0];
  if (!current) return null;
  const totalKey = SERVER_TOTAL[current.key];

  return (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
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
          {current.rows.map((v, i) => {
            const shown = settlementVoucherName(v, mode);
            return (
            <div key={`${v.code ?? 'phieu'}-${v.group}-${i}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
              {/* màn quản trị: rê chuột thấy tên gốc của phiếu (có mã); link chủ nhà: đúng tên đang hiện */}
              <span className="min-w-0 truncate" title={mode === 'admin' ? (v.name ?? '') : shown} data-testid="settlement-voucher-name">
                {shown}
              </span>
              <span className="text-right font-medium tabular-nums">{formatVND(v.amount)}</span>
              <span className="text-xs text-muted-foreground">
                {fmtDay(v.voucher_date)}{v.code ? ` · ${v.code}` : ''}{v.account_name ? ` · ${accountText(v.account_name, mode)}` : ''}
                {voucherRowNote(v, current.key, mode, periodMonth)}
              </span>
              <span />
            </div>
            );
          })}
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
