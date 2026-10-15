const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw new Error(code); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('invalid_orchestrator_request');
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item || !Object.hasOwn(item, 'value')) fail('invalid_orchestrator_request');
    return [key, item.value];
  })));
}
const invoke = (fn, ...args) => { try { return Promise.resolve(fn(...args)); } catch (error) { return Promise.reject(error); } };
const pair = raw => {
  if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
    for (const key of ['result', 'drained']) {
      const item = Object.getOwnPropertyDescriptor(raw, key);
      if (item && Object.hasOwn(item, 'value') && item.value instanceof Promise) void item.value.catch(() => {});
    }
  }
  const value = exact(raw, ['result', 'drained']);
  if (!(value.result instanceof Promise) || !(value.drained instanceof Promise)) fail('invalid_runner_lifecycle');
  return value;
};

/** In-process trusted host composition, without HTTP, token discovery/storage,
 * crash takeover or runtime memory persistence. Only verified backend
 * identity selects a logical home. Public runner timeout is not a drain: slots
 * and ownership remain until its explicit drained promise and supervisor stop.
 * A coordinated supervisor is required. Before the renewal horizon, new pumps
 * stop for that owner; the entire current runner must drain before maintenance.
 * Maintenance runs in expiry order, sharing the pump concurrency budget. It
 * closes runtime admission only after command/finish work ends, then verifies
 * refreshed authority before resuming. Unknown work is never automatically retried.
 * An unproven drain retains ownership and prevents a successful shutdown.
 * backend.resolveConnection is the trusted composed port whose promise includes
 * actual authority dependency drain, not only a SQL/Auth observer deadline.
 */
export function createRuntimeOrchestrator({ backend, gateway, supervisor, runner, profileHomes,
  closeIngress, closePool, clock = Date.now, timers = { setTimeout, clearTimeout },
  pollIntervalMs = 5000, pruneIntervalMs = 60000, renewBeforeMs = 300000, maxConcurrentPumps = 4, maxProfiles = 16 } = {}) {
  for (const [object, methods] of [[backend, ['resolveConnection', 'close']], [gateway, ['register', 'releaseRegistration']],
    [supervisor, ['beginStart', 'beginMaintain', 'status', 'stop', 'close']], [runner, ['beginRun', 'beginPrune', 'close']], [profileHomes, ['ensure']]]) {
    if (methods.some(key => typeof object?.[key] !== 'function')) fail('invalid_orchestrator_config');
  }
  if (Object.getOwnPropertyDescriptor(supervisor, 'renewalMode')?.value !== 'coordinated' ||
    typeof closeIngress !== 'function' || typeof closePool !== 'function' || typeof clock !== 'function' ||
    typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function' ||
    !positive(pollIntervalMs) || pollIntervalMs > 60000 || !positive(renewBeforeMs) ||
    renewBeforeMs < 180000 + pollIntervalMs + 1000 || renewBeforeMs > 600000 || !positive(pruneIntervalMs) || pruneIntervalMs > 3600000 ||
    !positive(maxConcurrentPumps) || maxConcurrentPumps > 15 || !positive(maxProfiles) || maxProfiles > 64) fail('invalid_orchestrator_config');
  const homes = profileHomes.ensure.bind(profileHomes), resolve = backend.resolveConnection.bind(backend);
  const register = gateway.register.bind(gateway), release = gateway.releaseRegistration.bind(gateway);
  const beginStart = supervisor.beginStart.bind(supervisor), supervisorStop = supervisor.stop.bind(supervisor), supervisorStatus = supervisor.status.bind(supervisor);
  const beginMaintain = supervisor.beginMaintain.bind(supervisor);
  const beginRun = runner.beginRun.bind(runner), beginPrune = runner.beginPrune.bind(runner);
  const schedule = timers.setTimeout.bind(timers), cancel = timers.clearTimeout.bind(timers);
  const entries = new Set(), handles = new WeakMap(), profiles = new Map(), connections = new Map(), tokens = new Set(), owned = new Set();
  let started = false, closing = false, closePromise, tickTimer, pruneTimer, pumping = 0, pumpCursor = 0, maintenance, maintenanceStopped = false, maintenanceRetained = false;
  const now = () => { const value = clock(); if (!positive(value)) fail('orchestrator_clock_invalid'); return value; };
  const track = promise => { owned.add(promise); void promise.then(() => owned.delete(promise), () => owned.delete(promise)); return promise; };
  const get = handle => { const entry = handles.get(handle); if (!entry) fail('invalid_orchestrator_handle'); return entry; };
  const live = entry => { if (closing || entry.controller.signal.aborted || entry.stopping) fail('orchestrator_stopped'); };
  const identity = raw => {
    const value = exact(raw, [...OWNER, 'expiresAt']), time = now();
    if (OWNER.some(key => typeof value[key] !== 'string' || !UUID.test(value[key])) || !positive(value.expiresAt) ||
      value.expiresAt <= time || value.expiresAt > time + 900000) fail('orchestrator_authority_unavailable');
    return value;
  };
  const recheck = async entry => {
    const current = identity(await resolve(entry.token, { signal: entry.controller.signal })); live(entry);
    if (OWNER.some(key => current[key] !== entry.owner[key])) fail('orchestrator_authority_changed');
    entry.owner = current;
  };
  const stopRuntime = entry => {
    if (entry.supervisorHandle && !entry.runtimeStop) { entry.runtimeStop = invoke(supervisorStop, entry.supervisorHandle); void entry.runtimeStop.catch(() => {}); }
    return entry.runtimeStop;
  };
  const stopEntry = (entry, state = 'stopped') => {
    if (entry.stopping) return entry.stopping;
    entry.state = state; entry.controller.abort(); entry.pump?.controller.abort(); entry.renewal?.controller.abort(); stopRuntime(entry);
    entry.stopping = track((async () => {
      await entry.setupSettled;
      const results = await Promise.allSettled([stopRuntime(entry), entry.pump?.work, entry.renewal?.work]);
      if (results.some(value => value.status === 'rejected')) fail('orchestrator_profile_retained');
      if (entry.ticket) await release(entry.ticket);
      entry.detach(); entries.delete(entry); tokens.delete(entry.token);
      if (entry.owner && profiles.get(entry.owner.assistantId) === entry) profiles.delete(entry.owner.assistantId);
      if (entry.owner && connections.get(entry.owner.connectionId) === entry) connections.delete(entry.owner.connectionId);
      entry.token = undefined;
    })().catch(() => { entry.state = 'retained'; fail('orchestrator_profile_retained'); }));
    void entry.stopping.catch(() => {}); return entry.stopping;
  };
  const quarantine = entry => { void stopEntry(entry, 'reconnect_required').catch(() => {}); };
  const retain = (current, code) => {
    current.retained = true; current.work = track(Promise.reject(new Error(code))); void current.work.catch(() => {});
  };
  const maintain = entry => {
    if (closing || entry.state !== 'parking' || entry.pump || entry.renewal || pumping >= maxConcurrentPumps) return;
    const current = { controller: new AbortController() }; entry.renewal = current; entry.state = 'maintaining'; pumping++;
    let operation;
    try { operation = pair(beginMaintain(entry.supervisorHandle, { signal: current.controller.signal })); }
    catch { retain(current, 'orchestrator_maintenance_retained'); quarantine(entry); return; }
    let receipt;
    const result = operation.result.then(raw => {
      const value = exact(raw, ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled']);
      if (value.ok !== true || value.status !== 'renewed' || value.connectionId !== entry.owner.connectionId ||
          !positive(value.expiresAt) || value.expiresAt <= entry.owner.expiresAt || value.expiresAt <= now() ||
          value.expiresAt > now() + 900000 || typeof value.reconciled !== 'boolean') fail('invalid_maintenance_result');
      receipt = value;
    }).catch(() => { quarantine(entry); });
    current.work = track(Promise.allSettled([result, operation.drained]).then(results => {
      if (results[1].status === 'rejected') { current.retained = true; quarantine(entry); fail('orchestrator_maintenance_retained'); }
      if (closing || entry.stopping || !receipt) return;
      const state = exact(supervisorStatus(entry.supervisorHandle), ['state', 'expiresAt']);
      if (state.state !== 'active' || state.expiresAt !== receipt.expiresAt || state.expiresAt <= now()) {
        quarantine(entry); return;
      }
      entry.owner = Object.freeze({ ...entry.owner, expiresAt: receipt.expiresAt }); entry.state = 'active';
    }).catch(error => { quarantine(entry); throw error; }).finally(() => {
      if (!current.retained) { if (entry.renewal === current) entry.renewal = undefined; pumping--; }
    }));
    void current.work.catch(() => {});
  };
  const pump = entry => {
    if (closing || entry.state !== 'active' || entry.pump || pumping >= maxConcurrentPumps) return;
    try {
      const state = exact(supervisorStatus(entry.supervisorHandle), ['state', 'expiresAt']);
      if (state.state !== 'active' || !positive(state.expiresAt) || state.expiresAt <= now()) { quarantine(entry); return; }
    } catch { quarantine(entry); return; }
    const current = { controller: new AbortController() }; entry.pump = current; pumping++;
    let operation;
    try { operation = pair(beginRun(entry.token, entry.supervisorHandle, { signal: current.controller.signal })); }
    catch { retain(current, 'orchestrator_pump_retained'); quarantine(entry); return; }
    const result = operation.result.then(raw => {
      if (closing || entry.stopping) return;
      const kind = Object.getOwnPropertyDescriptor(raw ?? {}, 'status')?.value;
      if (kind === 'empty') { if (exact(raw, ['status']).status !== 'empty') fail('invalid_pump_result'); }
      else if (kind === 'ready') {
        const value = exact(raw, ['status', 'commandId']); if (typeof value.commandId !== 'string' || !UUID.test(value.commandId)) fail('invalid_pump_result');
      } else fail('invalid_pump_result');
    }).catch(() => { quarantine(entry); });
    current.work = track(Promise.allSettled([result, operation.drained]).then(results => {
      if (results[1].status === 'rejected') { current.retained = true; quarantine(entry); fail('orchestrator_pump_retained'); }
    }).finally(() => { if (!current.retained) { if (entry.pump === current) entry.pump = undefined; pumping--; } }));
    void current.work.catch(() => {});
  };
  const tick = () => {
    tickTimer = undefined; if (closing || !started) return;
    const candidates = [...entries], urgent = [], startAt = pumpCursor % Math.max(1, candidates.length);
    for (const entry of candidates) {
      if (!['active', 'parking'].includes(entry.state) || entry.stopping) continue;
      try {
        const state = exact(supervisorStatus(entry.supervisorHandle), ['state', 'expiresAt']);
        if (state.state !== 'active' || !positive(state.expiresAt) || state.expiresAt <= now()) { quarantine(entry); continue; }
        if (entry.state === 'parking' || state.expiresAt - now() <= renewBeforeMs) {
          // Mark parked before any asynchronous maintenance or another pump.
          // The current pump keeps its slot and admission until its real drain.
          entry.state = 'parking'; urgent.push({ entry, expiresAt: state.expiresAt });
        }
      } catch { quarantine(entry); }
    }
    urgent.sort((a, b) => a.expiresAt - b.expiresAt);
    for (const { entry } of urgent) maintain(entry);
    for (let offset = 0; offset < candidates.length && pumping < maxConcurrentPumps; offset++) {
      const index = (startAt + offset) % candidates.length;
      pumpCursor = (index + 1) % candidates.length; pump(candidates[index]);
    }
    tickTimer = schedule(tick, pollIntervalMs);
  };
  const prune = () => {
    pruneTimer = undefined; if (closing || !started || maintenanceStopped) return;
    if (!maintenance) {
      const current = { controller: new AbortController() }; maintenance = current;
      let operation;
      try { operation = pair(beginPrune({ limit: 64 }, { signal: current.controller.signal })); }
      catch { maintenanceStopped = true; maintenanceRetained = true; retain(current, 'orchestrator_prune_retained'); return; }
      const result = operation.result.then(raw => {
        const value = exact(raw, ['status', 'count']);
        if (value.status !== 'pruned' || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 64) fail('invalid_prune_result');
      }).catch(() => { maintenanceStopped = true; current.controller.abort(); });
      current.work = track(Promise.allSettled([result, operation.drained]).then(results => {
        if (results[1].status === 'rejected') { maintenanceStopped = true; maintenanceRetained = true; fail('orchestrator_prune_retained'); }
      }).finally(() => { if (!maintenanceRetained && maintenance === current) maintenance = undefined; }));
      void current.work.catch(() => {});
    }
    pruneTimer = schedule(prune, pruneIntervalMs);
  };
  return Object.freeze({
    async attach(raw) {
      const hasOwner = raw && Object.hasOwn(raw, 'expectedOwner');
      const input = exact(raw, hasOwner ? ['token', 'signal', 'expectedOwner'] : ['token', 'signal']);
      const expectedOwner = hasOwner ? exact(input.expectedOwner, OWNER) : undefined;
      if (expectedOwner && OWNER.some(key => typeof expectedOwner[key] !== 'string' || !UUID.test(expectedOwner[key]))) fail('invalid_orchestrator_request');
      if (typeof input.token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(input.token) || !(input.signal instanceof AbortSignal)) fail('invalid_orchestrator_request');
      if (closing || input.signal.aborted) fail('orchestrator_stopped');
      if (entries.size >= maxProfiles || tokens.has(input.token)) fail('orchestrator_busy');
      const handle = Object.freeze({}), entry = { token: input.token, controller: new AbortController(), state: 'starting' };
      handles.set(handle, entry); entries.add(entry); tokens.add(entry.token);
      let setupDone; entry.setupSettled = new Promise(resolveDone => { setupDone = resolveDone; });
      const abort = () => { void stopEntry(entry).catch(() => {}); };
      input.signal.addEventListener('abort', abort, { once: true }); entry.detach = () => input.signal.removeEventListener('abort', abort);
      const setup = track((async () => {
        live(entry); entry.owner = identity(await resolve(entry.token, { signal: entry.controller.signal })); live(entry);
        // A persisted handoff supplies a comparison fence, never authority. Reject
        // changed immutable identity before any home, ticket, lease or runtime.
        if (expectedOwner && OWNER.some(key => expectedOwner[key] !== entry.owner[key])) fail('orchestrator_owner_mismatch');
        if (profiles.has(entry.owner.assistantId) || connections.has(entry.owner.connectionId)) fail('orchestrator_profile_in_use');
        profiles.set(entry.owner.assistantId, entry); connections.set(entry.owner.connectionId, entry);
        const owner = Object.freeze(Object.fromEntries(['assistantId', 'userId', 'organizationId'].map(key => [key, entry.owner[key]])));
        const home = await homes(owner, { signal: entry.controller.signal }); live(entry);
        if (typeof home !== 'string') fail('invalid_profile_home');
        await recheck(entry);
        entry.ticket = await register(entry.token, { home, signal: entry.controller.signal }); live(entry);
        const beginning = exact(beginStart({ token: entry.token, home }), ['handle', 'ready']);
        if (!beginning.handle || typeof beginning.handle !== 'object' || !(beginning.ready instanceof Promise)) fail('invalid_start_lifecycle');
        entry.supervisorHandle = beginning.handle;
        if (entry.controller.signal.aborted || closing) stopRuntime(entry);
        const ready = await beginning.ready; live(entry);
        if (ready !== entry.supervisorHandle) fail('invalid_start_lifecycle');
        const state = exact(supervisorStatus(entry.supervisorHandle), ['state', 'expiresAt']);
        if (state.state !== 'active' || !positive(state.expiresAt) || state.expiresAt <= now()) fail('invalid_start_lifecycle');
        await recheck(entry);
        entry.state = 'active'; return handle;
      })().finally(setupDone));
      try { return await setup; }
      catch { await stopEntry(entry, 'reconnect_required'); fail('orchestrator_attach_failed'); }
    },
    start() {
      if (closing) fail('orchestrator_closed'); if (started) return;
      started = true; tickTimer = schedule(tick, pollIntervalMs); pruneTimer = schedule(prune, pruneIntervalMs);
    },
    status(handle) {
      const entry = get(handle);
      let state = entry.state, expiresAt = entry.owner?.expiresAt ?? null;
      if (['active', 'parking', 'maintaining'].includes(state)) {
        try {
          const current = exact(supervisorStatus(entry.supervisorHandle), ['state', 'expiresAt']);
          if (!(state === 'maintaining' ? ['maintaining', 'active'] : ['active']).includes(current.state) || !positive(current.expiresAt) || current.expiresAt <= now()) state = 'reconnect_required';
          else expiresAt = current.expiresAt;
        } catch { state = 'reconnect_required'; }
      }
      return Object.freeze({ state, ...Object.fromEntries(OWNER.map(key => [key, entry.owner?.[key] ?? null])), expiresAt });
    },
    stop(handle) { return stopEntry(get(handle)); },
    close() {
      if (closePromise) return closePromise;
      closing = true; if (tickTimer !== undefined) cancel(tickTimer); if (pruneTimer !== undefined) cancel(pruneTimer);
      for (const entry of entries) { entry.controller.abort(); entry.pump?.controller.abort(); entry.renewal?.controller.abort(); }
      maintenance?.controller.abort();
      // Kick both lifecycles before awaiting either: runtime shutdown may be
      // required to settle runner work that ignored its public cancellation.
      const ingress = invoke(closeIngress), runnerClosed = invoke(runner.close.bind(runner)), supervisorClosed = invoke(supervisor.close.bind(supervisor));
      const stopped = [...entries].map(entry => stopEntry(entry, 'stopped'));
      closePromise = (async () => {
        const results = await Promise.allSettled([ingress, runnerClosed, supervisorClosed, ...stopped, maintenance?.work]);
        await Promise.allSettled([...owned]);
        if (results.some(value => value.status === 'rejected') || entries.size || maintenanceRetained) fail('orchestrator_close_retained');
        try { await backend.close(); await closePool(); } catch { fail('orchestrator_close_retained'); }
      })();
      return closePromise;
    },
  });
}
