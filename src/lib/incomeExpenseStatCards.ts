/**
 * Toán của 3 thẻ thống kê trang Thu chi (`/income-expense`).
 *
 * Nền: thiết kế "B4" cho 3 thẻ Thu / Chi / Thu - chi CHỈ cộng lớp TIỀN THẬT
 * (đã duyệt + đã có sổ quỹ + không phải bút toán nội bộ). Phiếu đang chờ nằm ở
 * dòng phụ "Chờ xử lý", và con số đó là THU + CHI cộng gộp nên không cộng tay
 * ngược ra được từng vế.
 *
 * Đợt này mỗi thẻ hiện thêm TRONG NGOẶC tổng đã gồm phiếu chờ xử lý — tức là
 * "nếu duyệt hết những phiếu đang chờ thì con số thành bao nhiêu". Thẻ nào
 * không còn phiếu chờ thì UI thay số bằng dấu ✓.
 *
 * "Chờ xử lý" = `approval_status = 'UNAPPROVED'` (phiếu chờ duyệt, tài liệu cũ
 * gọi là "nháp" — CÙNG một trạng thái) **hoặc** `account_id IS NULL` (đã duyệt
 * nhưng chưa chọn sổ quỹ). Xem `cls` CTE trong RPC
 * `get_income_expense_layer_stats`
 * (supabase/migrations/20260704140000_layer_stats_pending_split.sql:89).
 *
 * Ba thẻ đều có ngoặc để người xem TỰ KIỂM CHỨNG được bằng mắt:
 * ngoặc Thu − ngoặc Chi = ngoặc Thu-chi, và
 * (ngoặc Thu − Thu) + (ngoặc Chi − Chi) = số ở dòng "Chờ xử lý".
 *
 * Tách khỏi component vì đây là toán tiền: phải kiểm được bằng test mà không
 * phải dựng DOM.
 */

/** Số liệu thô của một lượt lọc, lấy thẳng từ RPC `get_income_expense_layer_stats`. */
export interface LayerTotals {
  /** `cash_income` — thu TIỀN THẬT. */
  totalIncome: number;
  /** `cash_expense` — chi TIỀN THẬT. */
  totalExpense: number;
  /** `pending_income` — thu đang chờ xử lý. */
  pendingIncome: number;
  /** `pending_expense` — chi đang chờ xử lý. */
  pendingExpense: number;
}

export interface StatCardValue {
  /** Con số lớn trên thẻ — giữ nguyên nghĩa cũ: chỉ tiền thật. */
  value: number;
  /** Con số trong ngoặc — đã gồm phiếu chờ xử lý. */
  withPending: number;
  /** `false` → không còn phiếu chờ ở chiều này, UI hiện dấu ✓ thay cho số. */
  hasPending: boolean;
}

export interface IncomeExpenseStatCards {
  income: StatCardValue;
  expense: StatCardValue;
  difference: StatCardValue;
}

/** Số tiền hỏng (undefined/null/NaN/Infinity) coi như 0 — thẻ tiền không được ra NaN. */
const money = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? n : 0;

export function buildIncomeExpenseStatCards(
  totals: LayerTotals,
): IncomeExpenseStatCards {
  const cashIncome = money(totals.totalIncome);
  const cashExpense = money(totals.totalExpense);
  const pendingIncome = money(totals.pendingIncome);
  const pendingExpense = money(totals.pendingExpense);

  const incomeWithPending = cashIncome + pendingIncome;
  const expenseWithPending = cashExpense + pendingExpense;

  return {
    income: {
      value: cashIncome,
      withPending: incomeWithPending,
      hasPending: pendingIncome > 0,
    },
    expense: {
      value: cashExpense,
      withPending: expenseWithPending,
      hasPending: pendingExpense > 0,
    },
    difference: {
      value: cashIncome - cashExpense,
      // Cân đối CẢ HAI vế (chủ chốt 13/09): đọc ra "còn lại thật sự bao nhiêu
      // nếu duyệt hết mọi phiếu đang chờ", và nhờ vậy ngoặc Thu − ngoặc Chi
      // luôn ra đúng con số này.
      withPending: incomeWithPending - expenseWithPending,
      hasPending: pendingIncome > 0 || pendingExpense > 0,
    },
  };
}
