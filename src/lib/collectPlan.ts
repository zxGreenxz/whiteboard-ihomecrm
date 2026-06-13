// =============================================
// planCollect — TÍNH TOÁN THUẦN cho một lần thu tiền /thu-tien.
//
// Gom các dòng thanh toán (TM/TK/TT) → số tiền từng phương thức + tiền
// thối + cờ nợ khách + làm tròn, kèm validate. KHÔNG fetch/side-effect →
// test được độc lập. useQuickCollect dùng kết quả này để dựng phiếu thu.
//
// Quy tắc tiền (đối chiếu RecordPaymentDialog + useBulkRecordPayment):
//  - Chỉ TIỀN MẶT (TM) mới được thu dư (để thối lại hoặc giữ nợ khách);
//    TK/TT không được vượt còn-phải-thu.
//  - change (thối/nợ khách) = đúng phần dư = max(0, tổng − remaining),
//    luôn ≤ tổng TM. Ép bằng phần dư để excess_amounts (credit) khớp với
//    overpay thực → không cấn tiền 2 lần (remaining âm là trơ).
//  - Nợ khách (keepAsCredit) cần hoá đơn có hợp đồng (excess_amounts.contract_id).
//  - Làm tròn: chỉ khi thu THIẾU 0 < residual < ngưỡng (mặc định 10K).
//  - cap = đường 1-chạm (Thu đủ/keypad): cap tổng về remaining, không thối.
// =============================================

import type { CollectMethod } from './cashAccount';

export interface CollectPlanLine {
  method: CollectMethod;
  amount: number;
}

export interface CollectPlanInput {
  lines: CollectPlanLine[];
  remaining: number;
  keepAsCredit?: boolean;
  hasContract?: boolean;
  /** Đường 1-chạm: cap tổng ≤ remaining, không thối/credit. */
  cap?: boolean;
  roundingThreshold?: number;
}

export interface CollectPlan {
  amountTm: number;
  amountTk: number;
  amountTt: number;
  /** Tiền thối / phần giữ nợ khách (luôn ≤ amountTm). */
  change: number;
  keepAsCredit: boolean;
  rounding: number;
}

export type CollectPlanResult =
  | { ok: true; plan: CollectPlan }
  | { ok: false; error: string };

export const DEFAULT_ROUNDING_THRESHOLD = 10_000;

/**
 * Plan được tính theo remaining phía client (có thể cũ). Khi ghi, đối chiếu
 * với remaining VỪA ĐỌC từ DB: trả true nếu ghi theo plan sẽ làm sai tiền
 * (overpay phantom / lệch credit) → caller phải từ chối, bắt thu lại.
 *  - Nợ khách: phần giữ (change) phải đúng bằng phần vượt remaining thực.
 *  - Thối/thường: phần ròng dồn vào hoá đơn (total − change) không được
 *    vượt remaining thực.
 */
export function planConflictsWithRemaining(
  totalGross: number,
  change: number,
  keepAsCredit: boolean,
  freshRemaining: number,
): boolean {
  if (keepAsCredit) return totalGross - freshRemaining !== change;
  return totalGross - change > freshRemaining;
}

const cleanInt = (n: number) => Math.max(0, Math.round(Number(n) || 0));

export function planCollect(input: CollectPlanInput): CollectPlanResult {
  const TH = input.roundingThreshold ?? DEFAULT_ROUNDING_THRESHOLD;
  const remaining = cleanInt(input.remaining);
  const sumBy = (m: CollectMethod) =>
    input.lines
      .filter((l) => l.method === m)
      .reduce((s, l) => s + cleanInt(l.amount), 0);

  let tm = sumBy('TM');
  let tk = sumBy('TK');
  let tt = sumBy('TT');
  let total = tm + tk + tt;

  if (total <= 0) return { ok: false, error: 'Số tiền thu phải lớn hơn 0.' };

  // ── Đường 1-chạm: cap về remaining, không thối ──
  if (input.cap) {
    if (total > remaining) {
      if (tm > 0) { tm = remaining; tk = 0; tt = 0; }
      else if (tk > 0) { tk = remaining; tt = 0; }
      else { tt = remaining; }
      total = remaining;
    }
    const residualC = remaining - total;
    return {
      ok: true,
      plan: {
        amountTm: tm, amountTk: tk, amountTt: tt,
        change: 0, keepAsCredit: false,
        rounding: residualC > 0 && residualC < TH ? residualC : 0,
      },
    };
  }

  // ── Đường multi-line: cho thu dư NHƯNG chỉ qua tiền mặt ──
  const nonCash = tk + tt;
  if (nonCash > remaining) {
    return {
      ok: false,
      error: 'Tiền TK/TT vượt quá còn phải thu — chỉ tiền mặt (TM) mới được thu dư để thối/nợ khách.',
    };
  }

  const overpay = Math.max(0, total - remaining);
  if (overpay > 0 && tm <= 0) {
    return { ok: false, error: 'Thu dư chỉ áp dụng khi có tiền mặt (TM).' };
  }

  // overpay luôn ≤ tm vì nonCash ≤ remaining ⇒ total − remaining ≤ tm.
  const change = overpay;
  const keepAsCredit = !!input.keepAsCredit && change > 0;
  if (keepAsCredit && !input.hasContract) {
    return {
      ok: false,
      error: 'Hoá đơn không gắn hợp đồng nên không giữ "nợ khách" được — hãy trả thối thay vì giữ.',
    };
  }

  const residual = remaining - total; // < 0 khi thu dư → không làm tròn
  return {
    ok: true,
    plan: {
      amountTm: tm, amountTk: tk, amountTt: tt,
      change, keepAsCredit,
      rounding: residual > 0 && residual < TH ? residual : 0,
    },
  };
}
