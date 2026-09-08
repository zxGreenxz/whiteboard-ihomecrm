import { DEMO, UUID, requireThat, responseCode } from './copilot-room-pass-live.mjs';
export const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
export function sqlUuid(value) { requireThat(UUID.test(value), 'uuid_invalid'); return `${sqlText(value)}::uuid`; }
export const sqlJson = value => `${sqlText(JSON.stringify(value))}::jsonb`;

export function authenticatedTransaction({ actorId, applicationName, body, timeoutSeconds = 45 }) {
  requireThat(UUID.test(actorId) && /^rp17-[a-z0-9-]{1,50}$/.test(applicationName)
    && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 60, 'session_invalid');
  return `BEGIN;
SET LOCAL statement_timeout = '${timeoutSeconds}s';
SET LOCAL lock_timeout = '${timeoutSeconds - 1}s';
SET LOCAL application_name = ${sqlText(applicationName)};
SELECT set_config('request.jwt.claims', ${sqlJson({ sub: actorId, role: 'authenticated', organization_id: DEMO })}::text, true);
SET LOCAL ROLE authenticated;
DO $identity$ BEGIN
  IF auth.uid() IS DISTINCT FROM ${sqlUuid(actorId)} OR
    public.get_authorization_context_v1(${sqlUuid(DEMO)})->>'organizationId' IS DISTINCT FROM ${sqlText(DEMO)}
    THEN RAISE EXCEPTION 'rp17_identity_invalid'; END IF;
END $identity$;
${body}
COMMIT;`;
}

export function holderSql({ run, tag, seconds = 20, change = 'none' }) {
  requireThat(Number.isInteger(seconds) && seconds >= 5 && seconds <= 30, 'hold_duration_invalid');
  requireThat(['none', 'room_parent_changed', 'listing_revision'].includes(change), 'holder_change_invalid');
  const b = sqlUuid(run.fixtures.building.id), r = sqlUuid(run.fixtures.room.id), l = sqlUuid(run.fixtures.listing.id);
  // These are the UI's authenticated parent update / canonical setter operations.
  // Never alter an existing unrelated record, and never use a privileged business writer.
  const mutation = change === 'room_parent_changed'
    ? `DO $other$ BEGIN
        PERFORM 1 FROM public.buildings WHERE id=${sqlUuid(run.fixtures.scopeBuilding.id)} AND organization_id=${sqlUuid(DEMO)}
          AND user_id=${sqlUuid(run.actorId)} AND name=${sqlText(run.fixtures.scopeBuilding.name)} AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'rp17_other_parent_missing'; END IF;
      END $other$;
      UPDATE public.rooms SET building_id=${sqlUuid(run.fixtures.scopeBuilding.id)} WHERE id=${r} AND building_id=${b} AND organization_id=${sqlUuid(DEMO)} AND name=${sqlText(run.marker)};`
    : change === 'listing_revision' ? `SELECT public.set_room_pass_listing_active(${l},false);` : '';
  return authenticatedTransaction({ actorId: run.actorId, applicationName: tag, body: `
DO $lock$ BEGIN
  PERFORM 1 FROM public.buildings WHERE id=${b} AND organization_id=${sqlUuid(DEMO)}
    AND user_id=${sqlUuid(run.actorId)} AND name=${sqlText(run.marker)} AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rp17_owned_building_missing'; END IF;
  PERFORM 1 FROM public.rooms WHERE id=${r} AND building_id=${b} AND organization_id=${sqlUuid(DEMO)}
    AND name=${sqlText(run.marker)} AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rp17_owned_room_missing'; END IF;
END $lock$;
${mutation}
-- The observer seeing PgSleep for this unique tag proves both locks above returned.
SELECT pg_sleep(${seconds});
SELECT pg_backend_pid() AS pid, txid_current()::text AS xid, transaction_timestamp() AS transaction_started;` });
}

export function executeSql({ run, tag, proposal }) {
  requireThat(proposal.canonical.organization_id === DEMO && proposal.canonical.listing_id === run.fixtures.listing.id
    && /^[0-9a-f]{64}$/.test(proposal.confirmation_nonce), 'session_proposal_invalid');
  return authenticatedTransaction({ actorId: run.actorId, applicationName: tag, body: `
SELECT public.copilot_execute_room_pass_active_v1(${sqlText(proposal.confirmation_nonce)},${sqlJson(proposal.canonical)}) AS result,
  pg_backend_pid() AS pid, txid_current()::text AS xid, transaction_timestamp() AS transaction_started;` });
}

export function activitySql(tags) {
  requireThat(tags.length > 0 && tags.length <= 3 && tags.every(tag => /^rp17-[a-z0-9-]{1,50}$/.test(tag)), 'session_tag_invalid');
  return `SELECT application_name AS tag,pid,backend_xid::text AS xid,xact_start AS transaction_started,
    state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blocking_pids
    FROM pg_stat_activity WHERE application_name IN (${tags.map(sqlText).join(',')});`;
}

export async function observeBarrier({ transport, holder, executors = [], deadlineMs = 10_000,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = now();
  while (now() - start < deadlineMs) {
    const rows = await transport.query(activitySql([holder, ...executors]));
    requireThat([holder, ...executors].every(tag => rows.filter(row => row.tag === tag).length <= 1), 'session_tag_collision');
    const h = rows.find(row => row.tag === holder);
    if (h && Number.isInteger(h.pid) && /^\d+$/.test(h.xid) && h.wait_event === 'PgSleep' && h.state === 'active') {
      if (!executors.length) return { holder: { pid: h.pid, xid: h.xid, transactionStarted: h.transaction_started } };
      const es = executors.map(tag => rows.find(row => row.tag === tag));
      const distinct = new Set([h.pid, ...es.map(row => row?.pid)]).size === es.length + 1
        && new Set([h.xid, ...es.map(row => row?.xid)]).size === es.length + 1;
      // The first executor waits on the building holder. Same-nonce contender
      // waits on the first executor's confirmation row, establishing lock order.
      if (distinct && es.every((row, index) => row && Number.isInteger(row.pid) && /^\d+$/.test(row.xid)
        && row.wait_event_type === 'Lock' && row.state === 'active'
        && row.blocking_pids.includes(index === 0 ? h.pid : es[0].pid))) {
        return { holder: { pid: h.pid, xid: h.xid, transactionStarted: h.transaction_started },
          executors: es.map(row => ({ pid: row.pid, xid: row.xid, transactionStarted: row.transaction_started, blockers: row.blocking_pids })) };
      }
    }
    await pause(100);
  }
  throw new Error('lock_barrier_not_observed');
}

async function safeQuery(transport, sql) {
  try { return { code: 'ok', rows: await transport.query(sql) }; }
  catch (error) {
    // Management adapter must normalize server SQL errors to this same envelope.
    // Raw Error.message is intentionally never copied into durable output.
    const code = responseCode(error?.response);
    return { code: code === 'request_rejected' ? 'session_unknown' : code };
  }
}

export async function runLockCase({ runner, transport, proposal, name, change = 'none', sameNonce = false,
  afterWait = async () => {}, seconds = 20 }) {
  requireThat(/^[a-z_]{1,30}$/.test(name), 'scenario_name_invalid');
  await runner.ownedListing();
  const suffix = runner.run.runId.replaceAll('-', '').slice(0, 12);
  const tagName = name.replaceAll('_', '-');
  const holder = `rp17-${suffix}-${tagName}-h`, first = `rp17-${suffix}-${tagName}-e1`, second = `rp17-${suffix}-${tagName}-e2`;
  const record = { name, state: 'intent', tags: [holder, first, ...(sameNonce ? [second] : [])] };
  requireThat((await transport.query(activitySql(record.tags))).length === 0, 'session_tag_collision');
  runner.run.scenarios.push(record); await runner.save();
  const handles = [safeQuery(transport, holderSql({ run: runner.run, tag: holder, seconds, change }))];
  let evidence;
  try {
    await observeBarrier({ transport, holder });
    handles.push(safeQuery(transport, executeSql({ run: runner.run, tag: first, proposal })));
    // Before sending a contender, prove the first executor acquired the nonce
    // and blocked on the parent. This distinguishes nonce lock order from scheduling.
    evidence = await observeBarrier({ transport, holder, executors: [first] });
    if (sameNonce) {
      handles.push(safeQuery(transport, executeSql({ run: runner.run, tag: second, proposal })));
      evidence = await observeBarrier({ transport, holder, executors: [first, second] });
    }
    await afterWait(evidence);
  } finally {
    // Always await the original handles. Observer timeout never authorizes a rerun.
    // SQL's bounded statement_timeout controls server work; transport must retain
    // and independently reconcile a request whose HTTP completion is unknown.
    const outcomes = await Promise.all(handles);
    record.state = outcomes.some(value => value.code === 'session_unknown') ? 'unknown' : 'settled';
    record.outcomes = outcomes.map(value => value.code);
    if (evidence) record.barrier = evidence;
    await runner.save();
  }
  requireThat(record.state === 'settled' && evidence, 'session_settlement_unverified');
  return record;
}
