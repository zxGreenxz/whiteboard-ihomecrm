// Called inside tickTuDongHoa; this module deliberately owns no timer/cron.
// The existing queue owns leases, provider admission and UNKNOWN_EFFECT. The
// fixed DB RPC owns due-time, current ACL, quota and immutable grant provenance.
export async function tickHermesSchedules({ db, instanceId, organizationIds = [], log = () => {} } = {}) {
  if (typeof db?.rpc !== 'function' || typeof instanceId !== 'string' || !Array.isArray(organizationIds)) {
    throw new TypeError('hermes_schedule_dependencies_required');
  }
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
    const result = await db.rpc('hermes_room_schedule_run_v1', {
      p_schedule_id: row.scheduleId, p_expected_revision: row.revision, p_instance_id: instanceId,
    });
    if (result.error) {
      log('hermes schedule run rejected', row.scheduleId, result.error.code || 'unknown');
      results.push({ scheduleId: row.scheduleId, status: 'unverified' });
    } else if (!result.data || !['queued', 'skipped', 'already_run'].includes(result.data.status)) {
      log('hermes schedule result unverified', row.scheduleId);
      results.push({ scheduleId: row.scheduleId, status: 'unverified' });
    } else results.push({ scheduleId: row.scheduleId, ...result.data });
  }
  return results;
}
