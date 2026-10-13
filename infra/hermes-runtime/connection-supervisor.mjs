import { ProfileLeaseStore } from './profile-lease.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const integer = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw new Error(code); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);
const ownerKeys = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const commandKeys = ['commandId', ...ownerKeys, 'bindingId', 'bindingEpoch', 'text', 'expiresAt'];
const plainText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= limit;
const snapshotExact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('invalid_object');
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail('invalid_object');
    return [key, descriptor.value];
  })));
};

/** Single-host trusted supervisor. The caller supplies live authority resolution,
 * not a UI-claimed owner. ProfileLeaseStore is acquired here and never exported.
 * Runtime.prepare is synchronous and MUST only allocate an inert handle (no I/O).
 * The supervisor holds that handle BEFORE runtime.start may create resources.
 * Runtime.start MUST start with admission disabled; setAdmission is synchronous
 * and fail-closed. stop resolves only when the runtime can no longer execute.
 * A failed stop retains the profile lock. No crash takeover or automatic restart.
 * Timers are scheduling hints; backend enforces DB expiry, hard age and revocation.
 * This module owns neither the backend nor its lifecycle. It drains promises it
 * invokes; nested adapters own cancellation of their underlying transports.
 * Private delivery accepts only a trusted, database-derived claim and a branded
 * handle. The database must also fence binding/claim ownership and deduplicate
 * across process restarts. Local command IDs are never evicted or replayed;
 * exhausting the bounded set requires a new connection handle. A deadline ends
 * the caller's wait, not ownership: ignored-abort work keeps the profile busy
 * and locked until it actually settles. Runtime receives no connection token.
 * beginStart synchronously brands a handle before any lookup or runtime I/O;
 * its ready promise preserves start's admission checks. stop accepts that handle
 * during startup and retains capacity until both startup and runtime stop drain.
 * Production composition supplies the same dependencyScope to this module and
 * the command runner. A runtime beginExecutePrivateCommand result/drained port
 * separates early cancellation from actual work drain; legacy execute-only
 * adapters promise that their returned promise covers all underlying work.
 * Only command work inherits its request scope;
 * persistent startup callbacks must not inherit a completed command scope.
 * Coordinated renewal parks admission while the host has drained its whole
 * command pump. The old expiry watchdog remains authoritative until maintenance
 * AND fresh authority work actually drain. No cancellation/late ACK can reopen
 * a stopped instance; an invalid drain contract retains the lease for review.
 */
export function createConnectionSupervisor({ profileStore, backend, runtime,
  clock = Date.now, timers = { setTimeout, clearTimeout }, renewBeforeMs = 120000, maxProfiles = 64,
  maxRememberedCommands = 1024, dependencyScope, renewalMode = 'automatic' } = {}) {
  if (!(profileStore instanceof ProfileLeaseStore) || typeof backend?.resolveConnection !== 'function' ||
      !['automatic', 'coordinated'].includes(renewalMode) ||
      (renewalMode === 'automatic' ? typeof backend?.renewConnection !== 'function' :
        typeof backend?.beginConnectionMaintenance !== 'function' || typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') ||
      ['prepare', 'start', 'setAdmission', 'stop'].some(key => typeof runtime?.[key] !== 'function') ||
      typeof clock !== 'function' || typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function' ||
      !integer(renewBeforeMs) || renewBeforeMs > 300000 || !integer(maxProfiles) || maxProfiles > 256 ||
      !integer(maxRememberedCommands) || maxRememberedCommands > 4096 ||
      (dependencyScope !== undefined && typeof dependencyScope?.track !== 'function')) fail('invalid_supervisor_config');
  const commandContexts = new WeakMap();
  const handles = new WeakMap(), entries = new Set(), connections = new Set(), pending = new Set();
  let closing = false, closePromise;
  const now = () => { const value = clock(); if (!integer(value)) fail('invalid_clock'); return value; };
  const track = promise => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const cancelTimers = entry => { for (const timer of entry.timers) timers.clearTimeout(timer); entry.timers.clear(); };
  const halt = (entry, reason) => {
    if (entry.stopping) return entry.stopping;
    entry.state = reason; cancelTimers(entry); entry.controller.abort();
    // Close the local gate synchronously before awaiting any adapter cleanup.
    let gateError;
    if (entry.instance !== undefined) { try { runtime.setAdmission(entry.instance, false); } catch (error) { gateError = error; } }
    const stopRuntime = () => {
      if (entry.instance === undefined) return;
      if (!entry.runtimeStopping) {
        try { runtime.setAdmission(entry.instance, false); } catch (error) { gateError ??= error; }
        entry.runtimeStopping = Promise.resolve().then(() => runtime.stop(entry.instance));
        void entry.runtimeStopping.catch(() => {});
      }
      return entry.runtimeStopping;
    };
    // A runtime may need stop() to finish start(). Begin interruption now, but
    // never release its lease merely because stop settled before late startup.
    stopRuntime();
    entry.stopping = track((async () => {
      await entry.ready;
      // Also handles an instance returned by a reentrant prepare after halt.
      // A broken local gate must never suppress the independent stop attempt.
      const runtimeStopped = stopRuntime();
      // Keep ownership/admission capacity until the single in-flight renewal
      // settles, even after the runtime itself stopped. No overlapping restart.
      // Delivery may still be inside an adapter which ignored its AbortSignal.
      // It never awaits halt(), so draining it here cannot form a wait cycle.
      // A failed runtime stop must not hide still-running maintenance work.
      const results = await Promise.allSettled([runtimeStopped, entry.renewing, entry.command?.work, entry.maintenance?.work]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (gateError) fail('runtime_gate_failed');
      await entry.lease?.release();
      connections.delete(entry.connectionId); entries.delete(entry); entry.token = undefined;
    })());
    return entry.stopping;
  };
  const schedule = (entry, delay, action) => {
    const timer = timers.setTimeout(() => { entry.timers.delete(timer); action(); }, Math.max(1, delay));
    entry.timers.add(timer);
  };
  const arm = entry => {
    cancelTimers(entry);
    if (entry.state !== 'active' || closing) return;
    const remaining = entry.expiresAt - now();
    if (remaining <= 0) { void halt(entry, 'expired').catch(() => {}); return; }
    schedule(entry, remaining, () => { void halt(entry, 'expired').catch(() => {}); });
    if (renewalMode === 'coordinated') return;
    schedule(entry, Math.max(1, remaining - renewBeforeMs), () => {
      if (entry.state !== 'active' || entry.renewing || closing) return;
      entry.renewing = track((async () => {
        try {
          if (entry.expiresAt <= now()) fail('expired');
          const result = await backend.renewConnection(entry.token, { signal: entry.controller.signal });
          if (entry.state !== 'active' || closing || entry.controller.signal.aborted) return;
          if (!exact(result, ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled']) || result.ok !== true || result.status !== 'renewed' ||
              result.connectionId !== entry.connectionId || typeof result.reconciled !== 'boolean' || !integer(result.expiresAt) ||
              result.expiresAt <= entry.expiresAt || result.expiresAt > entry.expiresAt + 900000 || result.expiresAt <= now()) fail('invalid_renewal');
          entry.expiresAt = result.expiresAt; arm(entry);
        } catch { void halt(entry, 'reconnect_required').catch(() => {}); }
      })());
      void entry.renewing.then(() => { entry.renewing = undefined; }, () => { entry.renewing = undefined; });
    });
  };
  const beginStart = raw => {
    if (closing) fail('supervisor_closed');
    let input; try { input = snapshotExact(raw, ['token', 'home']); } catch { fail('invalid_start'); }
    const { token, home } = input;
    if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token) || typeof home !== 'string') fail('invalid_start');
    if (entries.size >= maxProfiles) fail('supervisor_busy');
    const handle = Object.freeze({});
    const entry = { token, controller: new AbortController(), timers: new Set(), state: 'starting', expiresAt: null, commandIds: new Set() };
    entries.add(entry); handles.set(handle, entry);
    let ready; entry.ready = new Promise(resolve => { ready = resolve; });
    const work = Promise.resolve().then(async () => {
      try {
        if (closing || entry.controller.signal.aborted) fail('supervisor_closed');
        let identity = await backend.resolveConnection(token, { signal: entry.controller.signal });
        if (closing || entry.controller.signal.aborted) fail('supervisor_closed');
        if (!exact(identity, ['connectionId', 'assistantId', 'userId', 'organizationId', 'expiresAt']) ||
            ['connectionId', 'assistantId', 'userId', 'organizationId'].some(key => !uuid.test(identity[key])) ||
            !integer(identity.expiresAt) || identity.expiresAt <= now() || identity.expiresAt > now() + 900000) fail('invalid_identity');
        identity = Object.freeze(Object.fromEntries(['connectionId', 'assistantId', 'userId', 'organizationId', 'expiresAt'].map(key => [key, identity[key]])));
        if (connections.has(identity.connectionId)) fail('connection_in_use');
        entry.identity = identity; entry.connectionId = identity.connectionId; connections.add(entry.connectionId); entry.expiresAt = identity.expiresAt;
        const binding = Object.freeze({ assistantId: identity.assistantId, userId: identity.userId, organizationId: identity.organizationId, home });
        entry.lease = await profileStore.acquire(binding);
        if (closing || entry.controller.signal.aborted) fail('supervisor_closed');
        entry.instance = runtime.prepare({ binding: entry.lease.binding, admission: false, signal: entry.controller.signal });
        if (entry.instance === null || typeof entry.instance !== 'object' || typeof entry.instance.then === 'function') fail('invalid_runtime_handle');
        if (closing || entry.controller.signal.aborted) fail('supervisor_closed');
        entry.starting = Promise.resolve().then(() => runtime.start(entry.instance));
        await entry.starting;
        if (entry.instance === undefined || closing || entry.controller.signal.aborted || entry.expiresAt <= now()) fail('runtime_start_failed');
        const current = await backend.resolveConnection(token, { signal: entry.controller.signal });
        if (!exact(current, ['connectionId', 'assistantId', 'userId', 'organizationId', 'expiresAt']) ||
            ['connectionId', 'assistantId', 'userId', 'organizationId'].some(key => current[key] !== identity[key]) ||
            !integer(current.expiresAt) || current.expiresAt <= now() || current.expiresAt > now() + 900000 ||
            closing || entry.controller.signal.aborted) fail('identity_changed');
        entry.expiresAt = current.expiresAt;
        entry.state = 'active'; runtime.setAdmission(entry.instance, true); arm(entry);
        return handle;
      } catch { ready(); await halt(entry, 'reconnect_required'); fail('supervisor_start_failed'); }
      finally { ready(); }
    });
    return Object.freeze({ handle, ready: track(work) });
  };
  const start = async input => beginStart(input).ready;
  const beginMaintain = (handle, rawOptions) => {
    const entry = handles.get(handle);
    if (!entry) fail('invalid_handle');
    if (renewalMode !== 'coordinated') fail('maintenance_unavailable');
    let signal;
    try { ({ signal } = snapshotExact(rawOptions, ['signal'])); if (!(signal instanceof AbortSignal)) fail('invalid_maintenance'); }
    catch { fail('invalid_maintenance'); }
    if (closing || entry.state !== 'active' || entry.controller.signal.aborted) fail('maintenance_stopped');
    if (signal.aborted) fail('maintenance_cancelled');
    if (entry.command || entry.renewing || entry.maintenance) fail('maintenance_busy');
    const oldExpiry = entry.expiresAt, deadline = now() + 60000;
    if (oldExpiry <= now()) { void halt(entry, 'expired').catch(() => {}); fail('maintenance_expired'); }
    const maintenance = { controller: new AbortController(), known: new Set(), drainFailed: false };
    entry.maintenance = maintenance; entry.state = 'maintaining';
    let resolveResult, rejectResult, settled = false;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; }); void result.catch(() => {});
    const reject = code => { if (!settled) { settled = true; rejectResult(new Error(code)); } };
    const abort = code => {
      maintenance.reason ??= code; maintenance.controller.abort(); reject(maintenance.reason);
      if (!entry.controller.signal.aborted) void halt(entry, code === 'maintenance_expired' ? 'expired' : 'reconnect_required').catch(() => {});
    };
    const stopped = () => abort(entry.state === 'expired' ? 'maintenance_expired' : 'maintenance_stopped');
    const cancelled = () => abort('maintenance_cancelled');
    entry.controller.signal.addEventListener('abort', stopped, { once: true }); signal.addEventListener('abort', cancelled, { once: true });
    const timeout = timers.setTimeout(() => abort('maintenance_timeout'), 60000);
    const check = () => {
      if (closing || entry.controller.signal.aborted || maintenance.controller.signal.aborted || entry.state !== 'maintaining') fail(maintenance.reason ?? 'maintenance_stopped');
      if (now() >= oldExpiry) { abort('maintenance_expired'); fail('maintenance_expired'); }
      if (now() >= deadline) { abort('maintenance_timeout'); fail('maintenance_timeout'); }
    };
    const observe = (value, known) => {
      // A malformed handle can still contain a real late-rejecting Promise.
      // Observe only own data properties; accessors never become cleanup code.
      if (value && (typeof value === 'object' || typeof value === 'function')) {
        for (const key of ['result', 'drained']) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value instanceof Promise) {
            known.add(descriptor.value); void descriptor.value.catch(() => {});
          }
        }
      }
      const operation = snapshotExact(value, ['result', 'drained']);
      if (!(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) fail('invalid_maintenance_operation');
      return operation;
    };
    const run = async () => {
      let operation;
      try {
        check();
        try { operation = observe(backend.beginConnectionMaintenance(entry.token, Object.freeze({ signal: maintenance.controller.signal })), maintenance.known); }
        catch { maintenance.drainFailed = true; abort('maintenance_outcome_unknown'); fail('maintenance_outcome_unknown'); }
        let ack;
        try { ack = snapshotExact(await operation.result, ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled']); }
        catch { abort('maintenance_failed'); fail('maintenance_failed'); }
        finally {
          try { await operation.drained; }
          catch { maintenance.drainFailed = true; abort('maintenance_outcome_unknown'); fail('maintenance_outcome_unknown'); }
        }
        check();
        if (ack.ok !== true || ack.status !== 'renewed' || ack.connectionId !== entry.connectionId || typeof ack.reconciled !== 'boolean' ||
          !integer(ack.expiresAt) || ack.expiresAt <= oldExpiry || ack.expiresAt > now() + 900000) fail('invalid_maintenance_ack');
        const current = snapshotExact(await backend.resolveConnection(entry.token, { signal: maintenance.controller.signal }), [...ownerKeys, 'expiresAt']);
        check();
        if (ownerKeys.some(key => current[key] !== entry.identity[key]) || current.expiresAt !== ack.expiresAt ||
          !integer(current.expiresAt) || current.expiresAt <= now() || current.expiresAt > now() + 900000) fail('maintenance_authority_changed');
        return ack;
      } catch { abort(maintenance.reason ?? 'maintenance_failed'); throw new Error(maintenance.reason ?? 'maintenance_failed'); }
      finally { await Promise.allSettled([...maintenance.known]); }
    };
    let scope;
    const scopeKnown = new Set();
    try {
      runtime.setAdmission(entry.instance, false);
      scope = observe(dependencyScope.begin(run), scopeKnown);
    } catch {
      maintenance.drainFailed = true; abort('maintenance_outcome_unknown');
    }
    maintenance.work = track((async () => {
      try {
        if (!scope) { await Promise.allSettled([...scopeKnown]); fail('maintenance_outcome_unknown'); }
        let ack;
        try { ack = await scope.result; }
        catch { abort(maintenance.reason ?? 'maintenance_failed'); }
        try { await scope.drained; }
        catch { maintenance.drainFailed = true; abort('maintenance_outcome_unknown'); }
        if (maintenance.drainFailed) fail('maintenance_outcome_unknown');
        if (!ack || maintenance.controller.signal.aborted) return;
        check();
        // This is deliberately outside the finite dependency scope. Opening
        // admission must follow actual SQL/Auth/provider drain, not its ACK.
        entry.expiresAt = ack.expiresAt;
        try { runtime.setAdmission(entry.instance, true); }
        catch { maintenance.drainFailed = true; abort('maintenance_outcome_unknown'); fail('maintenance_outcome_unknown'); }
        check();
        entry.state = 'active'; arm(entry); settled = true; resolveResult(ack);
      } catch {
        abort(maintenance.reason ?? 'maintenance_failed');
        if (maintenance.drainFailed) fail('maintenance_outcome_unknown');
      } finally {
        timers.clearTimeout(timeout); signal.removeEventListener('abort', cancelled); entry.controller.signal.removeEventListener('abort', stopped);
        if (!maintenance.drainFailed && entry.maintenance === maintenance) entry.maintenance = undefined;
      }
    })());
    void maintenance.work.catch(() => {});
    return Object.freeze({ result, drained: maintenance.work });
  };
  const executeCommand = async (handle, request, options = {}, dispatched) => {
    const entry = handles.get(handle);
    if (!entry) fail('invalid_handle');
    // Copy scalar data before any await; mutable caller objects never become
    // authority or change the eventual runtime message while lookup is pending.
    let claim, signal, timeoutMs, dispatch;
    try {
      claim = snapshotExact(request, commandKeys);
      if (dispatched !== undefined) {
        dispatch = snapshotExact(dispatched, ['token', 'claimId']);
        if (dispatch.token !== entry.token || typeof dispatch.claimId !== 'string' || !uuid.test(dispatch.claimId)) fail('invalid_private_command');
      }
      if (![...ownerKeys, 'commandId', 'bindingId'].every(key => typeof claim[key] === 'string' && uuid.test(claim[key])) ||
          !integer(claim.bindingEpoch) || !integer(claim.expiresAt) || !plainText(claim.text, 8192)) fail('invalid_private_command');
      if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key =>
        !['signal', 'timeoutMs'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) fail('invalid_private_command');
      signal = options.signal; timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
      if ((signal !== undefined && !(signal instanceof AbortSignal)) || !integer(timeoutMs) || timeoutMs > 120000) fail('invalid_private_command');
    } catch { fail('invalid_private_command'); }
    if (typeof runtime.beginExecutePrivateCommand !== 'function' && typeof runtime.executePrivateCommand !== 'function') fail('private_command_unavailable');
    if (closing || entry.state !== 'active' || entry.controller.signal.aborted) fail('private_command_stopped');
    if (ownerKeys.some(key => claim[key] !== entry.identity[key])) fail('private_command_owner_mismatch');
    if (signal?.aborted) fail('private_command_cancelled');
    const beganAt = now();
    if (claim.expiresAt <= beganAt || entry.expiresAt <= beganAt) fail('private_command_expired');
    if (entry.commandIds.has(claim.commandId)) fail('private_command_duplicate');
    if (entry.command) fail('private_command_busy');
    if (entry.commandIds.size >= maxRememberedCommands) fail('private_command_capacity');
    const deadline = Math.min(claim.expiresAt, beganAt + timeoutMs);
    const command = { controller: new AbortController() };
    entry.command = command; entry.commandIds.add(claim.commandId);
    let resolveResult, rejectResult, settled = false;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const reject = code => { if (!settled) { settled = true; rejectResult(new Error(code)); } };
    const abort = code => {
      command.abortReason ??= code; command.controller.abort(); reject(command.abortReason);
      // Cancellation is not proof that the adapter stopped executing. Close the
      // runtime gate synchronously and retain its profile until stop AND work
      // drain. Never await halt here: it waits for this command's own promise.
      if (entry.state === 'active' && !entry.controller.signal.aborted) {
        void halt(entry, code === 'private_command_expired' ? 'expired' : 'reconnect_required').catch(() => {});
      }
    };
    const stopped = () => abort('private_command_stopped'), cancelled = () => abort('private_command_cancelled');
    entry.controller.signal.addEventListener('abort', stopped, { once: true });
    signal?.addEventListener('abort', cancelled, { once: true });
    const timeout = timers.setTimeout(() => abort(deadline === claim.expiresAt ? 'private_command_expired' : 'private_command_timeout'), deadline - beganAt);
    const live = () => {
      if (command.controller.signal.aborted) return false;
      if (closing || entry.state !== 'active' || entry.controller.signal.aborted) { stopped(); return false; }
      const currentTime = now();
      if (entry.expiresAt <= currentTime || claim.expiresAt <= currentTime) { abort('private_command_expired'); return false; }
      if (deadline <= currentTime) { abort('private_command_timeout'); return false; }
      return true;
    };
    const denyAuthority = code => {
      abort(code);
      // Do not await halt here: halt itself drains this command's work.
      void halt(entry, 'reconnect_required').catch(() => {});
      return false;
    };
    const authorized = async () => {
      let raw;
      try { raw = await backend.resolveConnection(entry.token, { signal: command.controller.signal }); }
      catch { return command.controller.signal.aborted ? false : denyAuthority('private_command_authority_unavailable'); }
      if (!live()) return false;
      let current;
      try { current = snapshotExact(raw, [...ownerKeys, 'expiresAt']); }
      catch { return denyAuthority('private_command_authority_changed'); }
      if (ownerKeys.some(key => current[key] !== entry.identity[key] || current[key] !== claim[key]) ||
          !integer(current.expiresAt) || current.expiresAt <= now() || current.expiresAt > now() + 900000) return denyAuthority('private_command_authority_changed');
      // A resolver may reveal an earlier live expiry than the last renewal ACK.
      // Shorten the watchdog immediately; reads never extend the local lease.
      if (current.expiresAt < entry.expiresAt) { entry.expiresAt = current.expiresAt; arm(entry); }
      return true;
    };
    const run = async () => {
      let runtimeDrain, contextDrained = false;
      try {
        if (!live() || !await authorized() || !live()) return;
        const input = Object.freeze({ commandId: claim.commandId, bindingId: claim.bindingId, bindingEpoch: claim.bindingEpoch, text: claim.text });
        if (dispatch) {
          command.context = Object.freeze(Object.create(null));
          commandContexts.set(command.context, { entry, command, claim, claimId: dispatch.claimId, live });
        }
        const options = Object.freeze({ signal: command.controller.signal,
          ...(command.context ? { commandContext: command.context } : {}) });
        let output;
        if (typeof runtime.beginExecutePrivateCommand === 'function') {
          let operation;
          try {
            operation = snapshotExact(runtime.beginExecutePrivateCommand(entry.instance, input, options), ['result', 'drained']);
            if (operation.result instanceof Promise) void operation.result.catch(() => {});
            if (operation.drained instanceof Promise) void operation.drained.catch(() => {});
            if (!(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) fail('invalid_operation');
          } catch { abort('private_command_failed'); return; }
          runtimeDrain = operation.drained; void runtimeDrain.catch(() => {});
          output = await operation.result;
          await runtimeDrain; contextDrained = true;
        } else { output = await runtime.executePrivateCommand(entry.instance, input, options); contextDrained = true; }
        if (!live()) return;
        let response;
        try { response = snapshotExact(output, ['text']); }
        catch { reject('private_command_invalid_result'); return; }
        if (!plainText(response.text, 32768)) { reject('private_command_invalid_result'); return; }
        if (!await authorized() || !live()) return;
        settled = true; resolveResult(response);
      } catch { reject(command.abortReason ?? 'private_command_failed'); }
      finally {
        // A driver observer can reject on abort while its transport/endTurn is
        // still pending. Neither command ownership nor the enclosing scope may
        // drain until that separate actual-work promise settles.
        if (runtimeDrain) { try { await runtimeDrain; contextDrained = true; } catch { abort('private_command_failed'); } }
        // Abort disables reads immediately; only a fulfilled actual drain erases
        // the host claim. Unknown drain retains the record, unusable, for safety.
        if (contextDrained && command.context) commandContexts.delete(command.context);
        timers.clearTimeout(timeout);
        signal?.removeEventListener('abort', cancelled);
        entry.controller.signal.removeEventListener('abort', stopped);
        if (entry.command === command) entry.command = undefined;
      }
    };
    // Keep the whole underlying command tracked before returning the separate
    // result/deadline promise. run also waits for the driver's actual drain port.
    try { command.work = track(dependencyScope ? dependencyScope.track(run) : Promise.resolve().then(run)); }
    catch {
      timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', cancelled);
      entry.controller.signal.removeEventListener('abort', stopped);
      if (entry.command === command) entry.command = undefined;
      abort('private_command_failed');
    }
    return result;
  };
  const executePrivateCommand = (handle, request, options) => executeCommand(handle, request, options);
  const executeDispatchedPrivateCommand = (handle, request, dispatch, options) => executeCommand(handle, request, options, dispatch);
  const readPrivateCommandContext = (handle, raw) => {
    const current = commandContexts.get(handle);
    if (!current) fail('invalid_private_command_context');
    const { entry, command, claim, claimId } = current;
    let scope;
    try { scope = snapshotExact(raw, ['token', ...ownerKeys, 'home', 'commandId']); }
    catch { fail('invalid_private_command_context'); }
    if (scope.token !== entry.token || ownerKeys.some(key => scope[key] !== entry.identity[key]) ||
        scope.home !== entry.lease.binding.home || scope.commandId !== claim.commandId) fail('invalid_private_command_context');
    if (entry.command !== command || !current.live()) fail('private_command_context_inactive');
    return Object.freeze({ commandId: claim.commandId, claimId });
  };
  return Object.freeze({ renewalMode, beginStart, start, beginMaintain, executePrivateCommand,
    executeDispatchedPrivateCommand, readPrivateCommandContext,
    status(handle) { const entry = handles.get(handle); if (!entry) fail('invalid_handle'); return Object.freeze({ state: entry.state, expiresAt: entry.expiresAt }); },
    stop(handle) { const entry = handles.get(handle); if (!entry) fail('invalid_handle'); return halt(entry, 'stopped'); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const stopped = [...entries].map(entry => halt(entry, 'closed'));
      closePromise = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled(stopped);
        if (results.some(result => result.status === 'rejected')) fail('supervisor_close_failed');
      })();
      return closePromise;
    },
  });
}
