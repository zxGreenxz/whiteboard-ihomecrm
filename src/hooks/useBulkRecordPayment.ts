// =============================================
// Bulk Record Payment Hook
// Each invoice is exactly one record_invoice_collection_v5 call containing
// every TM/TK/TT tender. There is no client-side write fallback.
// =============================================

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { useToast } from '@/hooks/use-toast';
import {
  deriveInvoiceDepositDue,
  planInvoiceCollection,
  recordInvoiceCollectionV5,
  type InvoiceCollectionPlanningInput,
  type InvoiceCollectionTenderInput,
} from '@/lib/paymentRecordRpc';
import { deriveOverpayPolicy } from '@/lib/collectPlan';

export interface BulkPaymentItem {
  invoice_id: string;
  invoice_number?: string;
  room_name?: string;
  amount_tm: number;
  amount_tk: number;
  amount_tt: number;
  /** Must equal the actual overpay; it is REFUND unless keep_as_credit=true. */
  change_amount: number;
  account_id: string;
  accounts?: Partial<Record<'TM' | 'TK' | 'TT', string>>;
  change_account_id: string | null;
  keep_as_credit?: boolean;
  receipt_image_url?: string | null;
  notes?: string;
  rounding_amount?: number;
  rounding_account_id?: string | null;
  /** Caller-owned stable key. The hook also caches one when omitted. */
  idempotency_key?: string;
}

export interface BulkPaymentParams {
  payment_date: string;
  items: BulkPaymentItem[];
}

export interface BulkPaymentFailure {
  invoice_id: string;
  invoice_number?: string;
  room_name?: string;
  message: string;
}

export interface BulkPaymentResult {
  ok: string[];
  failures: BulkPaymentFailure[];
  voucherIds?: string[];
}

interface PreparedAttempt {
  fingerprint: string;
  request: InvoiceCollectionPlanningInput;
  idempotencyKey: string;
}

const itemFingerprint = (paymentDate: string, item: BulkPaymentItem): string => JSON.stringify({
  payment_date: paymentDate,
  invoice_id: item.invoice_id,
  amount_tm: item.amount_tm,
  amount_tk: item.amount_tk,
  amount_tt: item.amount_tt,
  change_amount: item.change_amount,
  account_id: item.account_id,
  accounts: item.accounts ?? null,
  change_account_id: item.change_account_id,
  keep_as_credit: !!item.keep_as_credit,
  notes: item.notes?.trim() || null,
  rounding_amount: item.rounding_amount ?? 0,
  rounding_account_id: item.rounding_account_id ?? null,
  explicit_key: item.idempotency_key ?? null,
});

const resultVoucherIds = (result: unknown): string[] => {
  if (!result || typeof result !== 'object') return [];
  const tenders = (result as { tenders?: unknown }).tenders;
  if (!Array.isArray(tenders)) return [];
  return tenders
    .map((tender) => (tender as { voucher_id?: unknown })?.voucher_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
};

const rpcMessage = (error: unknown): string => {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || 'Lỗi ghi nhận collection');
  }
  return error instanceof Error ? error.message : 'Lỗi không xác định';
};

export const useBulkRecordPayment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const attemptsRef = useRef<Map<string, PreparedAttempt>>(new Map());

  return useMutation({
    mutationFn: async (params: BulkPaymentParams): Promise<BulkPaymentResult> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const ok: string[] = [];
      const failures: BulkPaymentFailure[] = [];
      const voucherIds: string[] = [];

      for (const item of params.items) {
        try {
          const fingerprint = itemFingerprint(params.payment_date, item);
          const cached = attemptsRef.current.get(item.invoice_id);
          let attempt = cached?.fingerprint === fingerprint ? cached : null;

          if (!attempt) {
            const { data: invoice, error: invoiceError } = await (supabase
              .from('invoices')
              .select(
                'id, invoice_number, total_amount, paid_amount, contract_id, previous_debt_sources, invoice_items(type, description, amount)',
              )
              .eq('id', item.invoice_id)
              .single() as any);
            if (invoiceError || !invoice) {
              throw invoiceError ?? new Error('Không đọc được hóa đơn');
            }

            const grossLines = [
              { payment_method: 'TM' as const, gross_amount: Number(item.amount_tm) || 0 },
              { payment_method: 'TK' as const, gross_amount: Number(item.amount_tk) || 0 },
              { payment_method: 'TT' as const, gross_amount: Number(item.amount_tt) || 0 },
            ].filter((line) => line.gross_amount > 0);
            if (grossLines.length === 0) throw new Error('Số tiền thanh toán bằng 0');

            const totalAmount = Number(invoice.total_amount) || 0;
            const paidAmount = Number(invoice.paid_amount) || 0;
            const remaining = Math.max(totalAmount - paidAmount, 0);
            const grossTotal = grossLines.reduce((sum, line) => sum + line.gross_amount, 0);
            const overpay = Math.max(grossTotal - remaining, 0);
            if (Math.abs((Number(item.change_amount) || 0) - overpay) >= 0.01) {
              throw new Error(
                `Tiền dư phải đúng phần vượt còn phải thu (${overpay.toLocaleString('vi-VN')}đ)`,
              );
            }
            const overpayPolicy = deriveOverpayPolicy({
              total: grossTotal,
              amountTm: Number(item.amount_tm) || 0,
              remaining,
              hasContract: !!invoice.contract_id,
            });
            const keepAsCredit = overpay > 0
              && (overpayPolicy.mustKeepAsCredit || !!item.keep_as_credit);
            if (keepAsCredit && !invoice.contract_id) {
              throw new Error('Hóa đơn không gắn hợp đồng nên không thể giữ credit');
            }
            if (overpay > 0 && !keepAsCredit && !item.change_account_id) {
              throw new Error('Thiếu sổ quỹ tiền thối');
            }

            const accountIds = new Set<string>();
            for (const line of grossLines) {
              const accountId = item.accounts?.[line.payment_method] ?? item.account_id;
              if (accountId) accountIds.add(accountId);
            }
            if (item.change_account_id) accountIds.add(item.change_account_id);
            if (item.rounding_account_id) accountIds.add(item.rounding_account_id);
            const { data: accountRows, error: accountError } = await (supabase
              .from('accounts')
              .select('id, is_virtual') as any)
              .in('id', [...accountIds]);
            if (accountError) throw accountError;
            const accountVirtuality = new Map(
              ((accountRows ?? []) as Array<{ id: string; is_virtual: boolean | null }>).map(
                (account) => [account.id, account.is_virtual],
              ),
            );

            const allowRounding = (Number(item.rounding_amount) || 0) > 0;
            if (
              overpay > 0
              && !keepAsCredit
              && accountVirtuality.get(item.change_account_id ?? '') !== true
            ) {
              throw new Error('Sổ quỹ tiền thối phải là sổ ảo');
            }
            if (
              allowRounding
              && accountVirtuality.get(item.rounding_account_id ?? '') !== true
            ) {
              throw new Error('Sổ quỹ làm tròn phải là sổ ảo');
            }
            const lastLineIndex = grossLines.length - 1;
            const tenders: InvoiceCollectionTenderInput[] = grossLines.map((line, index) => {
              const accountId = item.accounts?.[line.payment_method] ?? item.account_id;
              if (!accountId) throw new Error(`Thiếu sổ quỹ nhận cho ${line.payment_method}`);
              const accountIsVirtual = accountVirtuality.get(accountId);
              if (accountIsVirtual !== false) {
                throw new Error(`Sổ nhận ${line.payment_method} phải là sổ quỹ thật`);
              }
              return {
                payment_method: line.payment_method,
                gross_amount: line.gross_amount,
                account_id: accountId,
                account_is_virtual: accountIsVirtual,
                change_account_id:
                  overpay > 0 && !keepAsCredit && line.payment_method === 'TM'
                    ? item.change_account_id
                    : null,
                change_account_is_virtual:
                  overpay > 0 && !keepAsCredit && line.payment_method === 'TM'
                    ? accountVirtuality.get(item.change_account_id ?? '') ?? null
                    : null,
                rounding_account_id:
                  allowRounding && index === lastLineIndex
                    ? (item.rounding_account_id ?? null)
                    : null,
                rounding_account_is_virtual:
                  allowRounding && index === lastLineIndex
                    ? accountVirtuality.get(item.rounding_account_id ?? '') ?? null
                    : null,
              };
            });

            const request: InvoiceCollectionPlanningInput = {
              invoice_id: item.invoice_id,
              collection_date: params.payment_date,
              tenders,
              overpay_action: overpay > 0
                ? (keepAsCredit ? 'CREDIT' : 'REFUND')
                : 'REJECT',
              allow_rounding: allowRounding,
              notes: item.notes?.trim() || null,
              receipt_image_url: item.receipt_image_url ?? null,
              expected_paid_amount: paidAmount,
              invoice_total_amount: totalAmount,
              deposit_due: deriveInvoiceDepositDue(invoice),
              has_contract: !!invoice.contract_id,
            };
            planInvoiceCollection(request);
            attempt = {
              fingerprint,
              request,
              idempotencyKey: item.idempotency_key ?? `collect-${crypto.randomUUID()}`,
            };
            attemptsRef.current.set(item.invoice_id, attempt);
          }

          const result = await recordInvoiceCollectionV5(
            (fn, args) => supabase.rpc(fn, args),
            attempt.request,
            attempt.idempotencyKey,
          );
          voucherIds.push(...resultVoucherIds(result));
          attemptsRef.current.delete(item.invoice_id);
          ok.push(item.invoice_id);
        } catch (error) {
          failures.push({
            invoice_id: item.invoice_id,
            invoice_number: item.invoice_number,
            room_name: item.room_name,
            message: rpcMessage(error),
          });
        }
      }

      return { ok, failures, voucherIds };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-collectors'] });
      queryClient.invalidateQueries({ queryKey: ['handover-vouchers'] });
      queryClient.invalidateQueries({ queryKey: ['first-invoice-details'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['contract-deposit-vouchers'] });
    },
    onSuccess: (result) => {
      const okCount = result.ok.length;
      const failCount = result.failures.length;
      if (failCount === 0) {
        toast({ title: 'Hoàn tất ghi nhận thanh toán', description: `Thành công ${okCount} hoá đơn` });
      } else if (okCount === 0) {
        toast({ variant: 'destructive', title: 'Không ghi nhận được thanh toán', description: `Lỗi ${failCount} hoá đơn` });
      } else {
        toast({ title: 'Hoàn tất ghi nhận thanh toán', description: `Thành công ${okCount} — Lỗi ${failCount}` });
      }
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Có lỗi xảy ra', description: error.message });
    },
  });
};
