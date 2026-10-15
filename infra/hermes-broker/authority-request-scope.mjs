import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-local reuse window for DurableAuthority, opened only by the broker
 * around ONE MCP invocation. It is not a permission cache: nothing outlives the
 * invocation, nothing is shared between requests, tokens or authority instances.
 *
 * Inside the window the broker marks two checkpoints. In each checkpoint ONLY
 * the broker's own fresh authority result (call options carrying
 * BROKER_AUTHORITY) is offered, and it may be consumed exactly once more by the
 * service it immediately delegates to (prepare at admission, finalize after the
 * audit). A service's own resolve is always fresh and never offered; a
 * checkUnchanged never accepts the very receipt it compares against. Any
 * resolve outside a broker invocation and every resolve after
 * advanceAuthorityRequest() reads Auth/SQL again. Revocation is therefore still
 * observed by every new request and at the final pre-release check.
 */
const storage = new AsyncLocalStorage();

/** Call-option key set only by the broker dispatcher on its own authority calls. */
export const BROKER_AUTHORITY = Symbol('hermes.broker-authority');

export function runAuthorityRequest(work) {
  if (typeof work !== 'function') throw new TypeError('invalid_authority_request');
  return storage.run({ checkpoint: 0, entries: new Map() }, work);
}

/** Close the current checkpoint; nothing from it can be reused afterwards. */
export function advanceAuthorityRequest() {
  const scope = storage.getStore();
  if (scope) { scope.checkpoint += 1; scope.entries = new Map(); }
}

/** Trusted authority use only. Returns undefined outside a broker invocation. */
export function authorityRequestEntries(owner) {
  const scope = storage.getStore();
  if (!scope) return undefined;
  let entries = scope.entries.get(owner);
  if (!entries) { entries = new Map(); scope.entries.set(owner, entries); }
  return entries;
}
