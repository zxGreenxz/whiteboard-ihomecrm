// Called inside tickTuDongHoa; this module deliberately owns no timer/cron.
// The existing queue owns leases, provider admission and UNKNOWN_EFFECT. The
// fixed DB RPCs own due-time, current ACL, quota, immutable grant provenance,
// durable blocked-run evidence, owner notices and bounded maintenance.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_STATUSES = ['queued', 'skipped', 'already_run', 'blocked'];
const COUNTERS = ['prunedCommands', 'expiredJobs', 'observed', 'closed', 'expiry', 'notified'];
// PostgREST reports a function that is not deployed yet as PGRST202. The call
// was never executed, so the same single attempt may use the older contract.
const missing = error => error?.code === 'PGRST202';

async function runOnce(db, row, instanceId) {
  const args = { p_schedule_id: row.scheduleId, p_expected_revision: row.revision, p_instance_id: instanceId };
  const result = await db.rpc('hermes_room_schedule_run_v2', args);
  return missing(result.error) ? db.rpc('hermes_room_schedule_run_v1', args) : result;
}

async function runDue({ db, instanceId, organizationIds, log }) {
  const { data, error } = await db.rpc('hermes_room_schedule_due_v1', {
    p_instance_id: instanceId, p_organization_ids: organizationIds,
  });
  if (error) throw new Error(`hermes_schedule_due_failed:${error.code || 'unknown'}`);
  if (!Array.isArray(data) || data.length > 100 || data.some(row => !row ||
      typeof row.scheduleId !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1)) {
    throw new Error('hermes_schedule_due_invalid');
  }
  const results = [];
  for (const row of data) {
    // One attempt per tick. Lost enqueue replies are reconciled by the same
    // schedule/day in SQL; never mint a new dispatch ID or resend here.
    const result = await runOnce(db, row, instanceId);
    if (result.error) {
      log('hermes schedule run rejected', row.scheduleId, result.error.code || 'unknown');
      results.push({ scheduleId: row.scheduleId, status: 'unverified' });
    } else if (!result.data || !RUN_STATUSES.includes(result.data.status)) {
      log('hermes schedule result unverified', row.scheduleId);
      results.push({ scheduleId: row.scheduleId, status: 'unverified' });
    } else {
      // A blocked run is already durable evidence in SQL; the owner notice is
      // sent by the sweep below, never by this process.
      if (result.data.status === 'blocked') log('hermes schedule blocked', row.scheduleId, String(result.data.reason || 'unknown'));
      results.push({ scheduleId: row.scheduleId, ...result.data });
    }
  }
  return results;
}

/** Maintenance, delivery outcomes, grant expiry and owner notices in SQL,
 * then at most five proactive authority probes, each its own short call. */
export async function sweepHermesSchedules({ db, instanceId, organizationIds = [], log = () => {} } = {}) {
  if (typeof db?.rpc !== 'function' || typeof instanceId !== 'string' || !Array.isArray(organizationIds)) {
    throw new TypeError('hermes_schedule_dependencies_required');
  }
  const { data, error } = await db.rpc('hermes_room_schedule_sweep_v1', {
    p_instance_id: instanceId, p_organization_ids: organizationIds,
  });
  if (missing(error)) return { status: 'unavailable' };
  if (error) throw new Error(`hermes_schedule_sweep_failed:${error.code || 'unknown'}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || COUNTERS.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0) ||
      !Array.isArray(data.probes) || data.probes.length > 5 || data.probes.some(id => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(data.probes).size !== data.probes.length) {
    throw new Error('hermes_schedule_sweep_invalid');
  }
  const probes = [];
  for (const scheduleId of data.probes) {
    const probe = await db.rpc('hermes_room_schedule_probe_v1', { p_schedule_id: scheduleId, p_instance_id: instanceId });
    if (probe.error || !['healthy', 'blocked', 'inactive'].includes(probe.data?.status)) {
      log('hermes schedule probe unverified', scheduleId, probe.error?.code || 'invalid');
      probes.push({ scheduleId, status: 'unverified' });
    } else probes.push({ scheduleId, status: probe.data.status, ...(probe.data.reason ? { reason: String(probe.data.reason) } : {}) });
  }
  return { status: 'swept', ...Object.fromEntries(COUNTERS.map(key => [key, data[key]])), probes };
}

export async function tickHermesSchedules({ db, instanceId, organizationIds = [], log = () => {} } = {}) {
  if (typeof db?.rpc !== 'function' || typeof instanceId !== 'string' || !Array.isArray(organizationIds)) {
    throw new TypeError('hermes_schedule_dependencies_required');
  }
  let results, failure;
  try { results = await runDue({ db, instanceId, organizationIds, log }); }
  catch (error) { failure = error; }
  // Maintenance and owner notices must not depend on a healthy due read.
  try { await sweepHermesSchedules({ db, instanceId, organizationIds, log }); }
  catch (error) { log('hermes schedule sweep unverified', error?.message || error); }
  if (failure) throw failure;
  return results;
}
