import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createSupabaseDomainReads } from './domain-adapter.mjs';
import { domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
export function createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createSupabaseDomainReads({ ...supabase, dependencyScope, fetch });
  return Object.freeze({ authority, createService() {
    const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads,
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainResult, clock });
    return Object.freeze({ prepareDomain: service.prepare, finalizeDomain: service.finalize });
  } });
}
