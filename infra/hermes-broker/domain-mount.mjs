import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createSupabaseDomainReads } from './domain-adapter.mjs';
import { CACHED_READ_OPERATIONS, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { createSupabaseDomainFastReads, domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
export function createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now, readAuthority } = {}) {
  const reads = createSupabaseDomainReads({ ...supabase, dependencyScope, fetch });
  return Object.freeze({ authority, createService() {
    const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads,
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainResult, clock });
    if (!readAuthority) return Object.freeze({ prepareDomain: service.prepare, finalizeDomain: service.finalize });
    const fast = createBoundUserOperationService({ authority: readAuthority, connectionStore, crypto, auth,
      reads: createSupabaseDomainFastReads({ ...supabase, dependencyScope, fetch }),
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainFastResult, clock, admission: 'initialRead' });
    // B2-2: the reviewed RPC and seven-key live binding of every other eligible domain, admitted through the
    // bounded read catalog; the SQL statement is the one live check. Domains whose key the read catalog cannot
    // grant (zalo_conversations) keep the full service, exactly as without the opt-in.
    const cached = createBoundUserOperationService({ authority: readAuthority, connectionStore, crypto, auth, reads,
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainResult, clock, admission: 'cachedBinding' });
    const issued = new WeakMap();
    return Object.freeze({ readAuthority, fastReadOperations: FAST_READ_OPERATIONS, cachedReadOperations: CACHED_READ_OPERATIONS,
      async prepareDomain(token, operation, input, options) {
        const selected = FAST_READ_OPERATIONS.includes(operation) ? fast : CACHED_READ_OPERATIONS.includes(operation) ? cached : service;
        const receipt = await selected.prepare(token, operation, input, options); issued.set(receipt, selected); return receipt;
      },
      async finalizeDomain(token, receipt, options) {
        const selected = issued.get(receipt); issued.delete(receipt);
        if (!selected) throw new TypeError('invalid_domain_receipt');
        return selected.finalize(token, receipt, options);
      } });
  } });
}
