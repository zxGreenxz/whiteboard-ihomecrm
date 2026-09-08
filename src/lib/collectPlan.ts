// =============================================
// planCollect — TÍNH TOÁN THUẦN cho một lần thu tiền /thu-tien.
//
// Gom các dòng thanh toán (TM/TK/TT) → số tiền từng phương thức + tiền
// thối + cờ nợ khách + làm tròn, kèm validate. KHÔNG fetch/side-effect →
// test được độc lập. useQuickCollect dùng kết quả này để dựng phiếu thu.
//
// Tiền thối mặc định bằng phần dư; tiền thực thối có thể lớn hơn để bỏ tiền lẻ.
// Chỉ TM được hoàn tiền. TK/TT thu dư phải giữ credit nếu TM không đủ để thối.
// Credit phải đúng phần dư, có hợp đồng; không kết hợp với tiền thực thối.
// Làm tròn dựa trên thực thu SAU thối: 0 < thiếu < 10K, không bỏ qua nợ cọc.
// cap là đường một chạm không nhập tiền thối: cap tổng về remaining.
// =============================================

import type { CollectMethod } from './cashAccount';
import { collectionSettlement, COLLECTION_ROUNDING_THRESHOLD } from './collectionSettlement';

export interface CollectPlanLine {
  method: CollectMethod;
  amount: number;
}

export interface CollectPlanInput {
  lines: CollectPlanLine[];
  remaining: number;
  keepAsCredit?: boolean;
  /** Actual cash returned; undefined uses the suggested overpayment. */
  changeAmount?: number;
  hasContract?: boolean;
  /** Đường 1-chạm: cap tổng ≤ remaining, không thối/credit. */
  cap?: boolean;
  roundingThreshold?: number;
  allowRounding?: boolean;
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

export const DEFAULT_ROUNDING_THRESHOLD = COLLECTION_ROUNDING_THRESHOLD;

export interface OverpayPolicyInput {
  total: number;
  amountTm: number;
  remaining: number;
  hasContract: boolean;
}

export interface OverpayPolicy {
  overpay: number;
  canRefund: boolean;
  mustKeepAsCredit: boolean;
  canKeepAsCredit: boolean;
}

/** Chính sách phần dư chỉ dựa trên các tender của lần thu hiện tại. */
export function deriveOverpayPolicy(input: OverpayPolicyInput): OverpayPolicy {
  const overpay = Math.max(0, cleanInt(input.total) - cleanInt(input.remaining));
  const canRefund = overpay > 0 && cleanInt(input.amountTm) >= overpay;
  return {
    overpay,
    canRefund,
    mustKeepAsCredit: overpay > 0 && !canRefund,
    canKeepAsCredit: overpay > 0 && input.hasContract,
  };
}

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
        rounding: input.allowRounding !== false && residualC > 0 && residualC < TH ? residualC : 0,
      },
    };
  }

  const policy = deriveOverpayPolicy({
    total,
    amountTm: tm,
    remaining,
    hasContract: !!input.hasContract,
  });
  const suggestedChange = policy.overpay;
  // Không đủ TM để hoàn phần dư thì lần thu này bắt buộc giữ credit. Khi TM đủ,
  // giữ mặc định hoàn tiền nhưng vẫn cho người dùng chủ động chọn credit.
  const keepAsCredit = suggestedChange > 0 && (policy.mustKeepAsCredit || !!input.keepAsCredit);
  if (keepAsCredit && !input.hasContract) {
    return {
      ok: false,
      error: policy.mustKeepAsCredit
        ? 'Hoá đơn không gắn hợp đồng nên không thể thu dư bằng TK/TT để trừ kỳ sau.'
        : 'Hoá đơn không gắn hợp đồng nên không giữ "nợ khách" được — hãy trả thối thay vì giữ.',
    };
  }

  let settlement: ReturnType<typeof collectionSettlement>;
  try {
    settlement = collectionSettlement({ gross: total, cash: tm, remaining,
      action: keepAsCredit ? 'CREDIT' : (input.changeAmount ?? suggestedChange) > 0 ? 'REFUND' : 'REJECT',
      actualChange: input.changeAmount,
      allowRounding: input.allowRounding !== false, roundingThreshold: TH });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Số tiền không hợp lệ' };
  }
  return {
    ok: true,
    plan: {
      amountTm: tm, amountTk: tk, amountTt: tt,
      change: keepAsCredit ? settlement.credit : settlement.change, keepAsCredit,
      rounding: settlement.rounding,
    },
  };
}
