import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { prepareContractPayoutsWithSupport, executeContractPayoutOperation, readContractPayoutOperation,
  readContractPayoutRequest, type SupportPayoutInput } from '@/lib/rentSupportApi';
import type { PayoutOperation } from '@/lib/rentSupportFunding';

type Input = Omit<SupportPayoutInput, 'requestId'>;
interface SavedIntent { organizationId: string; input: SupportPayoutInput; operationId: string | null }
const INTERRUPTED = 'Yêu cầu đã lưu nhưng chưa hoàn tất hoặc chưa xác minh được kết quả. Hãy đối chiếu rồi Tạo lại đúng yêu cầu đã lưu.';

/** Durable bundle identity is kept before prepare; only an explicit retry executes it again. */
export function useRentSupportPayout(organizationId: string | null | undefined, contractId: string | null) {
  const cache = useQueryClient();
  const saved = useRef<SavedIntent | null>(null);
  const completed = useRef<{ fingerprint: string; operation: PayoutOperation } | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  const [pending, setPending] = useState<SavedIntent | null>(null);
  const [receipt, setReceipt] = useState<PayoutOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setBusy] = useState(false);
  useEffect(() => { generation.current++; saved.current = null; completed.current = null; setPending(null); setReceipt(null); setError(null); }, [organizationId, contractId]);

  const read = (intent: SavedIntent) => intent.operationId
    ? readContractPayoutOperation(intent.organizationId, intent.operationId)
    : readContractPayoutRequest(intent.organizationId, intent.input.requestId);
  const remember = (intent: SavedIntent, operation: PayoutOperation) => {
    if (operation.operation_id) intent.operationId = operation.operation_id;
    saved.current = intent;
    setPending({ ...intent });
  };
  const finish = (intent: SavedIntent, operation: PayoutOperation) => {
    if (operation.status !== 'COMPLETED') throw new Error(INTERRUPTED);
    completed.current = { fingerprint: JSON.stringify({ ...intent.input, requestId: undefined }), operation };
    saved.current = null; setPending(null); setReceipt(operation); setError(null);
    return operation;
  };
  const run = async (action: (current: number) => Promise<{ operation: PayoutOperation; recovered: boolean }>) => {
    if (locked.current) throw new Error('Yêu cầu đang được xử lý.');
    locked.current = true; setBusy(true); setError(null);
    const current = generation.current;
    try { return await action(current); }
    catch { if (generation.current === current) setError(INTERRUPTED); throw new Error(INTERRUPTED); }
    finally {
      locked.current = false;
      if (generation.current === current) setBusy(false);
      for (const key of ['contract-commission-followups', 'contract-rent-support', 'sale-bonus-status', 'income-expenses', 'accounts-with-balance', 'existing-commission-vouchers', 'commission-voucher-facts', 'manager-salary', 'rent-support-deposit-candidate'])
        void cache.invalidateQueries({ queryKey: [key] });
    }
  };
  const execute = async (intent: SavedIntent, current: number) => {
    try {
      if (!intent.operationId) {
        const prepared = await prepareContractPayoutsWithSupport(intent.organizationId, intent.input);
        if (generation.current !== current) throw new Error('scope changed');
        intent.operationId = prepared.operation_id; saved.current = intent; setPending({ ...intent });
        if (prepared.status === 'COMPLETED') return finish(intent, await read(intent));
      }
      const result = await executeContractPayoutOperation(intent.organizationId, intent.operationId);
      if (generation.current !== current) throw new Error('scope changed');
      remember(intent, result);
      return finish(intent, result);
    } catch {
      // A transport/COMMIT failure is not proof of rollback. READY remains pending.
      if (generation.current !== current) throw new Error(INTERRUPTED);
      const observed = await read(intent);
      remember(intent, observed);
      return finish(intent, observed);
    }
  };
  const submit = (input: Input) => run(async current => {
    if (!organizationId || !contractId || input.contractId !== contractId) throw new Error('scope');
    const fingerprint = JSON.stringify({ ...input, requestId: undefined });
    if (completed.current?.fingerprint === fingerprint) return { operation: completed.current.operation, recovered: true };
    const old = saved.current;
    if (old) {
      const observed = await read(old);
      if (generation.current !== current) throw new Error('scope');
      remember(old, observed);
      if (observed.status !== 'NOT_FOUND') return { operation: finish(old, observed), recovered: true };
      // Even NOT_FOUND only permits replacing a changed intent after this exact read.
      if (JSON.stringify({ ...old.input, requestId: undefined }) === fingerprint)
        return { operation: await execute(old, current), recovered: false };
    }
    const intent: SavedIntent = { organizationId, input: { ...input, requestId: crypto.randomUUID() }, operationId: null };
    saved.current = intent; setPending(intent); setReceipt(null);
    return { operation: await execute(intent, current), recovered: false };
  });
  const retry = () => run(async current => {
    const intent = saved.current;
    if (!intent) throw new Error('missing saved intent');
    const observed = await read(intent);
    if (generation.current !== current) throw new Error('scope');
    remember(intent, observed);
    if (observed.status === 'COMPLETED') return { operation: finish(intent, observed), recovered: true };
    return { operation: await execute(intent, current), recovered: false };
  });
  const reconcile = () => run(async current => {
    const intent = saved.current;
    if (!intent) throw new Error('missing saved intent');
    const observed = await read(intent);
    if (generation.current !== current) throw new Error('scope');
    remember(intent, observed);
    return { operation: finish(intent, observed), recovered: true };
  });
  return { submit, retry, reconcile, pending, receipt, error, isPending };
}
