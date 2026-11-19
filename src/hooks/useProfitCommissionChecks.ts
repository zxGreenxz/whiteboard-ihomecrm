import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { fetchSettlementRows, settlementIdBatches, settlementReadLimiter } from '@/lib/contractSettlementReads';
import { commissionFollowupPageSchema, type ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';
import { monthToEndDate } from '@/lib/monthPeriod';
import { buildProfitCommissionChecks, commissionVoucherKind, isLiveCommissionVoucher,
  type CommissionCheckContract, type CommissionCheckVoucher } from '@/lib/profitCommissionChecks';
import { financialReadNumber } from '@/lib/financialReadValidation';

const scopeSchema = z.object({ org_wide: z.boolean(), building_ids: z.array(z.string()), cashbook_ids: z.array(z.string()).optional() });
const permissionSchema = z.object({ __superadmin: z.boolean().optional(),
  contracts: z.object({ view: scopeSchema.optional() }).optional(),
  buildings: z.object({ view: scopeSchema.optional() }).optional(),
  income_expenses: z.object({ view: scopeSchema.optional() }).optional(),
});

/** Sufficient, deliberately conservative coverage. A scoped/custodian reader can see
 * individual vouchers but must never interpret RLS-filtered zero as absence. */
export function hasCompleteCommissionVisibility(raw: unknown, restricted: boolean): boolean {
  const permissions = permissionSchema.parse(raw);
  return restricted && (permissions.__superadmin === true ||
    (permissions.contracts?.view?.org_wide === true && permissions.buildings?.view?.org_wide === true &&
      permissions.income_expenses?.view?.org_wide === true));
}

export interface ProfitCommissionScope {
  organizationId: string | null;
  buildingIds: readonly string[];
  month: string;
  roomId?: string | null;
  contractId?: string;
  enabled?: boolean;
}

const CONTRACT_COLUMNS = `id, organization_id, contract_number, start_date, signed_date, status, room_id,
  room:rooms!contracts_room_id_fkey!inner(id, name, building_id, building:buildings!rooms_building_id_fkey(name))`;
const VOUCHER_COLUMNS = `id, organization_id, code, contract_id, room_id, building_id, type, deleted_at,
  total_amount, voucher_date, commission_kind, system_source, approval_status, posting_status,
  active_posting_id_v2, business_result_accounting, invoice_id,
  invoice:invoices!income_expenses_invoice_id_fkey(billing_month),
  items:income_expense_items(id, start_date, end_date, accounting_class, income_expense_type_id,
    expense_type:income_expense_types!income_expense_items_income_expense_type_id_fkey(name, category, is_deposit))`;

export async function readProfitCommissionChecks(scope: ProfitCommissionScope, signal: AbortSignal) {
  const organizationId = z.string().guid().parse(scope.organizationId);
  const buildingIds = z.array(z.string().guid()).nonempty().parse([...new Set(scope.buildingIds)]);
  const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(scope.month);
  // Query keys and every source explicitly carry org; no fallback to the old cross-org permission RPC.
  const [permissions, restricted, contracts] = await Promise.all([
    supabase.rpc('get_my_permissions_v2', { p_org: organizationId }).abortSignal(signal),
    supabase.rpc('can_view_restricted_ie').abortSignal(signal),
    fetchSettlementRows<CommissionCheckContract>((from, to) => {
      let q = supabase.from('contracts').select(CONTRACT_COLUMNS)
        .eq('organization_id', organizationId).in('room.building_id', buildingIds)
        .is('deleted_at', null).neq('status', 'DRAFT');
      if (scope.contractId) q = q.eq('id', scope.contractId);
      else q = q.gte('start_date', `${month}-01`).lte('start_date', monthToEndDate(month));
      if (scope.roomId) q = q.eq('room_id', scope.roomId);
      return q.order('start_date').order('id').abortSignal(signal).range(from, to);
    }, { signal, label: 'profit-commission.contracts' }),
  ]);
  if (permissions.error) throw permissions.error;
  if (restricted.error) throw restricted.error;
  if (!contracts || typeof restricted.data !== 'boolean') throw new Error('Chưa đọc đủ hợp đồng và quyền đối chiếu hoa hồng.');
  const completeVisibility = hasCompleteCommissionVisibility(permissions.data, restricted.data);
  const ids = contracts.map(contract => contract.id);
  const vouchers: CommissionCheckVoucher[] = [];
  const followups: ContractCommissionFollowup[] = [];
  const orphans: CommissionCheckVoucher[] = [];
  // Bound URL size and database concurrency; no cap at the first 1,000 rows.
  for (const batch of settlementIdBatches(ids)) {
    const [rows, followup] = await Promise.all([
      fetchSettlementRows<CommissionCheckVoucher>((from, to) => supabase.from('income_expenses').select(VOUCHER_COLUMNS)
        .eq('organization_id', organizationId).eq('type', 'EXPENSE').in('contract_id', batch)
        .is('deleted_at', null).neq('approval_status', 'CANCELLED')
        .order('id').abortSignal(signal).range(from, to), { signal, label: 'profit-commission.vouchers' }),
      supabase.rpc('list_contract_commission_followups_v2', {
        p_organization_id: organizationId, p_contract_ids: batch, p_kind: 'broker',
        p_limit: 100, p_offset: 0, p_unresolved_only: false,
      }).abortSignal(signal),
    ]);
    if (!rows) throw new Error('Chưa đọc đủ phiếu hoa hồng; không thể kết luận chưa có phiếu.');
    if (followup.error) throw followup.error;
    const page = commissionFollowupPageSchema.parse(followup.data);
    if (page.total !== page.rows.length || page.rows.some(row => !batch.includes(row.contract_id)))
      throw new Error('Danh sách đối chiếu hoa hồng chưa đầy đủ hoặc sai hợp đồng.');
    followups.push(...page.rows);
    vouchers.push(...rows.map(row => ({ ...row, total_amount: financialReadNumber(row.total_amount) })));
  }
  // Legacy vouchers without a contract cannot be assigned by matching room names.
  // Show them separately so a missing link never invites another payment.
  for (const rooms of settlementIdBatches([...new Set(contracts.map(contract => contract.room_id))])) {
    const rows = await fetchSettlementRows<CommissionCheckVoucher>((from, to) => supabase.from('income_expenses').select(VOUCHER_COLUMNS)
      .eq('organization_id', organizationId).eq('type', 'EXPENSE').in('room_id', rooms).is('contract_id', null)
      .is('deleted_at', null).neq('approval_status', 'CANCELLED')
      .order('id').abortSignal(signal).range(from, to), { signal, label: 'profit-commission.unlinked' });
    if (!rows) throw new Error('Chưa đối chiếu được phiếu chưa gắn hợp đồng.');
    orphans.push(...rows.filter(row => isLiveCommissionVoucher(row) && commissionVoucherKind(row).kind === 'commission')
      .map(row => ({ ...row, total_amount: financialReadNumber(row.total_amount) })));
  }
  const postedOn = new Map<string, string>();
  const postingIds = [...new Set(vouchers.filter(v => commissionVoucherKind(v).kind === 'commission' && v.posting_status === 'POSTED' && v.active_posting_id_v2)
    .map(v => v.active_posting_id_v2!))];
  let postingReadFailed = false;
  for (const batch of settlementIdBatches(postingIds)) {
    try {
      const rows = await fetchSettlementRows<{ id: string; posted_on: string }>((from, to) => supabase.from('income_expense_postings')
        .select('id, posted_on').eq('organization_id', organizationId).in('id', batch)
        .order('id').abortSignal(signal).range(from, to), { signal, label: 'profit-commission.postings' });
      if (rows === null) postingReadFailed = true;
      else for (const row of rows) if (row.posted_on) postedOn.set(row.id, row.posted_on);
    } catch (error) {
      if (signal.aborted) throw error;
      // An unavailable cashbook posting makes the payment date unknown, not the voucher absent.
      postingReadFailed = true;
    }
  }
  // RLS can successfully return [] or a partial set. That is still an unknown payment period.
  if (postingIds.some(id => !postedOn.has(id))) postingReadFailed = true;
  return { rows: buildProfitCommissionChecks({ organizationId, contracts, vouchers, followups, completeVisibility, postedOn }),
    completeVisibility, orphans, postingReadFailed };
}

export function useProfitCommissionChecks(scope: ProfitCommissionScope) {
  const actorId = useAuth().data?.id;
  const limiter = settlementReadLimiter(useQueryClient());
  return useQuery({
    queryKey: ['contract-settlement', 'profit-commission-checks', actorId, scope.organizationId,
      [...new Set(scope.buildingIds)].sort(), scope.month, scope.roomId ?? null, scope.contractId ?? null],
    enabled: scope.enabled !== false && !!actorId && !!scope.organizationId && scope.buildingIds.length > 0,
    meta: { label: 'đối chiếu hoa hồng hợp đồng', errorDisplay: 'inline' },
    staleTime: 15_000, refetchOnWindowFocus: true, refetchInterval: 30_000,
    queryFn: ({ signal }) => limiter.run(signal, () => readProfitCommissionChecks(scope, signal)),
  });
}
