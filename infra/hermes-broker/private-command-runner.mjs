import { createHash, randomUUID } from 'node:crypto';
import { createDependencyScope } from './dependency-scope.mjs';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const COMMAND = ['commandId', ...OWNER, 'bindingId', 'bindingEpoch', 'text', 'expiresAt'];
const METHODS = ['claimPrivateCommand', 'dispatchPrivateCommand', 'finishPrivateCommand', 'failPrivateCommand', 'prunePrivateCommands'];
const CODES = new Set(['invalid_request', 'invalid_handle', 'backend_closed', 'busy', 'cancelled', 'timeout',
  'authority_unavailable', 'private_command_outcome_unknown']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= limit;

export class PrivateCommandRunnerError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'private_command_outcome_unknown';
    super(safe); this.name = 'PrivateCommandRunnerError'; this.code = safe;
    this.outcomeUnknown = safe === 'private_command_outcome_unknown';
  }
}
const fail = code => { throw new PrivateCommandRunnerError(code); };
function snapshot(value, keys, code = 'private_command_outcome_unknown') {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(code);
    return Object.freeze(Object.fromEntries(keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      return [key, descriptor.value];
    })));
  } catch { fail(code); }
}
function owner(value, now) {
  const copied = snapshot(value, [...OWNER, 'expiresAt'], 'authority_unavailable');
  // A renewed token expiry is DB clock_timestamp() + TTL.
  if (OWNER.some(key => !uuid(copied[key])) || !positive(copied.expiresAt) || copied.expiresAt <= now ||
      copied.expiresAt > now + 900000 + DB_CLOCK_SKEW_MS) fail('authority_unavailable');
  return copied;
}
function command(value, now) {
  const copied = snapshot(value, COMMAND);
  if (['commandId', ...OWNER, 'bindingId'].some(key => !uuid(copied[key])) || !positive(copied.bindingEpoch) ||
    !positive(copied.expiresAt) || copied.expiresAt <= now || !text(copied.text, 8192)) fail('private_command_outcome_unknown');
  return copied;
}
const sameOwner = (first, second) => OWNER.every(key => first[key] === second[key]);
function receipt(value, claimId, commandId, states) {
  const copied = snapshot(value, ['status', 'commandId', 'claimId']);
  if (!states.includes(copied.status) || copied.commandId !== commandId || copied.claimId !== claimId) fail('private_command_outcome_unknown');
  return copied;
}

/** Trusted explicit command pump. No HTTP/MCP route, polling, retry, JWT or Zalo
 * sender is provided here. Only a definite first dispatch ACK authorizes one
 * supervisor call. SQL owns durable claim/binding fencing across restarts; the
 * supervisor owns handle branding, runtime/profile isolation and execution drain.
 * The 120-second deadline bounds observation, not rollback. Admission remains
 * held until the operation and tracked inner dependencies actually settle,
 * including after cancellation. The backend must inject the same dependency
 * scope into its SQL/Auth adapters below their deadline races. An arbitrary
 * untracked adapter cannot prove underlying work drained through its result.
 */
export function createPrivateCommandRunner({ store, resolveConnection, supervisor, clock = Date.now,
  dependencyScope = createDependencyScope() } = {}) {
  if (METHODS.some(key => typeof store?.[key] !== 'function') || typeof resolveConnection !== 'function' ||
      typeof supervisor?.executePrivateCommand !== 'function' || typeof supervisor?.status !== 'function' || typeof clock !== 'function' ||
      typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') {
    throw new TypeError('invalid_private_command_runner_config');
  }
  const ports = Object.fromEntries(METHODS.map(key => [key, store[key].bind(store)]));
  const execute = supervisor.executePrivateCommand.bind(supervisor), status = supervisor.status.bind(supervisor);
  // Host-only upgrade: the legacy port cannot grant a trusted preview context.
  const executeDispatched = typeof supervisor.executeDispatchedPrivateCommand === 'function'
    ? supervisor.executeDispatchedPrivateCommand.bind(supervisor) : undefined;
  const pending = new Set(), tokens = new Set(); let closing = false, closePromise;
  const now = () => { const value = clock(); if (!positive(value)) fail('authority_unavailable'); return value; };
  const signalFrom = options => {
    const copied = snapshot(options, ['signal'], 'invalid_request');
    if (!(copied.signal instanceof AbortSignal)) fail('invalid_request');
    return copied.signal;
  };
  const beginSafe = start => {
    try { return start(); }
    catch (error) {
      const result = Promise.reject(error instanceof PrivateCommandRunnerError ? error : new PrivateCommandRunnerError('authority_unavailable'));
      void result.catch(() => {});
      return Object.freeze({ result, drained: Promise.resolve() });
    }
  };
  const runBounded = (key, signal, work) => {
    if (closing) fail('backend_closed');
    if (signal.aborted) fail('cancelled');
    if (pending.size >= 16 || (key && tokens.has(key))) fail('busy');
    const controller = new AbortController(), deadline = now() + 120000;
    const entry = { controller, mutated: false }; let rejectStop;
    const outcome = code => new PrivateCommandRunnerError(entry.mutated ? 'private_command_outcome_unknown' : code);
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    entry.stop = code => { entry.stopReason ??= code; controller.abort(); rejectStop(outcome(entry.stopReason)); };
    const onAbort = () => entry.stop('cancelled'); signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => entry.stop('timeout'), 120000);
    const context = {
      options: Object.freeze({ signal: controller.signal }),
      check() {
        if (closing || signal.aborted || controller.signal.aborted) throw outcome(entry.stopReason ?? 'cancelled');
        if (now() >= deadline) { entry.stop('timeout'); throw outcome('timeout'); }
      },
      write() { context.check(); entry.mutated = true; },
      remaining() { context.check(); return Math.min(120000, deadline - now()); },
    };
    if (key) tokens.add(key); pending.add(entry);
    const stopObservation = () => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    };
    const release = () => {
      stopObservation();
      pending.delete(entry); if (key) tokens.delete(key);
    };
    let operation;
    try { operation = dependencyScope.begin(() => work(context)); }
    catch (error) { release(); throw error; }
    entry.work = operation.result.catch(error => {
      if (entry.mutated) throw outcome('private_command_outcome_unknown');
      throw new PrivateCommandRunnerError(error instanceof PrivateCommandRunnerError ? error.code : 'authority_unavailable');
    });
    entry.drained = operation.drained.then(release, () => {
      // A broken drain receipt cannot free token/global admission or authorize
      // outer composition to close the pool while real work may remain.
      stopObservation(); entry.stop('private_command_outcome_unknown');
      fail('private_command_outcome_unknown');
    });
    void entry.drained.catch(() => {});
    const result = Promise.race([entry.work, stopped]); void result.catch(() => {});
    return Object.freeze({ result, drained: entry.drained });
  };
  const beginRun = (token, handle, options) => beginSafe(() => {
      const signal = signalFrom(options);
      if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token)) fail('invalid_request');
      if (closing) fail('backend_closed');
      try {
        const current = snapshot(status(handle), ['state', 'expiresAt'], 'invalid_handle');
        if (current.state !== 'active' || !positive(current.expiresAt) || current.expiresAt <= now()) fail('invalid_handle');
      } catch { fail('invalid_handle'); }
      const tokenDigest = createHash('sha256').update(token).digest('hex');
      return runBounded(tokenDigest, signal, async context => {
        const { options: operationOptions } = context;
        context.check(); const initial = owner(await resolveConnection(token, operationOptions), now()); context.check();
        const claimId = randomUUID(), input = Object.freeze({ tokenDigest, claimId });
        context.write(); const raw = await ports.claimPrivateCommand(input, operationOptions); context.check();
        let state; try { state = Object.getOwnPropertyDescriptor(raw, 'status')?.value; } catch { fail('private_command_outcome_unknown'); }
        if (state === 'empty') {
          if (snapshot(raw, ['status']).status !== 'empty') fail('private_command_outcome_unknown');
          return Object.freeze({ status: 'empty' });
        }
        const claimed = snapshot(raw, ['status', 'claimId', 'command']);
        if (claimed.status !== 'claimed' || claimed.claimId !== claimId) fail('private_command_outcome_unknown');
        const item = command(claimed.command, now());
        const currentOwner = async () => {
          context.check(); const current = owner(await resolveConnection(token, operationOptions), now()); context.check();
          if (!sameOwner(initial, current) || !sameOwner(item, current) || item.expiresAt <= now()) fail('private_command_outcome_unknown');
        };
        await currentOwner(); context.check();
        const dispatched = receipt(await ports.dispatchPrivateCommand(input, operationOptions), claimId, item.commandId, ['dispatched', 'already_dispatched']);
        context.check(); if (dispatched.status !== 'dispatched') fail('private_command_outcome_unknown');
        let response;
        try {
          context.check();
          const runtimeOptions = { signal: operationOptions.signal, timeoutMs: context.remaining() };
          // This branch is reachable only after the first definite dispatch ACK.
          // The claim remains in the host; it is never part of item or prompt.
          response = snapshot(await (executeDispatched
            ? executeDispatched(handle, item, Object.freeze({ token, claimId }), runtimeOptions)
            : execute(handle, item, runtimeOptions)), ['text']);
          context.check(); if (!text(response.text, 32768)) fail('private_command_outcome_unknown');
        } catch {
          // Only a settled runtime failure enters this path. Never compensate an
          // unknown dispatch or finish write; a lost finish ACK may mean READY.
          try {
            await currentOwner(); context.check();
            receipt(await ports.failPrivateCommand(Object.freeze({ ...input, reason: 'runtime_unknown' }), operationOptions),
              claimId, item.commandId, ['failed', 'unknown']);
          } catch { /* Unknown cleanup is terminal for this run; never retry. */ }
          fail('private_command_outcome_unknown');
        }
        await currentOwner(); context.check();
        receipt(await ports.finishPrivateCommand(Object.freeze({ ...input, text: response.text }), operationOptions),
          claimId, item.commandId, ['ready', 'already_ready']);
        context.check(); return Object.freeze({ status: 'ready', commandId: item.commandId });
      });
  });
  const beginPrune = (input, options) => beginSafe(() => {
      const copied = snapshot(input, ['limit'], 'invalid_request'), signal = signalFrom(options);
      if (!positive(copied.limit) || copied.limit > 256) fail('invalid_request');
      return runBounded(undefined, signal, async context => {
        context.write(); const result = snapshot(await ports.prunePrivateCommands(copied, context.options), ['status', 'count']); context.check();
        if (result.status !== 'pruned' || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > copied.limit) fail('private_command_outcome_unknown');
        return result;
      });
  });
  return Object.freeze({
    beginRun, beginPrune,
    run(token, handle, options) { return beginRun(token, handle, options).result; },
    prune(input, options) { return beginPrune(input, options).result; },
    close() {
      if (closePromise) return closePromise;
      closing = true; for (const entry of pending) entry.stop('backend_closed');
      closePromise = Promise.allSettled([...pending].map(entry => entry.drained)).then(results => {
        if (results.some(result => result.status === 'rejected')) fail('private_command_outcome_unknown');
      });
      return closePromise;
    },
  });
}
