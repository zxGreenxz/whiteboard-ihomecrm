import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Ngưỡng làm tròn: chênh cọc < 10.000đ coi như đủ (khớp PREVIOUS_DEBT_ROUND_THRESHOLD).
export const DEPOSIT_SHORTFALL_THRESHOLD = 10000;

export type HeldDepositState = 'FULL' | 'SHORT' | 'FIRST_INVOICE';

export interface HeldDepositRow {
  contract_id: string;
  contract_number: string | null;
  building_id: string;
  building_name: string;
  room_name: string;
  customer_name: string;
  total_deposit: number;
  deposit_paid: number;
  deposit_remaining: number;
  deposit_debt_mode: string | null;
  deposit_topup_due_date: string | null;
  state: HeldDepositState;
}

export interface BuildingDepositSummary {
  building_id: string;
  building_name: string;
  contractCount: number;
  expected: number; // Σ total_deposit
  held: number; // Σ deposit_paid (cọc đang giữ)
  shortfall: number; // Σ deposit_remaining
  fullCount: number;
  shortCount: number;
}

export type RefundForfeitKind = 'REFUND' | 'FORFEIT';

export interface RefundForfeitRow {
  id: string;
  contract_id: string;
  contract_number: string | null;
  building_id: string;
  building_name: string;
  room_name: string;
  customer_name: string;
  termination_date: string;
  termination_type: string;
  kind: RefundForfeitKind;
  total_deposit: number;
  total_deductions: number;
  refund_amount: number;
  status: string;
  refund_done: boolean;
}

function repName(contractCustomers: any[] | undefined | null): string {
  const list = contractCustomers ?? [];
  const rep = list.find((cc: any) => cc.is_representative);
  return (
    rep?.customer?.full_name ||
    list[0]?.customer?.full_name ||
    'Khách hàng'
  );
}

/**
 * Cọc đang giữ theo HĐ đang hiệu lực (ACTIVE) — nguồn sự thật đủ/thiếu cọc.
 * Trả về từng dòng HĐ; trang tự gộp theo toà nhà.
 */
export function useHeldDeposits() {
  return useQuery({
    queryKey: ['deposit-dashboard', 'held'],
    queryFn: async (): Promise<HeldDepositRow[]> => {
      const { data, error } = await (supabase as any)
        .from('contracts')
        .select(`
          id, contract_number, total_deposit, deposit_paid, deposit_remaining,
          deposit_debt_mode, deposit_topup_due_date,
          room:rooms!contracts_room_id_fkey (
            id, name,
            building:buildings!rooms_building_id_fkey ( id, name )
          ),
          contract_customers!contract_customers_contract_id_fkey (
            is_representative,
            customer:customers!contract_customers_customer_id_fkey ( full_name )
          )
        `)
        .in('status', ['ACTIVE'])
        .is('deleted_at', null);

      if (error) throw error;

      return (data ?? []).map((c: any): HeldDepositRow => {
        const total = Number(c.total_deposit) || 0;
        const paid = Number(c.deposit_paid) || 0;
        const remaining =
          c.deposit_remaining != null ? Number(c.deposit_remaining) : total - paid;
        const isShort = remaining >= DEPOSIT_SHORTFALL_THRESHOLD;
        const state: HeldDepositState = !isShort
          ? 'FULL'
          : c.deposit_debt_mode === 'FIRST_INVOICE'
            ? 'FIRST_INVOICE'
            : 'SHORT';
        return {
          contract_id: c.id,
          contract_number: c.contract_number ?? null,
          building_id: c.room?.building?.id ?? '',
          building_name: c.room?.building?.name ?? '—',
          room_name: c.room?.name ?? '—',
          customer_name: repName(c.contract_customers),
          total_deposit: total,
          deposit_paid: paid,
          deposit_remaining: remaining,
          deposit_debt_mode: c.deposit_debt_mode ?? null,
          deposit_topup_due_date: c.deposit_topup_due_date ?? null,
          state,
        };
      });
    },
  });
}

/** Gộp các dòng cọc đang giữ theo toà nhà. */
export function summarizeByBuilding(rows: HeldDepositRow[]): BuildingDepositSummary[] {
  const map = new Map<string, BuildingDepositSummary>();
  for (const r of rows) {
    const key = r.building_id || r.building_name;
    let s = map.get(key);
    if (!s) {
      s = {
        building_id: r.building_id,
        building_name: r.building_name,
        contractCount: 0,
        expected: 0,
        held: 0,
        shortfall: 0,
        fullCount: 0,
        shortCount: 0,
      };
      map.set(key, s);
    }
    s.contractCount += 1;
    s.expected += r.total_deposit;
    s.held += r.deposit_paid;
    s.shortfall += Math.max(0, r.deposit_remaining);
    if (r.state === 'FULL') s.fullCount += 1;
    else s.shortCount += 1;
  }
  return Array.from(map.values()).sort((a, b) =>
    a.building_name.localeCompare(b.building_name, 'vi'),
  );
}

/**
 * Hoàn cọc / Bỏ cọc — lấy từ contract_terminations (KHÔNG dựa deposits.status vì
 * RPC thanh lý không set REFUNDED/FORFEITED). FORFEIT = bỏ cọc; còn lại = hoàn cọc.
 */
export function useDepositRefundsForfeits() {
  return useQuery({
    queryKey: ['deposit-dashboard', 'refunds-forfeits'],
    queryFn: async (): Promise<RefundForfeitRow[]> => {
      const { data, error } = await (supabase as any)
        .from('contract_terminations')
        .select(`
          id, contract_id, termination_date, termination_type,
          total_deposit, total_deductions, refund_amount, status, refund_date,
          contract:contracts!contract_terminations_contract_id_fkey (
            contract_number,
            room:rooms!contracts_room_id_fkey (
              name,
              building:buildings!rooms_building_id_fkey ( id, name )
            ),
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey ( full_name )
            )
          )
        `)
        .order('termination_date', { ascending: false });

      if (error) throw error;

      return (data ?? []).map((t: any): RefundForfeitRow => {
        const kind: RefundForfeitKind =
          t.termination_type === 'FORFEIT' ? 'FORFEIT' : 'REFUND';
        return {
          id: t.id,
          contract_id: t.contract_id,
          contract_number: t.contract?.contract_number ?? null,
          building_id: t.contract?.room?.building?.id ?? '',
          building_name: t.contract?.room?.building?.name ?? '—',
          room_name: t.contract?.room?.name ?? '—',
          customer_name: repName(t.contract?.contract_customers),
          termination_date: t.termination_date,
          termination_type: t.termination_type,
          kind,
          total_deposit: Number(t.total_deposit) || 0,
          total_deductions: Number(t.total_deductions) || 0,
          refund_amount: Number(t.refund_amount) || 0,
          status: t.status,
          refund_done: !!t.refund_date || t.status === 'COMPLETED',
        };
      });
    },
  });
}
