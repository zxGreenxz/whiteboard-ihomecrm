import { useState } from "react";
import { ShieldCheck, AlertTriangle, ChevronDown, Info } from "lucide-react";
import { useProfitVerification } from "@/hooks/useProfitVerification";

/**
 * B5 (thống nhất tài chính 04/07): thanh KIỂM CHỨNG của trang Phân bổ lợi
 * nhuận — desktop + mobile DÙNG CHUNG. Trả lời trực diện nỗi đau của chủ:
 * "nhìn bảng phân bổ không chắc có đủ/thiếu gì không".
 *
 *  1. Tổng thẻ = Σ dòng hiển thị? (± phần dòng đang ẩn bởi "hạng mục đặc biệt")
 *  2. Đã LOẠI những gì khỏi P&L: phiếu nháp · khoản ngoài-KQKD · phiếu chưa chọn sổ.
 *  3. Khớp engine chia cổ đông (fa_monthly_pnl_accrual) — lệch ≠ 0 là ĐỎ.
 *  4. Đối chiếu tiền đã thu của hoá đơn kỳ (thông tin, lệch là bình thường).
 *
 * Mọi con số lấy từ RPC aggregate server-side — không dính cap 1000.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("vi-VN") + " đ";

export interface ProfitVerificationBarProps {
  ym: string; // 'YYYY-MM'
  startDate: string;
  endDate: string;
  buildingIds?: string[];
  monthLabel: string;
  accrualMode: boolean;
  pnlOnly: boolean;
  /** Số ở 3 thẻ (nguồn tổng). */
  totalIncome: number;
  totalExpense: number;
  /** Σ các dòng ĐANG hiển thị trong 2 cột (sau khi ẩn hạng mục đặc biệt). */
  shownIncomeSum: number;
  shownExpenseSum: number;
  /** Phần bị ẩn bởi toggle "Ẩn hạng mục đặc biệt". */
  hiddenCount: number;
  hiddenSum: number;
  /** Chế độ tiền mặt chạm trần danh sách: {shown, total} → không so Σ dòng được. */
  capWarning?: { shown: number; total: number } | null;
}

export function ProfitVerificationBar(props: ProfitVerificationBarProps) {
  const {
    ym, startDate, endDate, buildingIds, monthLabel,
    accrualMode, pnlOnly,
    totalIncome, totalExpense, shownIncomeSum, shownExpenseSum,
    hiddenCount, hiddenSum, capWarning,
  } = props;
  const [open, setOpen] = useState(false);

  const { data: v } = useProfitVerification({
    ym, startDate, endDate, buildingIds, pnlOnly, accrualMode,
  });

  // 1) Bất biến hiển thị: tổng thẻ − (Σ dòng hiển thị + phần đang ẩn) ≈ 0.
  const sumWithHidden = shownIncomeSum + shownExpenseSum + hiddenSum;
  const totalBoth = totalIncome + totalExpense;
  const rowsMatch = Math.abs(totalBoth - sumWithHidden) < 2; // dung sai làm tròn
  const rowsDiff = totalBoth - sumWithHidden;

  // 3) Tie-out engine chia cổ đông (chỉ chạy accrual + pnlOnly).
  const faDiffIncome = v?.fa ? totalIncome - v.fa.income : 0;
  const faDiffExpense = v?.fa ? totalExpense - v.fa.expense : 0;
  const faOk = v?.fa ? Math.abs(faDiffIncome) < 2 && Math.abs(faDiffExpense) < 2 : null;

  const anyExcluded =
    (v?.draftCount ?? 0) > 0 ||
    (v?.nonKqkdIncome ?? 0) + (v?.nonKqkdExpense ?? 0) > 0 ||
    (v?.noBookCount ?? 0) > 0;

  return (
    <div className="rounded-lg border bg-white text-[13px] leading-relaxed">
      {/* Hàng 1: chế độ + trạng thái khớp */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
      >
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
          {faOk === false || (!rowsMatch && !capWarning) ? (
            <AlertTriangle className="h-4 w-4 text-red-600" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          )}
          Kiểm chứng T{monthLabel}
        </span>

        <span className="text-muted-foreground">
          Chế độ: <b className="text-slate-700">{accrualMode ? "DỒN TÍCH (theo kỳ áp dụng)" : "TIỀN MẶT (theo ngày phiếu)"}</b>
          {" · "}
          {pnlOnly ? "chỉ khoản KQKD" : "gồm cả khoản ngoài KQKD"}
        </span>

        {/* 1) Tổng = Σ dòng */}
        {capWarning ? (
          <span className="text-amber-700">
            ⚠ Danh sách chạm trần {capWarning.shown}/{capWarning.total} dòng — tổng ở thẻ vẫn đủ (server tính)
          </span>
        ) : rowsMatch ? (
          <span className="text-emerald-700">
            Tổng = Σ dòng hiển thị{hiddenCount > 0 ? ` + ${hiddenCount} dòng đang ẩn` : ""} ✓
          </span>
        ) : (
          <span className="text-red-600 font-medium">
            Tổng ≠ Σ dòng (lệch {fmt(Math.abs(rowsDiff))}) — cần kiểm tra
          </span>
        )}

        {/* 3) Engine chia cổ đông */}
        {v?.fa && (
          faOk ? (
            <span className="text-emerald-700">Khớp engine chia cổ đông ±0 ✓</span>
          ) : (
            <span className="text-red-600 font-medium">
              LỆCH engine chia cổ đông: thu {fmt(faDiffIncome)} / chi {fmt(faDiffExpense)}
            </span>
          )
        )}

        <ChevronDown className={`h-4 w-4 ml-auto shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Hàng 2: đã loại gì khỏi P&L (luôn hiện khi có) */}
      {(anyExcluded || hiddenCount > 0) && (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span className="font-medium text-slate-600">Không nằm trong tổng:</span>
          {(v?.draftCount ?? 0) > 0 && (
            <span>
              <b className="tabular-nums">{v!.draftCount}</b> phiếu nháp ({fmt(v!.draftTotal)})
            </span>
          )}
          {pnlOnly && (v?.nonKqkdIncome ?? 0) + (v?.nonKqkdExpense ?? 0) > 0 && (
            <span title="Item tiền cọc, phiếu đánh dấu không hạch toán, bút toán nội bộ (cấn cọc…)">
              ngoài-KQKD: thu {fmt(v!.nonKqkdIncome)} · chi {fmt(v!.nonKqkdExpense)}
            </span>
          )}
          {(v?.noBookCount ?? 0) > 0 && (
            <span className="text-amber-700">
              <b className="tabular-nums">{v!.noBookCount}</b> phiếu chưa chọn sổ ({fmt(v!.noBookTotal)})
            </span>
          )}
          {hiddenCount > 0 && (
            <span>
              đang ẩn <b className="tabular-nums">{hiddenCount}</b> dòng hạng mục đặc biệt ({fmt(hiddenSum)}) — tổng vẫn gồm
            </span>
          )}
        </div>
      )}

      {/* Chi tiết mở rộng */}
      {open && (
        <div className="px-3 pb-3 pt-1 border-t space-y-1.5 text-muted-foreground">
          <div>
            Thẻ: thu <b className="tabular-nums text-emerald-700">{fmt(totalIncome)}</b> · chi{" "}
            <b className="tabular-nums text-orange-700">{fmt(totalExpense)}</b>
            {" — "}Σ dòng hiển thị: thu <b className="tabular-nums">{fmt(shownIncomeSum)}</b> · chi{" "}
            <b className="tabular-nums">{fmt(shownExpenseSum)}</b>
          </div>
          {v?.invoicePaid != null && (
            <div className="inline-flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Tiền đã thu THỰC của hoá đơn kỳ {monthLabel}: <b className="tabular-nums">{fmt(v.invoicePaid)}</b>
                {" "}(chênh với doanh thu ghi nhận: <b className="tabular-nums">{fmt(totalIncome - v.invoicePaid)}</b> —
                lệch do thu trước/sau kỳ, khoản ngoài hoá đơn, cọc… là bình thường)
              </span>
            </div>
          )}
          {v?.fa && !faOk && (
            <div className="text-red-600">
              Lệch theo toà (client − engine):{" "}
              {[...v.fa.byBuilding.entries()]
                .map(([name]) => name)
                .slice(0, 8)
                .join(", ")}{" "}
              — mở console/Phân tích tài chính để đối chiếu chi tiết.
            </div>
          )}
          <div className="text-[12px]">
            Số kiểm chứng tính SERVER-SIDE trên toàn bộ phiếu khớp bộ lọc (không giới hạn 1000 dòng).
            {!accrualMode && " Chế độ tiền mặt: tổng thẻ theo ngày phiếu trong tháng."}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProfitVerificationBar;
