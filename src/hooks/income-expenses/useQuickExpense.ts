import { useEffect, useRef, useState } from 'react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useAuth } from '@/hooks/useAuth';
import { fetchMyPermissions, useMyPermissions } from '@/hooks/useMyPermissions';
import { fetchFinanceV2ClientFlags, LEGACY_ROUTES, useFinanceV2Routes } from '@/lib/financeV2Route';
import { quickExpenseReason, quickExpenseBatchReason, quickExpenseBatchTargets, sameQuickExpenseBatchMembership, sameQuickExpenseBatchSnapshot, sameQuickExpenseSnapshot, type QuickExpenseContext, type QuickExpenseResult } from '@/lib/quickExpense';
import { loadIncomeExpenseBatch, readIncomeExpenseBatchMembership } from '@/hooks/useVoucherDetail';
import { todayISO } from '@/lib/collect';
import { FinancialWorkflowError, workflowErrorMessage } from '@/lib/financialWorkflow';
import { validatePostFinanceExecutionInput } from '@/lib/incomeExpensePostingValidation';
import { loadIncomeExpenseDetail, withDetailReadDeadline } from './detailRead';
import { adoptVoucherAttachmentsAsEvidence, prepareQuickExpenseBatchEvidence, useApproveAndPostIncomeExpenseV2, useCustodianCashbooksV2, useInvalidateMoney } from './financeV2Mutations';
import { incomeExpensesListQuery } from './queries';
import type { IncomeExpenseBatchSummary, IncomeExpenseFilters, IncomeExpenseWithRelations } from './types';

const rejectQuickExpense = (message: string) => new FinancialWorkflowError(message, 'failure', []);

export function useQuickExpense(scopeKey: string, readReady = true) {
  const { selectedOrganizationId } = useOrganization();
  const { data: user } = useAuth();
  const permissions = useMyPermissions();
  const routes = useFinanceV2Routes();
  const books = useCustodianCashbooksV2(!!selectedOrganizationId);
  const writer = useApproveAndPostIncomeExpenseV2({ deferFeedback: true });
  const invalidate = useInvalidateMoney();
  const scope = JSON.stringify([selectedOrganizationId, user?.id, scopeKey]);
  const currentScope = useRef(scope);
  const generation = useRef(0);
  if (currentScope.current !== scope) generation.current++;
  currentScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [selection, setSelection] = useState<{ scope: string; rows: IncomeExpenseWithRelations[] }>({ scope, rows: [] });
  const [results, setResults] = useState<QuickExpenseResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const checksError = permissions.isError || routes.isError || books.isError
    ? 'Chưa kiểm tra được quyền hoặc sổ quỹ. Hãy thử lại trước khi chi nhanh.' : null;
  const retryChecks = async () => { await Promise.all([permissions.refetch(), routes.refetch(), books.refetch()]); };
  const blocked = useRef(new Set<string>());
  const selected = selection.scope === scope ? selection.rows : [];
  useEffect(() => { setSelection({ scope, rows: [] }); }, [scope]);
  const ctx: QuickExpenseContext = {
    organizationId: selectedOrganizationId, permissions: permissions.data,
    routes: routes.getOrg(selectedOrganizationId), cashbookIds: new Set(books.data?.map(b => b.id)),
    ready: readReady && !!user?.id && permissions.isSuccess && !permissions.isFetching && routes.isSuccess && !routes.isFetching && books.isSuccess && !books.isFetching,
  };
  const reason = (v: IncomeExpenseWithRelations) => blocked.current.has(`${v.organization_id}:${v.id}`)
    ? 'Chưa xác nhận kết quả lần chi trước. Cần đối chiếu phiếu trước khi tiếp tục.' : checksError ?? quickExpenseReason(v, ctx);
  const batchReason = (batch: IncomeExpenseBatchSummary) => checksError ?? quickExpenseBatchReason(batch, ctx, reason);
  const clear = () => { if (!lock.current) setSelection({ scope, rows: [] }); };
  const toggle = (v: IncomeExpenseWithRelations, checked: boolean) => {
    if (lock.current || (checked && reason(v))) return;
    setSelection(old => {
      const rows = old.scope === scope ? old.rows.filter(r => r.id !== v.id) : [];
      return { scope, rows: checked ? [...rows, v] : rows };
    });
  };
  const togglePage = (rows: IncomeExpenseWithRelations[], checked: boolean) => {
    if (lock.current) return;
    const ids = new Set(rows.map(v => v.id));
    setSelection(old => ({ scope, rows: [
      ...(old.scope === scope ? old.rows.filter(v => !ids.has(v.id)) : []),
      ...(checked ? rows.filter(v => !reason(v)) : []),
    ] }));
  };

  async function selectAll(filters: IncomeExpenseFilters, search?: string) {
    if (lock.current || !ctx.ready || !selectedOrganizationId) return;
    lock.current = true;
    const startedGeneration = generation.current;
    setCollecting(true); setError(null);
    try {
      const rows: IncomeExpenseWithRelations[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      for (let page = 1; ; page++) {
        if (!mounted.current || generation.current !== startedGeneration) return;
        const result = await incomeExpensesListQuery(filters, { page, pageSize: 100 }, search, selectedOrganizationId).queryFn();
        if (total !== undefined && total !== result.totalCount) throw rejectQuickExpense('Danh sách vừa thay đổi. Vui lòng chọn lại.');
        total = result.totalCount;
        for (const row of result.data) {
          if (seen.has(row.id)) throw rejectQuickExpense('Danh sách vừa thay đổi. Vui lòng chọn lại.');
          seen.add(row.id);
          if (!reason(row)) rows.push(row);
        }
        if (seen.size === total) break;
        if (!result.data.length || seen.size > total) throw rejectQuickExpense('Chưa tải đủ danh sách phiếu. Vui lòng thử lại.');
      }
      if (mounted.current && generation.current === startedGeneration) setSelection({ scope, rows });
    } catch (e) { setError(workflowErrorMessage(e, 'chọn tất cả phiếu')); }
    finally { lock.current = false; setCollecting(false); }
  }

  async function run(rows: IncomeExpenseWithRelations[], batch?: IncomeExpenseBatchSummary) {
    if (lock.current || !rows.length || !ctx.ready) return;
    if (batch) {
      const invalid = batchReason(batch);
      if (invalid) { setError(invalid); return; }
    }
    lock.current = true;
    const startedGeneration = generation.current;
    setBusy(true); setError(null); setResults([]);
    setActiveBatchId(batch?.id ?? null);
    const targets = [...new Map((batch ? quickExpenseBatchTargets(batch) : rows).map(v => [v.id, v])).values()];
    setProgress({ done: 0, total: targets.length });
    const outcome: QuickExpenseResult[] = [];
    try {
      const [freshPermissions, freshRoutes, freshBooks] = await Promise.all([
        fetchMyPermissions(selectedOrganizationId), fetchFinanceV2ClientFlags(), books.refetch(),
      ]);
      if (freshBooks.error || !freshBooks.data) throw freshBooks.error ?? rejectQuickExpense('Chưa đọc được quyền sổ quỹ.');
      const freshCtx: QuickExpenseContext = { ...ctx, ready: true, permissions: freshPermissions,
        routes: freshRoutes.get(selectedOrganizationId ?? '') ?? LEGACY_ROUTES,
        cashbookIds: new Set(freshBooks.data.map(b => b.id)) };
      if (batch) {
        const freshBatch = await withDetailReadDeadline(loadIncomeExpenseBatch(batch.id, selectedOrganizationId!));
        if (!freshBatch || !sameQuickExpenseBatchSnapshot(batch, freshBatch)) throw rejectQuickExpense('Phiếu tổng hoặc danh sách phiếu con vừa thay đổi. Vui lòng tải lại trước khi chi nhanh.');
        const invalid = quickExpenseBatchReason(freshBatch, freshCtx);
        if (invalid) throw rejectQuickExpense(invalid);
      }
      let stopped = false;
      const postedOn = todayISO();
      for (const target of targets) {
        const result: QuickExpenseResult = { id: target.id, label: target.code || target.name, status: 'skipped', message: '' };
        setActiveId(target.id);
        try {
          if (stopped || !mounted.current || generation.current !== startedGeneration) throw rejectQuickExpense('Chưa gửi lệnh: đã dừng đợt xử lý hoặc bộ lọc/công ty đã thay đổi.');
          if (blocked.current.has(`${target.organization_id}:${target.id}`)) throw rejectQuickExpense('Chưa xác nhận lần chi trước. Cần đối chiếu phiếu.');
          const fresh = await withDetailReadDeadline(loadIncomeExpenseDetail(target.id, target.organization_id));
          if (!fresh || !sameQuickExpenseSnapshot(target, fresh)) throw rejectQuickExpense('Phiếu vừa thay đổi. Tải lại và kiểm tra trước khi chọn lại.');
          const invalid = quickExpenseReason(fresh, freshCtx);
          if (invalid) throw rejectQuickExpense(invalid);
          const evidence = batch ? await prepareQuickExpenseBatchEvidence(fresh) : await adoptVoucherAttachmentsAsEvidence(fresh.id);
          if (evidence.skipped.length || !evidence.evidenceIds.length) throw rejectQuickExpense('Chưa dùng được toàn bộ ảnh/chứng từ đã lưu. Hãy kiểm tra chứng từ của phiếu.');
          // Adoption is separate from money posting. Recheck attachments and the
          // snapshot afterwards; never silently use new attachments added meanwhile.
          const afterEvidence = await withDetailReadDeadline(loadIncomeExpenseDetail(target.id, target.organization_id));
          if (!afterEvidence || !sameQuickExpenseSnapshot(fresh, afterEvidence)) throw rejectQuickExpense('Phiếu vừa thay đổi khi kiểm tra chứng từ. Vui lòng chọn lại.');
          if (!mounted.current || generation.current !== startedGeneration) throw rejectQuickExpense('Chưa gửi lệnh chi vì bộ lọc/công ty đã thay đổi.');
          const input = { subjectKind: 'VOUCHER' as const, subjectId: fresh.id, organizationId: fresh.organization_id,
            cashbookId: fresh.account_id!, postedOn, evidenceIds: evidence.evidenceIds,
            expectedExecutionRevision: 0, expectedApprovalVersion: fresh.approval_version,
            expectedPostingVersion: fresh.posting_version, idempotencyKey: crypto.randomUUID() };
          const validation = validatePostFinanceExecutionInput(input);
          if (!validation.ok) throw rejectQuickExpense(Object.values(validation.errors).join(' '));
          if (batch) {
            const membership = await withDetailReadDeadline(readIncomeExpenseBatchMembership(batch.id, selectedOrganizationId!));
            if (!membership || !sameQuickExpenseBatchMembership(batch, membership)) throw rejectQuickExpense('Danh sách phiếu trong đợt vừa thay đổi. Đã dừng phần chưa chi; hãy tải lại và kiểm tra kết quả.');
            if (!mounted.current || generation.current !== startedGeneration) throw rejectQuickExpense('Chưa gửi lệnh chi vì bộ lọc/công ty đã thay đổi.');
          }
          await writer.mutateAsync(input);
          result.status = 'success'; result.message = 'Đã duyệt và chi.';
        } catch (e) {
          // A group is not one atomic transaction: stop on a child failure and
          // report each completed/remaining child rather than claim the group succeeded.
          if (batch) stopped = true;
          if (e instanceof FinancialWorkflowError && e.outcome !== 'failure') {
            result.status = 'unknown'; stopped = true;
            blocked.current.add(`${target.organization_id}:${target.id}`);
          }
          result.message = workflowErrorMessage(e, 'duyệt và chi nhanh');
        }
        outcome.push(result);
        setResults([...outcome]); setProgress({ done: outcome.length, total: targets.length });
      }
      // A retry always requires a deliberate fresh selection; successes cannot
      // remain in the batch, and uncertain outcomes remain blocked by the writer.
      setSelection(old => old.scope === scope ? { scope, rows: [] } : old);
    } catch (e) { setError(workflowErrorMessage(e, 'duyệt và chi nhanh')); }
    finally { invalidate(); lock.current = false; setBusy(false); setActiveId(null); setActiveBatchId(null); }
  }
  const runBatch = (batch: IncomeExpenseBatchSummary) => run(batch.vouchers, batch);
  return { reason, batchReason, runBatch, activeBatchId, busy, collecting, activeId, progress, selected, results, error: error ?? checksError,
    checksError, retryChecks, ready: ctx.ready, toggle, togglePage, clear, selectAll, run };
}

export type QuickExpenseActions = ReturnType<typeof useQuickExpense>;
