import { useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle, ChevronDown, Info } from "lucide-react";
import { useProfitVerification } from "@/hooks/useProfitVerification";
import {
  calculateProfitVerificationInvariant,
  resolveProfitVerificationVisualState,
  type ProfitVerificationVisualState,
} from "@/lib/profitVerification";

/**
 * B5 (thống nhất tài chính 04/07): thanh KIỂM CHỨNG của trang Phân bổ lợi
 * nhuận — desktop + mobile DÙNG CHUNG. Trả lời trực diện nỗi đau của chủ:
 * "nhìn bảng phân bổ không chắc có đủ/thiếu gì không".
 *
 *  1. Tổng thẻ = Σ dòng hiển thị? (± phần dòng đang ẩn bởi "hạng mục đặc biệt")
 *  2. Finance V2 §2.3: phiếu CHỜ DUYỆT nằm TRONG tổng KQKD — nêu counter riêng
 *     (không còn "phiếu nháp bị loại"). Khoản ngoài-KQKD vẫn nêu phần bị loại.
 *     Phiếu đã duyệt chưa chọn sổ vẫn nằm trong tổng và được cảnh báo riêng.
 *  3. Khớp engine chia cổ đông (fa_monthly_pnl_accrual) — engine chỉ tính
 *     APPROVED nên tie-out so TỔNG TRỪ PHẦN CHỜ DUYỆT; lệch ≠ 0 là ĐỎ.
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
  /** Phần bị ẩn bởi toggle "Ẩn hạng mục đặc biệt", tách đúng chiều Thu/Chi. */
  hiddenCount: number;
  hiddenIncomeSum: number;
  hiddenExpenseSum: number;
  /** Chế độ tiền mặt chạm trần danh sách: {shown, total} → không so Σ dòng được. */
  capWarning?: { shown: number; total: number } | null;
  /** §2.3: phần thuộc phiếu CHỜ DUYỆT đã nằm TRONG tổng (client tính từ đúng
   *  nguồn dữ liệu của tổng — accrual rows / list). Engine chia cổ đông chỉ tính
   *  APPROVED nên tie-out sẽ trừ phần này ra trước khi so. */
  pendingCount?: number;
  pendingIncome?: number;
  pendingExpense?: number;
  /** Báo trạng thái CÓ LỆCH (cờ đỏ) lên parent — mobile dùng để ẩn thanh, chỉ hiện
   *  chấm đỏ ở ô Lợi nhuận khi lệch. Truyền setState (identity ổn định). */
  onIssueChange?: (hasIssue: boolean) => void;
  /** Trạng thái ĐẦY ĐỦ (gồm LOADING/WARNING) — desktop dựng chip kiểm chứng trên
   *  dải hero xanh. Truyền callback identity ổn định (useCallback/setState). */
  onStateChange?: (state: ProfitVerificationVisualState) => void;
}

export function ProfitVerificationBar(props: ProfitVerificationBarProps) {
  const {
    ym, startDate, endDate, buildingIds, monthLabel,
    accrualMode, pnlOnly,
    totalIncome, totalExpense, shownIncomeSum, shownExpenseSum,
    hiddenCount, hiddenIncomeSum, hiddenExpenseSum, capWarning,
    pendingCount = 0, pendingIncome = 0, pendingExpense = 0,
  } = props;
  const [open, setOpen] = useState(false);

  const verificationQuery = useProfitVerification({
    ym, startDate, endDate, buildingIds, pnlOnly, accrualMode,
  });
  const { data: v } = verificationQuery;

  // 1) Hai bất biến độc lập; không cho chênh Thu bù trừ chênh Chi.
  const invariant = calculateProfitVerificationInvariant({
    totalIncome,
    totalExpense,
    shownIncomeSum,
    shownExpenseSum,
    hiddenIncomeSum,
    hiddenExpenseSum,
  });
  const hiddenSum = hiddenIncomeSum + hiddenExpenseSum;

  // 3) Tie-out engine chia cổ đông (chỉ chạy accrual + pnlOnly). Engine SQL chỉ
  // tính APPROVED → so phần APPROVED của tổng (tổng − phần chờ duyệt).
  const faDiffIncome = v?.fa ? totalIncome - pendingIncome - v.fa.income : 0;
  const faDiffExpense = v?.fa ? totalExpense - pendingExpense - v.fa.expense : 0;
  const faOk = v?.fa ? Math.abs(faDiffIncome) < 2 && Math.abs(faDiffExpense) < 2 : null;

  const anyExcluded =
    Math.abs(v?.nonKqkdIncome ?? 0) + Math.abs(v?.nonKqkdExpense ?? 0) > 0;

  const visualState = resolveProfitVerificationVisualState({
    loading: verificationQuery.isLoading || (!v && !verificationQuery.isError),
    unavailable: verificationQuery.isError,
    capWarning: !!capWarning,
    incomeMatches: invariant.incomeMatches,
    expenseMatches: invariant.expenseMatches,
    faMatches: faOk,
  });

  // Cờ đỏ tổng hợp (cùng điều kiện icon AlertTriangle ở header) — báo lên parent.
  const hasIssue = visualState === "ERROR" || visualState === "UNAVAILABLE";
  const { onIssueChange, onStateChange } = props;
  useEffect(() => {
    onIssueChange?.(hasIssue);
  }, [hasIssue, onIssueChange]);
  useEffect(() => {
    onStateChange?.(visualState);
  }, [visualState, onStateChange]);

  return (
    <div className="rounded-lg border bg-white text-[13px] leading-relaxed">
      {/* Hàng 1: chế độ + trạng thái khớp */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
      >
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
          {visualState === "OK" ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle
              className={`h-4 w-4 ${
                visualState === "ERROR" || visualState === "UNAVAILABLE"
                  ? "text-red-600"
                  : "text-amber-600"
              }`}
            />
          )}
          Kiểm chứng T{monthLabel}
        </span>

        <span className="text-muted-foreground">
          Chế độ: <b className="text-slate-700">{accrualMode ? "DỒN TÍCH (theo kỳ áp dụng)" : "TIỀN MẶT (theo ngày phiếu)"}</b>
          {" · "}
          {pnlOnly ? "chỉ khoản KQKD" : "gồm cả khoản ngoài KQKD"}
        </span>

        {visualState === "UNAVAILABLE" ? (
          <span className="font-medium text-red-600">
            UNAVAILABLE — không thể xác minh số server
          </span>
        ) : visualState === "LOADING" ? (
          <span className="font-medium text-amber-700">Đang tải số kiểm chứng server…</span>
        ) : capWarning ? (
          <span className="text-amber-700">
            ⚠ Danh sách chạm trần {capWarning.shown}/{capWarning.total} dòng — tổng ở thẻ vẫn đủ (server tính)
          </span>
        ) : (
          <>
            <span className={invariant.incomeMatches ? "text-emerald-700" : "font-medium text-red-600"}>
              Thu {invariant.incomeMatches ? "= Σ dòng ✓" : `≠ Σ dòng (lệch ${fmt(Math.abs(invariant.incomeDiff))})`}
            </span>
            <span className={invariant.expenseMatches ? "text-emerald-700" : "font-medium text-red-600"}>
              Chi {invariant.expenseMatches ? "= Σ dòng ✓" : `≠ Σ dòng (lệch ${fmt(Math.abs(invariant.expenseDiff))})`}
            </span>
          </>
        )}

        {/* 3) Engine chia cổ đông */}
        {visualState !== "UNAVAILABLE" && v?.fa && (
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

      {/* Hàng 2a (§2.3): phiếu CHỜ DUYỆT nằm TRONG tổng — counter riêng. */}
      {pendingCount > 0 && (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sky-700">
          <span className="font-medium">Trong tổng có:</span>
          <span>
            <b className="tabular-nums">{pendingCount}</b> phiếu chờ duyệt
            {" "}(thu {fmt(pendingIncome)} · chi {fmt(pendingExpense)}) — chi phí/doanh thu đã
            ghi nhận KQKD, sẽ chốt tiền khi duyệt &amp; thu/chi
          </span>
        </div>
      )}

      {/* Hàng 2b: đã loại gì khỏi P&L (luôn hiện khi có) */}
      {anyExcluded && (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span className="font-medium text-slate-600">Không nằm trong tổng:</span>
          {pnlOnly && (v?.nonKqkdIncome ?? 0) + (v?.nonKqkdExpense ?? 0) > 0 && (
            <span title="Item tiền cọc, phiếu đánh dấu không hạch toán, bút toán nội bộ (cấn cọc…)">
              ngoài-KQKD: thu {fmt(v!.nonKqkdIncome)} · chi {fmt(v!.nonKqkdExpense)}
            </span>
          )}
        </div>
      )}

      {(v?.noBookCount ?? 0) > 0 && (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-amber-700">
          <span className="font-medium">Cần xử lý:</span>
          <span>
            <b className="tabular-nums">{v!.noBookCount}</b> phiếu đã duyệt chưa chọn sổ
            {" "}(thu {fmt(v!.noBookIncome)} · chi {fmt(v!.noBookExpense)}) — vẫn đã nằm trong tổng báo cáo
          </span>
        </div>
      )}

      {hiddenCount > 0 && (
        <div className="px-3 pb-2 text-muted-foreground">
          Đang ẩn <b className="tabular-nums">{hiddenCount}</b> dòng hạng mục đặc biệt
          {" "}(thu {fmt(hiddenIncomeSum)} · chi {fmt(hiddenExpenseSum)}; tổng {fmt(hiddenSum)}) — tổng thẻ vẫn gồm.
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
          {verificationQuery.isError && (
            <div className="text-red-600">
              {verificationQuery.error instanceof Error
                ? verificationQuery.error.message
                : "UNAVAILABLE: lỗi tải dữ liệu kiểm chứng"}
            </div>
          )}
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
