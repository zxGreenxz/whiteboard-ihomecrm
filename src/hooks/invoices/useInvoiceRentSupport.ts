import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseFormReturn } from 'react-hook-form';
import type { InvoiceEntryValues } from '@/lib/invoiceEntry';
import type { InvoiceFormData } from '@/types/invoice';
import {
  invoiceRentSupportContextSchema, previewInvoiceRentSupport, quoteInvoiceRentSupport,
  readInvoiceRentSupportPlan, readSavedInvoiceSupportRequest,
} from '@/lib/invoiceRentSupport';

const PREVIEW_REQUEST = '00000000-0000-4000-8000-000000000001';
const SUPPORT_CHECKING = 'Đang kiểm tra hỗ trợ của tháng và các khoản thu...';
interface Options {
  organizationId: string | null;
  contractId: string;
  enabled: boolean;
  items: InvoiceFormData['items'];
  credit: number;
  initialSupport?: number;
  initialCredit?: number;
  invoiceId?: string;
  kind?: 'MONTHLY' | 'SETTLEMENT';
}

/** Keep the saved/previous automatic parts out of the user's manual discount. */
export function useInvoiceRentSupport<T extends InvoiceEntryValues>(form: UseFormReturn<T>, options: Options) {
  const { organizationId, contractId, enabled, items, credit, invoiceId, kind = 'MONTHLY' } = options;
  const values = form.watch();
  const subject = `${organizationId}|${contractId}|${invoiceId ?? ''}`;
  const parts = useRef({ subject, support: options.initialSupport ?? 0, credit: options.initialCredit ?? 0 });
  if (parts.current.subject !== subject) parts.current = { subject, support: options.initialSupport ?? 0, credit: options.initialCredit ?? 0 };
  const manual = (values.discount_amount || 0) - parts.current.support - parts.current.credit;
  const plan = useQuery({
    queryKey: ['invoice-support-plan', organizationId, contractId],
    enabled: enabled && !!organizationId && !!contractId,
    queryFn: async () => {
      const result = await readInvoiceRentSupportPlan(organizationId!, contractId);
      if (!result) throw new Error('Chưa có lịch hỗ trợ hợp lệ.');
      return result;
    },
    staleTime: 0,
  });
  const revenue = items.reduce((sum, item) => sum + (item.accounting_class === 'DEPOSIT' || item.accounting_class === 'NON_PNL' ? 0 : item.unit_price * item.quantity * item.coefficient), 0);
  const preview = plan.data ? previewInvoiceRentSupport(plan.data.schedule, values.billing_month, Math.max(0, revenue - Math.max(0, manual) - credit), kind) : undefined;
  useEffect(() => {
    if (!enabled || !preview || preview.state !== 'READY') return;
    const current = form.getValues();
    const manualAmount = (current.discount_amount || 0) - parts.current.support - parts.current.credit;
    if (manualAmount < 0) return;
    const total = manualAmount + preview.amount + credit;
    parts.current = { subject, support: preview.amount, credit };
    // RHF generics may contain extra fields; only invoice fields are written.
    const entry = form as unknown as UseFormReturn<InvoiceEntryValues>;
    if (current.discount_amount !== total) entry.setValue('discount_amount', total);
    if (current.applied_credit !== credit) entry.setValue('applied_credit', credit);
  }, [enabled, subject, preview?.amount, preview?.state, credit, values.discount_amount, form]);
  const context = plan.data && manual >= 0 ? invoiceRentSupportContextSchema.parse({ version: 1, expected_plan_revision: plan.data.revision, manual_discount_amount: String(manual), request_id: PREVIEW_REQUEST }) : undefined;
  const fingerprint = JSON.stringify([organizationId, contractId, plan.data?.revision, values.billing_month, items, manual, credit, kind]);
  const quote = useQuery({
    queryKey: ['invoice-support-quote', organizationId, contractId, plan.data?.revision, values.billing_month, items, manual, credit, kind],
    enabled: enabled && !!organizationId && !!context && preview?.state === 'READY',
    queryFn: async () => ({ fingerprint, value: await quoteInvoiceRentSupport(organizationId!, contractId, values.billing_month, items.map(item => ({ ...item })), credit, context!, kind) }),
    staleTime: 0,
  });
  const ready = !enabled || (!!quote.data && quote.data.fingerprint === fingerprint && quote.data.value.state === 'READY' && Number(quote.data.value.invoice_support) === preview?.amount && quote.data.value.plan_revision === plan.data?.revision && quote.data.value.billing_month === values.billing_month && !quote.isFetching && !plan.isFetching && !plan.isError && !quote.isError && preview?.state === 'READY');
  const error = !enabled ? null : plan.isError || quote.isError ? 'Không kiểm tra được hỗ trợ; vui lòng tải lại trước khi lưu.' : manual < 0 ? 'Giảm trừ phải đủ phần hỗ trợ và credit đã chọn.' : preview?.state === 'NEEDS_REVIEW' || quote.data?.value.state === 'NEEDS_REVIEW' ? 'Hỗ trợ vượt doanh thu đủ điều kiện; cần đối chiếu.' : !ready ? SUPPORT_CHECKING : null;
  /** Chỉ là đang chờ kiểm hỗ trợ (không phải lỗi): giao diện hiện vạch xám thay câu chữ
   *  (chủ chốt 02/10/2026). `error` giữ nguyên để chặn lưu và làm câu báo khi bấm lưu.
   *  Không còn lượt đọc nào chạy mà vẫn chưa sẵn sàng (vd. số máy chủ lệch số trên màn) thì
   *  KHÔNG phải đang chờ: hiện lại câu chữ để biết vì sao nút Lưu khoá (review PR #116). */
  const checking = error === SUPPORT_CHECKING && (plan.isFetching || quote.isFetching);
  const intent = useRef<{ fingerprint: string; requestId: string; organizationId: string; contractId: string; invoiceId?: string } | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const prepare = async (payload: InvoiceFormData, { readbackOnly = false }: { readbackOnly?: boolean } = {}) => {
    // Resolve the previous attempt even when the user has changed month/form/org.
    if (intent.current) {
      const old = intent.current;
      const saved = await readSavedInvoiceSupportRequest(old.organizationId, old.contractId, old.requestId, old.invoiceId);
      if (saved) return { context: undefined, saved };
    }
    // A blocked form may verify the durable attempt, never replace its identity
    // or prepare a new write just because the edited payload quotes as READY.
    if (readbackOnly) return { context: undefined, saved: null };
    if (!enabled) return { context: undefined, saved: null };
    if (!ready || !context || !organizationId) throw new Error(error ?? 'Chưa kiểm tra được hỗ trợ.');
    const nextFingerprint = JSON.stringify([organizationId, invoiceId, payload, context.expected_plan_revision, context.manual_discount_amount]);
    if (!intent.current || intent.current.fingerprint !== nextFingerprint) intent.current = { fingerprint: nextFingerprint, requestId: globalThis.crypto.randomUUID(), organizationId, contractId, invoiceId };
    setHasPending(true);
    return { context: { ...context, request_id: intent.current.requestId }, saved: null };
  };
  return { ready, error, checking, manual, support: preview?.amount ?? parts.current.support, credit, prepare, hasPending,
    resetParts: () => { parts.current = { subject, support: options.initialSupport ?? 0, credit: options.initialCredit ?? 0 }; },
    clear: () => { intent.current = null; setHasPending(false); }, refetch: async () => { await plan.refetch(); await quote.refetch(); } };
}
