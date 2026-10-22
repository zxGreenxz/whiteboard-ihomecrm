import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { saleBulkInput, mayUseSaleBulk } from './sale-bulk-contract.mjs';

// Each item uses the existing FULL bound-user service. No cached read admission,
// parallel writes, automatic retries or invented database transaction for a batch.
export function createSaleBulkService({ authority, saleActions } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, saleActions?.prepareSaleAction, saleActions?.finalizeSaleAction].some(fn => typeof fn !== 'function'))
    throw new TypeError('invalid_sale_bulk_service');
  const issued = new WeakMap(), digest = token => createHash('sha256').update(token).digest('hex');
  return Object.freeze({
    async prepareSaleBulk(token, operation, supplied, { signal } = {}) {
      const input = saleBulkInput(operation, supplied), identity = await authority.resolve(token, { signal });
      if (!mayUseSaleBulk(identity.effective, operation, input)) throw new BrokerError('forbidden');
      const receipt = Object.freeze({}); issued.set(receipt, { input, operation, identity: structuredClone(identity), authorityReceipt: identity, tokenDigest: digest(token) }); return receipt;
    },
    async finalizeSaleBulk(token, receipt, { signal, onDispatch = () => {}, onRejected = () => {} } = {}) {
      const saved = issued.get(receipt); issued.delete(receipt);
      if (!saved || digest(token) !== saved.tokenDigest) throw new BrokerError('context_changed');
      await authority.checkUnchanged(token, saved.authorityReceipt, { signal });
      const items = []; let stopped = false;
      for (const item of saved.input.items) {
        const base = { requestId: item.requestId, roomId: item.roomId };
        if (stopped || signal?.aborted) { items.push({ ...base, outcome: 'not_attempted', code: 'batch_stopped', receipt: null }); continue; }
        let dispatched = false, rejected = false;
        try {
          const input = saved.operation === 'status' ? { requestId: item.requestId } : item;
          const prepared = await saleActions.prepareSaleAction(token, saved.operation, input, { signal });
          const result = await saleActions.finalizeSaleAction(token, prepared, { signal,
            onDispatch() { dispatched = true; onDispatch(); }, onRejected() { rejected = true; } });
          if (result.requestId !== item.requestId || result.organizationId !== saved.identity.row.organizationId ||
              result.outcome === 'applied' && (result.operation !== 'patch' || result.receipt?.roomId !== item.roomId))
            throw new BrokerError('backend_unavailable');
          items.push({ ...base, outcome: result.outcome, code: null, receipt: result.receipt });
          if (result.outcome === 'unknown') stopped = true;
        } catch (error) {
          // A failed reconciliation does not tell us whether the earlier write
          // committed, even when the current status request was denied/conflicted.
          const unknown = saved.operation === 'status' || dispatched && !rejected;
          const outcome = unknown ? 'unknown' : error.code === 'context_changed' ? 'conflict' :
            ['forbidden', 'unauthorized', 'tool_not_available'].includes(error.code) ? 'denied' :
              error.code === 'invalid_request' ? 'invalid' : saved.operation === 'status' ? 'unknown' : 'not_attempted';
          items.push({ ...base, outcome, code: unknown ? 'sale_outcome_unknown' :
            ['context_changed', 'forbidden', 'unauthorized', 'tool_not_available', 'invalid_request'].includes(error.code) ? error.code : 'backend_unavailable', receipt: null });
          if (unknown || outcome === 'unknown' || signal?.aborted || error.code === 'unauthorized') stopped = true;
        }
      }
      if (!items.some(item => ['applied', 'unknown'].includes(item.outcome))) onRejected();
      return { organizationId: saved.identity.row.organizationId, requestId: saved.input.requestId,
        operation: saved.operation, outcome: items.some(item => item.outcome === 'unknown') ? 'unknown' :
          items.every(item => item.outcome === 'applied') ? 'completed' : 'partial', items };
    },
  });
}
