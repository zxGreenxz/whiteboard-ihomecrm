import { describe, expect, it } from 'vitest';
import { planCollect, type CollectMethod } from '../collectPlan';
import { collectionSettlement } from '../collectionSettlement';
import { findRecentDuplicateCollection } from '../duplicateCollection';
import { findOwnChangeAccount, JOEY_USER_ID, NATHAN_USER_ID } from '../changeAccounts';
import vectors from './fixtures/invoice-collection-plan-vectors.json';

// Phía TS của bộ vector kế hoạch thu tiền: chính các hàm thuần web đang dùng (planCollect, collectionSettlement,
// findRecentDuplicateCollection, findOwnChangeAccount). Phía SQL (public.invoice_collection_plan_core_v1) chạy cùng tệp vector ở
// infra/hermes-broker/invoice-collection-plan-sql.test.mjs. Hai phía cùng khớp tệp ⇒ hàm SQL dùng chung tính như web.
type Line = { method: CollectMethod; amount: number | null };
type Vector = {
  name: string; ts: boolean; changeUser?: 'JOEY' | 'NATHAN' | 'OTHER';
  input: { remaining: number; lines: Line[]; overpay?: string; hasContract?: boolean; depositDue?: number; allowRounding?: boolean;
    actualChange?: number; now?: string; virtualAccounts?: { id: string; name: string; possessed: boolean }[];
    collections?: { id: string; status: string; grossAmount: number; createdAt: string; collectorName?: string }[] };
  expected: Record<string, unknown>;
};

function tsPlan(v: Vector['input']) {
  const lines = v.lines.map(line => ({ method: line.method, amount: line.amount ?? (v.lines.length === 1 ? v.remaining : 0) }));
  const sum = (method: CollectMethod) => lines.filter(line => line.method === method).reduce((total, line) => total + line.amount, 0);
  const allowRounding = (v.allowRounding ?? true) && (v.depositDue ?? 0) === 0;
  const hasContract = v.hasContract ?? false;
  const gross = sum('TM') + sum('TK') + sum('TT');
  if ((v.overpay ?? 'reject') === 'reject') {
    // Mặc định của trợ lý: không tự chọn cách xử lý phần dư ⇒ chỉ nhánh REJECT của collectionSettlement.
    try {
      const s = collectionSettlement({ gross, cash: sum('TM'), remaining: v.remaining, action: 'REJECT', allowRounding });
      return { ok: true, amountTm: sum('TM'), amountTk: sum('TK'), amountTt: sum('TT'), change: 0, credit: 0, rounding: s.rounding, applied: s.applied,
        overpayAction: 'REJECT', returned: 0, gross };
    } catch { return { ok: false }; }
  }
  const cap = v.overpay === 'return';
  const result = planCollect({ lines, remaining: v.remaining, hasContract, allowRounding, cap, changeAmount: v.actualChange,
    keepAsCredit: v.overpay === 'keep' ? true : v.overpay === 'refund' ? false : undefined });
  if (result.ok === false) return { ok: false };
  const { plan } = result;
  const total = plan.amountTm + plan.amountTk + plan.amountTt;
  if (cap) {
    if (Math.min(total, v.remaining) <= 0) return { ok: false };
    return { ok: true, amountTm: plan.amountTm, amountTk: plan.amountTk, amountTt: plan.amountTt, change: 0, credit: 0, rounding: plan.rounding,
      applied: Math.min(total, v.remaining), overpayAction: 'REJECT', returned: gross - total, gross: total };
  }
  const overpay = Math.max(total - v.remaining, 0);
  const action = plan.keepAsCredit ? 'CREDIT' : (v.actualChange ?? overpay) > 0 ? 'REFUND' : 'REJECT';
  const s = collectionSettlement({ gross: total, cash: plan.amountTm, remaining: v.remaining, action, actualChange: v.actualChange, allowRounding });
  return { ok: true, amountTm: plan.amountTm, amountTk: plan.amountTk, amountTt: plan.amountTt, change: plan.keepAsCredit ? 0 : plan.change,
    credit: plan.keepAsCredit ? plan.change : 0, rounding: plan.rounding, applied: s.applied, overpayAction: action, returned: 0, gross: total };
}

const USERS = { JOEY: JOEY_USER_ID, NATHAN: NATHAN_USER_ID, OTHER: '00000000-0000-4000-8000-000000000999' } as const;
const MONEY = ['amountTm', 'amountTk', 'amountTt', 'change', 'credit', 'rounding', 'applied', 'returned', 'overpayAction'] as const;

describe('kế hoạch thu tiền: vector đối chiếu TS ⇄ SQL', () => {
  const all = (vectors as { vectors: Vector[] }).vectors;
  it('tệp vector đủ ca và mỗi ca một tên', () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(new Set(all.map(v => v.name)).size).toBe(all.length);
  });
  for (const v of all.filter(item => item.ts)) {
    it(v.name, () => {
      const got = tsPlan(v.input);
      expect(got.ok, 'ok').toBe(v.expected.ok);
      if (v.expected.ok) for (const key of MONEY) if (key in v.expected) expect(got[key as keyof typeof got], key).toBe(v.expected[key]);
      if ('duplicate' in v.expected) {
        const found = findRecentDuplicateCollection((v.input.collections ?? []).map(c => ({ id: c.id, status: c.status, gross_amount: c.grossAmount,
          created_at: c.createdAt, collector_name: c.collectorName ?? null })), got.ok ? got.gross ?? 0 : 0, Date.parse(v.input.now ?? ''));
        expect(found?.id ?? null).toBe(v.expected.duplicate);
      }
      if ('changeAccount' in v.expected)
        expect(findOwnChangeAccount(v.input.virtualAccounts ?? [], USERS[v.changeUser ?? 'OTHER'])?.id).toBe(v.expected.changeAccount);
    });
  }
});
