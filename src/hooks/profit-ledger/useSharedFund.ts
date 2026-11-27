import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { useAuth } from '@/hooks/useAuth';
import { invalidateProfitLedgerQueries } from './useProfitLedgerMutations';

const amount = z.number().int().safe();
const kind = z.enum(['OPENING', 'CREDIT', 'DEBIT']);
const line = z.object({
  shareholder_id: z.string(),
  name: z.string(),
  amount,
  advance_offset_amount: amount,
  payable_amount: amount,
});
const source = z.object({
  id: z.string(),
  kind,
  effective_date: z.string(),
  amount,
  reference: z.string(),
  evidence: z.string(),
  created_by: z.string(),
  request_key: z.string(),
});
const distribution = z.object({
  id: z.string(),
  effective_date: z.string(),
  period_month: z.string(),
  reference: z.string(),
  evidence: z.string(),
  status: z.literal('POSTED'),
  amount,
  advance_offset_amount: amount,
  payable_amount: amount,
  lines: z.array(line),
  created_by: z.string(),
  request_key: z.string(),
});
const opening = z.object({
  opening_id: z.string(),
  shareholder_id: z.string(),
  through_month: z.string(),
  as_of_date: z.string(),
  advance_amount: amount,
  evidence: z.string(),
});
const openingHistory = opening.extend({
  created_by: z.string(),
  request_key: z.string(),
  reconciled_approved: z.number().finite().nonnegative(),
  reconciled_count: z.number().int().nonnegative(),
  historical_count: z.number().int().nonnegative().optional(),
});
const stateSchema = z.object({
  organization_id: z.string(),
  route: z.string(),
  has_opening: z.boolean(),
  available_amount: amount,
  last_effective_date: z.string().nullable(),
  sources: z.array(source),
  distributions: z.array(distribution),
  expense_vouchers: z.array(z.object({
    id:z.string(), source_id:z.string(), code:z.string().nullable(), date:z.string(),
    amount, name:z.string(), account:z.string().nullable(), status:z.string(), posting:z.string().nullable(),
  })).optional(),
  shareholders: z.array(
    z.object({
      shareholder_id: z.string(),
      name: z.string(),
      advance_outstanding: z.number().finite().nonnegative(),
      unpaid_profit: z.number().finite(),
    }),
  ),
  openings: z.array(openingHistory),
});
export type SharedFundState = z.infer<typeof stateSchema>;
export type FundSourceKind = z.infer<typeof kind>;
export type FundWrite =
  | {
      action: 'source';
      kind: FundSourceKind;
      effectiveDate: string;
      amount: number;
      reference: string;
      evidence: string;
      expected: number;
    }
  | {
      action: 'distribute';
      effectiveDate: string;
      reference: string;
      evidence: string;
      expected: number;
      lines: { shareholder_id: string; amount: number; advance_offset_amount: number }[];
    }
  | {
      action: 'opening';
      shareholderId: string;
      throughMonth: string;
      asOfDate: string;
      advance: number;
      expectedUnpaid: number;
      expectedApproved: number;
      evidence: string;
    };

type RpcArgs = {
  shareholder_record_opening_receipts_v1: { p_organization_id: string; p_shareholder_id: string; p_opening_id: string; p_receipts: OpeningReceiptInput[] };
  shared_fund_state_v1: { p_organization_id: string };
  shared_fund_record_source_v1: {
    p_organization_id: string;
    p_kind: FundSourceKind;
    p_effective_date: string;
    p_amount: number;
    p_reference: string;
    p_evidence: string;
    p_expected_available: number;
    p_idempotency_key: string;
  };
  shared_fund_distribute_v1: {
    p_organization_id: string;
    p_effective_date: string;
    p_reference: string;
    p_evidence: string;
    p_lines: Extract<FundWrite, { action: 'distribute' }>['lines'];
    p_expected_available: number;
    p_idempotency_key: string;
  };
  shareholder_profit_opening_advance_v1: {
    p_organization_id: string;
    p_shareholder_id: string;
    p_through_month: string;
    p_as_of_date: string;
    p_advance_amount: number;
    p_expected_unpaid: number;
    p_expected_approved: number;
    p_evidence: string;
    p_idempotency_key: string;
  };
};
type FundRpc = <N extends keyof RpcArgs>(
  name: N,
  args: RpcArgs[N],
) => PromiseLike<{ data: unknown; error: { code: string; message: string } | null }>;
async function call<N extends keyof RpcArgs>(name: N, args: RpcArgs[N]) {
  const { data, error } = await (supabase.rpc as unknown as FundRpc)(name, args);
  if (error) throw error;
  return data;
}

export function useSharedFund(org: string) {
  const actor = useAuth().data?.id;
  return useQuery({
    queryKey: ['shared-fund', org, actor],
    enabled: !!org && !!actor,
    staleTime: 0,
    meta: { label: 'sổ quỹ chung', errorDisplay: 'inline' },
    queryFn: () => readState(org),
  });
}

export type OpeningReceiptInput = { source_refs?: { code: string; date: string; amount: number }[]; period_month: string; amount: number; external_profit: number | null; evidence: string };

export function useRecordOpeningReceipts(org: string, shareholderId: string, openingId: string) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (receipts: OpeningReceiptInput[]) => {
      const reply = await call('shareholder_record_opening_receipts_v1', {
        p_organization_id: org, p_shareholder_id: shareholderId, p_opening_id: openingId, p_receipts: receipts,
      });
      const result = z.object({ opening_id: z.string(), count: amount, amount }).parse(reply);
      if (result.opening_id !== openingId || result.count !== receipts.length ||
          result.amount !== receipts.reduce((sum, receipt) => sum + receipt.amount, 0)) {
        throw new Error('Cần kiểm tra lại biên nhận đối chiếu.');
      }
    },
    onSettled: async () => {
      invalidateProfitLedgerQueries(client);
      await client.invalidateQueries({ queryKey: ['shared-fund', org] });
    },
  });
}

async function readState(org: string) {
  const state = stateSchema.parse(await call('shared_fund_state_v1', { p_organization_id: org }));
  if (state.organization_id !== org) throw new Error('Số liệu trả về thuộc công ty khác.');
  return state;
}

export function priorFundReceipt(
  state: SharedFundState,
  action: FundWrite['action'],
  actor: string,
  key: string,
) {
  const match = (row: { created_by: string; request_key: string }) =>
    row.created_by === actor && row.request_key === key;
  if (action === 'opening') return state.openings.find(match)?.opening_id;
  return (action === 'source' ? state.sources : state.distributions).find(match)?.id;
}

const fundReceipt = z.object({
  id: z.string().min(1),
  organization_id: z.string(),
  amount,
  available_amount: amount,
});
async function write(org: string, op: FundWrite, key: string): Promise<string> {
  const base = { p_organization_id: org, p_idempotency_key: key };
  if (op.action === 'opening') {
    const receipt = opening.parse(
      await call('shareholder_profit_opening_advance_v1', {
        ...base,
        p_shareholder_id: op.shareholderId,
        p_through_month: op.throughMonth,
        p_as_of_date: op.asOfDate,
        p_advance_amount: op.advance,
        p_expected_unpaid: op.expectedUnpaid,
        p_expected_approved: op.expectedApproved,
        p_evidence: op.evidence,
      }),
    );
    if (
      receipt.shareholder_id !== op.shareholderId ||
      receipt.advance_amount !== op.advance ||
      receipt.through_month !== op.throughMonth ||
      receipt.as_of_date !== op.asOfDate ||
      receipt.evidence !== op.evidence
    )
      throw new Error('Biên nhận số dư đầu kỳ chưa khớp.');
    return receipt.opening_id;
  }
  const shared = {
    ...base,
    p_effective_date: op.effectiveDate,
    p_reference: op.reference,
    p_evidence: op.evidence,
    p_expected_available: op.expected,
  };
  if (op.action === 'source') {
    const receipt = fundReceipt
      .extend({ kind })
      .parse(await call('shared_fund_record_source_v1', { ...shared, p_kind: op.kind, p_amount: op.amount }));
    if (receipt.organization_id !== org || receipt.kind !== op.kind || receipt.amount !== op.amount)
      throw new Error('Biên nhận nguồn quỹ chưa khớp.');
    return receipt.id;
  }
  const receipt = fundReceipt
    .extend({ status: z.literal('POSTED'), advance_offset_amount: amount, payable_amount: amount })
    .parse(await call('shared_fund_distribute_v1', { ...shared, p_lines: op.lines }));
  const gross = op.lines.reduce((sum, r) => sum + r.amount, 0),
    offset = op.lines.reduce((sum, r) => sum + r.advance_offset_amount, 0);
  if (
    receipt.organization_id !== org ||
    receipt.amount !== gross ||
    receipt.advance_offset_amount !== offset ||
    receipt.payable_amount !== gross - offset
  )
    throw new Error('Biên nhận phân bổ chưa khớp.');
  return receipt.id;
}

export function useSharedFundWrite(org: string) {
  const client = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow('shared-fund'));
  return useMutation({
    mutationFn: (op: FundWrite) =>
      workflow.current.run(
        op.action,
        'ghi sổ quỹ chung',
        async (p) => ({ id: await write(org, op, p.requestKey), reconciled: false }),
        async (prior, p) => {
          const state = await readState(org);
          const recorded = priorFundReceipt(state, op.action, prior.userId, p.requestKey);
          if (recorded) return { result: { id: recorded, reconciled: true } };
          return { result: { id: await write(org, op, p.requestKey), reconciled: false } };
        },
        org,
      ),
    onSettled: () => invalidateProfitLedgerQueries(client),
  });
}
