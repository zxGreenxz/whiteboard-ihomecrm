// Kiểm tra quanh quyết toán — CHỈ màn quản trị. Không đổi số quyết toán; chỉ làm lộ những chỗ có
// thể làm sai số: khoản chi cố định chưa có phiếu, phiếu ở toà khác có nhắc mã toà, phiếu chờ duyệt
// ghi ngày trước tháng áp dụng, và đối chiếu từng phiếu với KQKD toà (theo kỳ). Số lấy nguyên server.
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatVND } from '@/lib/utils';
import {
  BRIDGE_REASON_LABEL,
  fixedFeeLabel,
  type KqkdBridge,
  type SettlementWarnings,
} from '@/lib/landlordSettlement';

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

type WarningVoucher = SettlementWarnings['related_elsewhere']['vouchers'][number];

function VoucherLines({ rows, total }: { rows: WarningVoucher[]; total: number }) {
  return (
    <ul className="mt-1 divide-y rounded-md border bg-background text-xs">
      {rows.map((v, i) => (
        <li key={`${v.code ?? 'phieu'}-${i}`} className="flex justify-between gap-3 px-2 py-1.5">
          <span className="min-w-0">
            <span className="block truncate" title={v.name ?? ''}>{v.name || '(không tên)'}</span>
            <span className="text-muted-foreground">
              {fmtDay(v.voucher_date)}{v.code ? ` · ${v.code}` : ''}{v.building_name ? ` · toà ${v.building_name}` : ''}
              {v.type === 'INCOME' ? ' · thu' : ' · chi'}{v.status === 'UNAPPROVED' ? ' · chờ duyệt' : ''}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">{formatVND(v.amount)}</span>
        </li>
      ))}
      {total > rows.length && (
        <li className="px-2 py-1.5 text-muted-foreground">… và {total - rows.length} phiếu khác</li>
      )}
    </ul>
  );
}

export function SettlementWarningsBlock({ warnings }: { warnings: SettlementWarnings }) {
  const missing = warnings.missing_fixed_expenses;
  const rel = warnings.related_elsewhere;
  const pre = warnings.pre_start_pending;
  const soChuNha = warnings.landlord_account_elsewhere;
  if (missing.length === 0 && rel.voucher_count === 0 && soChuNha.voucher_count === 0 && (!pre || pre.voucher_count === 0)) return null;
  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/20"
      data-testid="settlement-warnings">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />Cần xem trước khi chốt
      </p>
      {missing.length > 0 && (
        <div>
          <p>Tháng này chưa có phiếu chi: <b>{missing.map(fixedFeeLabel).join(', ')}</b> — lợi nhuận có thể đang cao hơn thật.</p>
          <p className="text-xs text-muted-foreground">
            Theo "Phí cố định theo toà". Chủ nhà tự trả thì nhập phiếu chi vào sổ chủ nhà; khoản không áp dụng cho toà thì đánh dấu "không áp dụng" ở trang đó.
          </p>
        </div>
      )}
      {soChuNha.voucher_count > 0 && (
        <div>
          <p>
            {soChuNha.voucher_count} phiếu của toà khác ghi vào <b>sổ chủ nhà</b> của toà này — tiền trong sổ chủ nhà đổi mà quyết toán
            không thấy. Chuyển phiếu về đúng sổ trước khi chốt.
          </p>
          <VoucherLines rows={soChuNha.vouchers} total={soChuNha.voucher_count} />
        </div>
      )}
      {rel.voucher_count > 0 && (
        <div>
          <p>{rel.voucher_count} phiếu ở toà khác có nhắc tên toà này — <b>không tính</b> vào quyết toán. Nếu là của toà này, sửa toà trên phiếu.</p>
          <VoucherLines rows={rel.vouchers} total={rel.voucher_count} />
        </div>
      )}
      {pre && pre.voucher_count > 0 && (
        <div>
          <p>
            {pre.voucher_count} phiếu chờ duyệt ghi ngày trước tháng áp dụng (thu {formatVND(pre.income)} · chi {formatVND(pre.expense)}) —
            duyệt xong cũng không rơi vào tháng nào của quyết toán. Duyệt hoặc huỷ trước khi chốt tháng đầu tiên.
          </p>
          <VoucherLines rows={pre.vouchers} total={pre.voucher_count} />
        </div>
      )}
    </div>
  );
}

export function KqkdBridgeBlock({ bridge }: { bridge: KqkdBridge }) {
  const diff = bridge.kqkd_profit - bridge.settlement_profit;
  return (
    <details className="rounded-lg border p-3 text-sm" data-testid="settlement-kqkd-bridge">
      <summary className="cursor-pointer font-medium">
        Đối chiếu với KQKD toà (theo kỳ) ·{' '}
        {diff === 0
          ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />khớp</span>
          : <span className="text-amber-700 dark:text-amber-400">lệch {formatVND(diff)} ({bridge.rows.length} phiếu)</span>}
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Quyết toán tính theo <b>ngày phiếu</b> (tiền thực thu/chi, phiếu đã duyệt). KQKD / Chốt LN tính theo <b>kỳ</b> hoá đơn hoặc kỳ dịch vụ.
        Hai số chênh nhau đúng bằng các phiếu liệt kê dưới đây.
      </p>
      <dl className="mt-2 space-y-1">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Lợi nhuận quyết toán (theo ngày phiếu)</dt>
          <dd className="whitespace-nowrap tabular-nums">{formatVND(bridge.settlement_profit)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Lợi nhuận KQKD toà (theo kỳ)</dt>
          <dd className="whitespace-nowrap tabular-nums">{formatVND(bridge.kqkd_profit)}</dd>
        </div>
      </dl>
      {bridge.rows.length > 0 && (
        <div className="mt-2 overflow-x-auto rounded-md border">
          <table className="w-full min-w-[520px] text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Phiếu</th>
                <th className="px-2 py-1.5 text-left font-medium">Vì sao lệch</th>
                <th className="px-2 py-1.5 text-right font-medium">Quyết toán</th>
                <th className="px-2 py-1.5 text-right font-medium">KQKD</th>
              </tr>
            </thead>
            <tbody>
              {bridge.rows.map((r, i) => (
                <tr key={`${r.code ?? 'phieu'}-${i}`} className="border-t">
                  <td className="px-2 py-1.5">
                    <span className="block max-w-[220px] truncate" title={r.name ?? ''}>{r.name || '(không tên)'}</span>
                    <span className="text-muted-foreground">{fmtDay(r.voucher_date)}{r.code ? ` · ${r.code}` : ''}</span>
                  </td>
                  <td className="px-2 py-1.5">{BRIDGE_REASON_LABEL[r.reason]}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(r.settlement_amount)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(r.kqkd_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">Số có dấu: thu dương, chi âm.</p>
    </details>
  );
}
