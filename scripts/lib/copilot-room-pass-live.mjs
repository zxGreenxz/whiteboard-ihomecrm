// Import-safe Task17 runner. Importing never loads credentials or performs I/O.
import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';

export const DEMO = 'dddd0000-0000-4000-8000-000000000001';
export const ACTION = 'room_pass.set_active';
export const PERMISSION = 'sale_phong.manage_pass_listings';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class RoomPassError extends Error { constructor(code) { super(code); this.code = code; } }
export function requireThat(condition, code) { if (!condition) throw new RoomPassError(code); }

async function durable(path, value, exclusive = false) {
  const target = exclusive ? path : `${path}.next`;
  const file = await open(target, exclusive ? 'wx' : 'w', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  if (!exclusive) await rename(target, path);
}

export async function prepareRoomPassRun({ organizationId, actorId, journalPath }) {
  requireThat(organizationId === DEMO && UUID.test(actorId), 'scope_invalid');
  const runId = randomUUID(), buildingId = randomUUID(), roomId = randomUUID();
  const marker = `rp17-${runId}`;
  const run = {
    schemaVersion: 1, runId, organizationId, actorId, marker, status: 'prepared',
    createdAt: new Date().toISOString(), controls: null, operations: [], scenarios: [],
    fixtures: {
      building: { id: buildingId, name: marker, organization_id: DEMO, user_id: actorId },
      scopeBuilding: { id: randomUUID(), name: `${marker}-other`, organization_id: DEMO, user_id: actorId },
      room: { id: roomId, building_id: buildingId, organization_id: DEMO, name: marker },
      listing: { id: null, room_id: roomId, building_id: buildingId, organization_id: DEMO, user_id: actorId, initialActive: false },
      plans: [],
    },
  };
  await durable(journalPath, run, true);
  return run;
}

export async function loadRoomPassRun(journalPath, actorId) {
  const run = JSON.parse(await readFile(journalPath, 'utf8'));
  requireThat(run.schemaVersion === 1 && run.organizationId === DEMO && run.actorId === actorId
    && UUID.test(actorId) && UUID.test(run.runId) && run.marker === `rp17-${run.runId}`
    && UUID.test(run.fixtures.building.id) && UUID.test(run.fixtures.room.id)
    && run.fixtures.room.building_id === run.fixtures.building.id, 'journal_invalid');
  return run;
}

// Only static error codes leave this module. Transport bodies can contain contacts,
// SQL with nonces, JWTs and model prose; never attach them as causes or evidence.
export const DENIALS = Object.freeze(['confirmation_already_used', 'payload_changed', 'confirmation_expired',
  'not_permitted', 'entity_not_found', 'copilot_action_disabled', 'tenant_emergency_denied',
  'plan_version_stale', 'plan_not_approved', 'plan_busy', 'copilot_rollout_stale_revision']);
export function responseCode(response) {
  if (response?.status >= 200 && response.status < 300) return 'ok';
  const message = response?.body?.message;
  if (typeof message === 'string') for (const code of DENIALS) if (message === code) return code;
  if (response?.body?.code === '23505' && typeof message === 'string'
    && message.includes('"room_pass_listings_room_active_uniq"')) return 'unique_conflict';
  return 'request_rejected';
}

export class RoomPassRun {
  constructor({ run, journalPath, transport }) {
    requireThat(run.organizationId === DEMO && UUID.test(run.actorId), 'scope_invalid');
    this.run = run; this.path = journalPath; this.transport = transport;
    this.context = Object.freeze({ organizationId: DEMO, actorId: run.actorId, runId: run.runId });
  }
  async save() { await durable(this.path, this.run); }
  async acquireLease() {
    this.lease = await open(`${this.path}.lock`, 'wx', 0o600);
    await this.lease.writeFile(JSON.stringify({ runId: this.run.runId, actorId: this.run.actorId, pid: process.pid }));
    await this.lease.sync();
  }
  async releaseLease() {
    if (!this.lease) return;
    await this.lease.close(); this.lease = null;
    if (!this.run.controls?.pending && !this.run.operations.some(op => ['unknown', 'intent'].includes(op.state))
      && !this.run.scenarios.some(s => ['unknown', 'intent'].includes(s.state))
      && (!this.run.browser || this.run.browser.state === 'settled')) await unlink(`${this.path}.lock`);
  }
  async reconcileUnknown({ operationId, terminal, evidenceDigest }) {
    // The operator must independently prove the timed-out request is terminal.
    // An empty SELECT while its original backend still runs is not such proof.
    requireThat(terminal === true && /^[0-9a-f]{64}$/.test(evidenceDigest), 'terminal_evidence_required');
    const op = this.run.operations.find(value => value.id === operationId);
    requireThat(op && ['intent', 'unknown'].includes(op.state), 'unknown_operation_missing');
    requireThat(await this.transport.verifyTerminal(this.context, { operationId, evidenceDigest }) === true, 'terminal_evidence_unverified');
    if (op.name === 'create_listing') {
      const row = await this.ownedListing({ absent: true });
      if (row) { this.run.fixtures.listing.id = row.id; requireThat(row.active === false, 'listing_initial_state_invalid'); }
      op.state = row ? 'reconciled_committed' : 'reconciled_absent';
    } else if (['create_building', 'create_scope_building', 'create_room'].includes(op.name)) {
      const building = op.name !== 'create_room', f = this.run.fixtures[op.name === 'create_scope_building' ? 'scopeBuilding' : building ? 'building' : 'room'];
      const rows = await this.read(building ? 'buildings' : 'rooms', { id: f.id }, building
        ? 'id,name,user_id,organization_id,deleted_at' : 'id,name,building_id,organization_id,deleted_at');
      requireThat(rows.length <= 1 && rows.every(row => row.name === f.name && row.organization_id === DEMO
        && (building ? row.user_id === this.run.actorId : row.building_id === this.run.fixtures.building.id)), 'recovery_ownership_invalid');
      op.state = rows.length ? 'reconciled_committed' : 'reconciled_absent';
    } else if (op.name === 'flag_transition') {
      await this.reconcilePendingControl({ terminal, evidenceDigest });
    } else {
      // A terminal execute/cleanup is reconciled by the same exact owned readback,
      // then fresh compensation (never resubmit its nonce). Control CAS is separate.
      requireThat(['preview', 'preview_denied', 'execute', 'delete_listing', 'delete_room', 'delete_building', 'delete_scope_building', 'domain_set'].includes(op.name), 'recovery_adapter_required');
      op.state = 'reconciled_terminal';
    }
    op.terminalEvidenceDigest = evidenceDigest; this.run.status = 'recovery_required'; await this.save();
  }
  pendingControlKey() {
    return this.run.controls?.pending?.operationId ?? `control:${this.run.runId}`;
  }
  async reconcilePendingControl({ terminal, evidenceDigest }) {
    const pending = this.run.controls?.pending;
    requireThat(pending && terminal === true && /^[0-9a-f]{64}$/.test(evidenceDigest), 'terminal_evidence_required');
    const operationId = this.pendingControlKey();
    requireThat(await this.transport.verifyTerminal(this.context, { operationId, evidenceDigest }) === true, 'terminal_evidence_unverified');
    const op = this.run.operations.find(value => value.id === pending.operationId);
    requireThat(!pending.operationId || (op?.name === 'flag_transition' && op.target === ACTION), 'control_operation_invalid');
    const { flag } = await this.readFlag();
    const absent = digest(flag) === digest(this.run.controls.current);
    if (absent) requireThat(op?.state !== 'acknowledged', 'control_recovery_ownership_invalid');
    else {
      requireThat(op && op.state !== 'rejected' && flag.state === pending.p_state && flag.canary_org === pending.p_canary_org
        && (flag.expires_at === null ? null : Date.parse(flag.expires_at)) === (pending.p_expires_at === null ? null : Date.parse(pending.p_expires_at))
        && flag.updated_by === this.run.actorId && flag.reason === pending.p_reason
        && flag.evidence_link === pending.p_evidence_link && flag.rollback_reference === pending.p_rollback_reference
        && flag.revision === pending.p_expected_revision + 1, 'control_recovery_ownership_invalid');
      this.run.controls.current = structuredClone(flag);
    }
    if (op) { op.state = absent ? 'reconciled_absent' : 'reconciled_committed'; op.terminalEvidenceDigest = evidenceDigest; }
    delete this.run.controls.pending; this.run.status = 'recovery_required'; await this.save();
  }
  async identity() {
    const identity = await this.transport.identity(this.context);
    requireThat(identity.actorId === this.run.actorId && identity.organizationId === DEMO
      && identity.authenticated === true, 'identity_mismatch');
  }
  async read(table, filters, select) {
    await this.identity();
    const response = await this.transport.request(this.context, { method: 'GET', table,
      filters: { ...filters, organization_id: DEMO }, select });
    requireThat(responseCode(response) === 'ok' && Array.isArray(response.body), 'read_failed');
    return response.body;
  }
  async rpc(name, args) {
    await this.identity();
    try { return await this.transport.request(this.context, { method: 'POST', rpc: name, args }); }
    catch { throw new Error('transport_unknown'); }
  }
  async readFlag() {
    await this.identity();
    const { flag, globalRevision } = await this.transport.readFlag(this.context);
    requireThat(flag?.scope === 'action' && flag.contract_id === ACTION
      && Number.isSafeInteger(flag.revision) && Number.isSafeInteger(globalRevision)
      && globalRevision >= flag.revision, 'flag_revision_invalid');
    return { flag, globalRevision };
  }
  async captureControl() {
    requireThat(this.run.controls === null, 'control_already_captured');
    const { flag, globalRevision } = await this.readFlag();
    requireThat(flag.state === 'disabled' && flag.canary_org === null && flag.expires_at === null, 'initial_flag_not_disabled');
    this.run.controls = { prior: structuredClone(flag), current: structuredClone(flag), globalRevision, restored: false };
    await this.save();
  }
  async transitionFlag(state, expiresAt = null, restoreMetadata = false) {
    requireThat(!this.run.controls?.pending, 'control_reconciliation_required');
    requireThat(this.run.controls && ['disabled', 'shadow', 'enabled'].includes(state), 'control_invalid');
    const observed = await this.readFlag(), expected = this.run.controls.current;
    requireThat(digest(observed.flag) === digest(expected), 'control_concurrent_change');
    requireThat(state !== expected.state && (state === 'disabled' || (Number.isFinite(Date.parse(expiresAt))
      && Date.parse(expiresAt) > Date.now() && Date.parse(expiresAt) <= Date.now() + 900_000)), 'control_expiry_invalid');
    const args = { p_scope: 'action', p_contract_id: ACTION, p_state: state, p_expected_revision: observed.globalRevision,
      p_canary_org: state === 'disabled' ? null : DEMO, p_expires_at: state === 'disabled' ? null : expiresAt,
      p_reason: restoreMetadata ? this.run.controls.prior.reason : this.run.marker,
      p_evidence_link: restoreMetadata ? this.run.controls.prior.evidence_link : 'scripts/copilot-room-pass-live-acceptance.mjs',
      p_rollback_reference: restoreMetadata ? this.run.controls.prior.rollback_reference : `room-pass-journal:${this.run.runId}` };
    // Persist exact intended CAS (safe control metadata only), including old row.
    this.run.controls.pending = { ...args }; await this.save();
    const response = await this.mutate('flag_transition', ACTION, { method: 'POST', rpc: 'set_copilot_feature_flag_v2', args });
    requireThat(responseCode(response) === 'ok', responseCode(response) === 'copilot_rollout_stale_revision' ? 'control_cas_stale' : 'control_transition_failed');
    const after = await this.readFlag();
    requireThat(after.flag.state === state && after.flag.canary_org === args.p_canary_org
      && (after.flag.expires_at === null ? null : Date.parse(after.flag.expires_at)) === (expiresAt === null ? null : Date.parse(expiresAt))
      && after.flag.updated_by === this.run.actorId && after.flag.reason === args.p_reason
      && after.flag.evidence_link === args.p_evidence_link && after.flag.rollback_reference === args.p_rollback_reference
      && after.flag.revision === response.body.revision && after.flag.revision > expected.revision, 'control_readback_failed');
    this.run.controls.current = structuredClone(after.flag); delete this.run.controls.pending; await this.save();
  }
  async enable({ renew = false } = {}) {
    if (!this.run.controls) await this.captureControl();
    const expires = new Date(Date.now() + 900_000).toISOString();
    if (this.run.controls.current.state === 'enabled' && (renew || Date.parse(this.run.controls.current.expires_at) < Date.now() + 60_000))
      await this.transitionFlag('shadow', expires);
    if (this.run.controls.current.state === 'disabled') await this.transitionFlag('shadow', expires);
    if (this.run.controls.current.state === 'shadow') await this.transitionFlag('enabled', expires);
  }
  async restoreControl() {
    if (!this.run.controls) return;
    if (this.run.controls.pending) throw new Error('control_reconciliation_required');
    if (this.run.controls.current.state !== 'disabled') await this.transitionFlag('disabled', null, true);
    const { flag } = await this.readFlag();
    requireThat(flag.state === 'disabled' && flag.canary_org === null && flag.expires_at === null, 'control_restore_failed');
    // CAS APIs append audit/revision; they cannot restore historical timestamps.
    this.run.controls.restored = true; this.run.controls.restoration = 'disabled_semantics_audit_retained'; await this.save();
  }
  async mutate(name, target, request) {
    const disabling = name === 'flag_transition' && request.rpc === 'set_copilot_feature_flag_v2' && request.args.p_state === 'disabled';
    return this.externalMutation(name, target, () => this.transport.request(this.context, request), disabling);
  }
  async externalMutation(name, target, mutation, disabling = false) {
    requireThat(disabling || !this.run.operations.some(op => op.state === 'unknown' || op.state === 'intent'), 'unsettled_operation');
    await this.identity();
    const op = { id: randomUUID(), name, target, state: 'intent', startedAt: new Date().toISOString() };
    if (name === 'flag_transition' && this.run.controls?.pending) this.run.controls.pending.operationId = op.id;
    this.run.operations.push(op); await this.save();
    let response;
    try { response = await mutation(); }
    catch {
      op.state = 'unknown'; this.run.status = 'recovery_required'; await this.save();
      throw new Error('transport_unknown');
    }
    op.state = responseCode(response) === 'ok' ? 'acknowledged' : 'rejected';
    op.code = responseCode(response); await this.save();
    return response;
  }
  async ownedParents({ allowDeleted = false } = {}) {
    const b = this.run.fixtures.building, r = this.run.fixtures.room;
    const buildings = await this.read('buildings', { id: b.id }, 'id,organization_id,user_id,name,deleted_at');
    requireThat(buildings.length === 1 && buildings[0].name === b.name && buildings[0].user_id === this.run.actorId
      && (allowDeleted || buildings[0].deleted_at === null), 'building_ownership_invalid');
    const rooms = await this.read('rooms', { id: r.id }, 'id,organization_id,building_id,name,deleted_at');
    requireThat(rooms.length === 1 && rooms[0].building_id === b.id && rooms[0].name === r.name
      && (allowDeleted || rooms[0].deleted_at === null), 'room_ownership_invalid');
    return { building: buildings[0], room: rooms[0] };
  }
  async ownedListing({ absent = false } = {}) {
    await this.ownedParents();
    const fixture = this.run.fixtures.listing;
    const rows = await this.read('room_pass_listings', { room_id: fixture.room_id },
      'id,organization_id,user_id,created_by,building_id,room_id,sale_policy,active');
    const competitor = this.run.fixtures.competitor;
    requireThat(rows.length <= (competitor ? 2 : 1), 'listing_ownership_ambiguous');
    for (const candidate of rows) requireThat(candidate.sale_policy === this.run.marker
      || (competitor && candidate.sale_policy === competitor.marker && (!competitor.id || candidate.id === competitor.id)), 'listing_ownership_ambiguous');
    const primary = rows.filter(candidate => candidate.sale_policy === this.run.marker);
    if (absent && primary.length === 0) return null;
    requireThat(primary.length === 1, 'listing_ownership_ambiguous');
    const row = primary[0];
    requireThat(row.organization_id === DEMO && row.user_id === this.run.actorId
      && row.created_by === this.run.actorId && row.building_id === fixture.building_id
      && row.room_id === fixture.room_id && row.sale_policy === this.run.marker
      && (!fixture.id || row.id === fixture.id) && UUID.test(row.id), 'listing_ownership_invalid');
    return row;
  }
  async domainSet(active, id = this.run.fixtures.listing.id) {
    requireThat(typeof active === 'boolean' && (id === this.run.fixtures.listing.id || id === this.run.fixtures.competitor?.id), 'domain_target_invalid');
    await this.ownedListing();
    requireThat(responseCode(await this.mutate('domain_set', id, { method: 'POST', rpc: 'set_room_pass_listing_active',
      args: { p_id: id, p_active: active } })) === 'ok', 'domain_set_failed');
  }
  async createCompetitor() {
    requireThat(!this.run.fixtures.competitor && (await this.ownedListing()).active === false, 'competitor_precondition_failed');
    this.run.fixtures.competitor = { id: null, marker: `${this.run.marker}-conflict` }; await this.save();
    requireThat(responseCode(await this.mutate('create_competitor', this.run.fixtures.room.id, {
      method: 'POST', rpc: 'upsert_room_pass_listing', args: { p_id: null, p_room_id: this.run.fixtures.room.id,
        p_contact_name: `FAKE-${this.run.runId}`, p_contact_phone: '000-RP17-FAKE', p_sale_policy: this.run.fixtures.competitor.marker,
        p_pass_price: 0, p_active: false, p_avail_date: null, p_contact_manager: false },
    })) === 'ok', 'competitor_create_failed');
    const rows = await this.read('room_pass_listings', { room_id: this.run.fixtures.room.id }, 'id,user_id,created_by,organization_id,building_id,room_id,sale_policy,active');
    const found = rows.filter(row => row.sale_policy === this.run.fixtures.competitor.marker);
    requireThat(rows.length === 2 && found.length === 1 && found[0].user_id === this.run.actorId && found[0].created_by === this.run.actorId
      && found[0].building_id === this.run.fixtures.building.id && found[0].active === false, 'competitor_ownership_invalid');
    this.run.fixtures.competitor.id = found[0].id; await this.save();
  }
  async deleteCompetitor() {
    const c = this.run.fixtures.competitor;
    if (!c) return;
    requireThat(UUID.test(c.id), 'competitor_reconciliation_required');
    const rows = await this.read('room_pass_listings', { id: c.id }, 'id,user_id,created_by,organization_id,building_id,room_id,sale_policy,active');
    requireThat(rows.length === 1 && rows[0].user_id === this.run.actorId && rows[0].created_by === this.run.actorId
      && rows[0].building_id === this.run.fixtures.building.id && rows[0].room_id === this.run.fixtures.room.id
      && rows[0].sale_policy === c.marker, 'competitor_ownership_invalid');
    await this.domainSet(false, c.id);
    requireThat(responseCode(await this.mutate('delete_competitor', c.id, { method: 'POST', rpc: 'delete_room_pass_listing', args: { p_id: c.id } })) === 'ok', 'competitor_delete_failed');
    requireThat((await this.read('room_pass_listings', { id: c.id }, 'id')).length === 0, 'competitor_delete_unverified');
    c.deleted = true; await this.save();
  }
  async setup() {
    requireThat(this.run.status === 'prepared' && this.run.operations.length === 0, 'setup_already_started');
    await this.identity();
    const b = this.run.fixtures.building, r = this.run.fixtures.room;
    requireThat((await this.read('buildings', { id: b.id }, 'id')).length === 0
      && (await this.read('rooms', { id: r.id }, 'id')).length === 0, 'fixture_collision');
    this.run.status = 'setting_up'; await this.save();
    // Same authenticated inserts as useCreateBuilding/useCreateRoom. Administrative
    // fixture strings follow inspection-gps-evidence.spec.ts; no existing row borrowed.
    requireThat(responseCode(await this.mutate('create_building', b.id, { method: 'POST', table: 'buildings',
      body: { ...b, province: 'TP. Hồ Chí Minh', district: 'Gò Vấp', ward: 'Phường 1',
        street_address: 'Fixture Task17', type: 'APARTMENT', status: 'ACTIVE' } })) === 'ok', 'building_create_failed');
    requireThat(responseCode(await this.mutate('create_room', r.id, { method: 'POST', table: 'rooms',
      body: { ...r, rent_price: 0, deposit_amount: 0, floor: 1, status: 'AVAILABLE' } })) === 'ok', 'room_create_failed');
    await this.ownedParents();
    requireThat((await this.read('room_pass_listings', { room_id: r.id }, 'id')).length === 0, 'listing_collision');
    requireThat(responseCode(await this.mutate('create_listing', r.id, { method: 'POST', rpc: 'upsert_room_pass_listing', args: {
      p_id: null, p_room_id: r.id, p_contact_name: `FAKE-${this.run.runId}`, p_contact_phone: '000-RP17-FAKE',
      p_sale_policy: this.run.marker, p_pass_price: 0, p_active: false, p_avail_date: null, p_contact_manager: false,
    } })) === 'ok', 'listing_create_failed');
    const listing = await this.ownedListing();
    requireThat(listing.active === false, 'listing_initial_state_invalid');
    this.run.fixtures.listing.id = listing.id; await this.save();
    const other = this.run.fixtures.scopeBuilding;
    requireThat((await this.read('buildings', { id: other.id }, 'id')).length === 0, 'scope_building_collision');
    requireThat(responseCode(await this.mutate('create_scope_building', other.id, { method: 'POST', table: 'buildings',
      body: { ...other, province: 'TP. Hồ Chí Minh', district: 'Gò Vấp', ward: 'Phường 1', street_address: 'Fixture Task17',
        type: 'APARTMENT', status: 'ACTIVE' } })) === 'ok', 'scope_building_create_failed');
    this.run.status = 'ready'; await this.save();
    return listing.id;
  }
  assertPrivate(value) {
    const text = JSON.stringify(value);
    requireThat(!text.includes(`FAKE-${this.run.runId}`) && !text.includes('000-RP17-FAKE')
      && !/"contact_(name|phone)"/.test(text), 'contact_disclosed');
  }
  async preview(active) {
    requireThat(typeof active === 'boolean', 'active_invalid');
    const before = await this.ownedListing();
    const response = await this.mutate('preview', before.id, { method: 'POST', rpc: 'copilot_preview_room_pass_active_v1', args: {
      p_organization_id: DEMO, p_payload: { listing_id: before.id, active },
    } });
    requireThat(responseCode(response) === 'ok', 'preview_denied');
    const p = response.body;
    requireThat(/^[0-9a-f]{64}$/.test(p.confirmation_nonce) && p.canonical?.organization_id === DEMO
      && p.canonical.listing_id === before.id && p.canonical.building_id === before.building_id
      && p.canonical.room_id === before.room_id && p.canonical.before_active === before.active
      && p.canonical.active === active && /^[0-9a-f]{64}$/.test(p.canonical.before_revision)
      && p.canonical.building_label === this.run.marker && p.canonical.room_label === this.run.marker, 'preview_invalid');
    this.assertPrivate(p.canonical); this.assertPrivate(p.preview);
    return p; // nonce stays in memory only, never enters the journal.
  }
  async execute(proposal) {
    requireThat(proposal.canonical.organization_id === DEMO
      && proposal.canonical.listing_id === this.run.fixtures.listing.id, 'proposal_scope_invalid');
    await this.ownedListing();
    const response = await this.mutate('execute', this.run.fixtures.listing.id, {
      method: 'POST', rpc: 'copilot_execute_room_pass_active_v1', args: {
        p_confirmation_nonce: proposal.confirmation_nonce, p_payload: proposal.canonical,
      },
    });
    if (responseCode(response) === 'ok') {
      this.assertPrivate(response.body);
      requireThat(response.body.entity_table === 'room_pass_listings' && response.body.entity_id === this.run.fixtures.listing.id
        && UUID.test(response.body.audit_id) && UUID.test(response.body.ledger_id)
        && (await this.ownedListing()).active === proposal.canonical.active, 'execute_readback_failed');
    }
    return response;
  }
  async cleanupFixtures() {
    requireThat(!this.run.operations.some(op => ['unknown', 'intent'].includes(op.state)), 'unsettled_operation');
    requireThat(!this.run.scenarios.some(item => ['unknown', 'intent'].includes(item.state)), 'unsettled_session');
    requireThat(!this.run.browser || this.run.browser.state === 'settled', 'unsettled_browser');
    const f = this.run.fixtures;
    await this.cleanupScopeBuilding();
    // Partial setup is recoverable; verify individual parent identity before touching it.
    const buildings = await this.read('buildings', { id: f.building.id }, 'id,user_id,name,organization_id,deleted_at');
    if (!buildings.length) {
      requireThat(!this.run.operations.some(op => op.name === 'create_building' && ['acknowledged', 'reconciled_committed'].includes(op.state)), 'building_missing');
      requireThat((await this.read('rooms', { id: f.room.id }, 'id')).length === 0
        && (await this.read('room_pass_listings', { room_id: f.room.id }, 'id')).length === 0, 'orphan_fixture_detected');
      this.run.fixtureCleanup = { status: 'done', retainedParentTombstones: this.run.scopeBuildingTombstone ? 1 : 0 }; await this.save(); return;
    }
    requireThat(buildings.length === 1 && buildings[0].user_id === this.run.actorId && buildings[0].name === this.run.marker, 'building_ownership_invalid');
    const rooms = await this.read('rooms', { building_id: f.building.id }, 'id,name,building_id,organization_id,deleted_at');
    requireThat(rooms.every(row => row.id === f.room.id && row.name === this.run.marker), 'room_ownership_ambiguous');
    if (rooms.length && !rooms[0].deleted_at) {
      if (f.competitor && !f.competitor.deleted) await this.deleteCompetitor();
      const listing = await this.ownedListing({ absent: true });
      if (listing) {
        f.listing.id = listing.id; await this.save();
        const restored = await this.execute(await this.preview(false));
        requireThat(responseCode(restored) === 'ok', 'compensation_failed');
        requireThat(responseCode(await this.mutate('delete_listing', listing.id, { method: 'POST', rpc: 'delete_room_pass_listing', args: { p_id: listing.id } })) === 'ok', 'listing_delete_failed');
        requireThat(await this.ownedListing({ absent: true }) === null, 'listing_delete_unverified');
      }
      requireThat(responseCode(await this.mutate('delete_room', f.room.id, { method: 'PATCH', table: 'rooms',
        filters: { id: f.room.id, building_id: f.building.id, organization_id: DEMO, name: this.run.marker },
        body: { deleted_at: new Date().toISOString() } })) === 'ok', 'room_delete_failed');
    }
    requireThat((await this.read('rooms', { building_id: f.building.id, deleted_at: null }, 'id')).length === 0, 'building_has_rooms');
    requireThat((await this.read('room_pass_listings', { room_id: f.room.id }, 'id')).length === 0, 'parent_deleted_with_live_listing');
    if (rooms.length) {
      const finalRoom = await this.read('rooms', { id: f.room.id }, 'id,name,deleted_at');
      requireThat(finalRoom.length === 1 && finalRoom[0].name === this.run.marker && finalRoom[0].deleted_at, 'room_delete_unverified');
    }
    if (!buildings[0].deleted_at) requireThat(responseCode(await this.mutate('delete_building', f.building.id, { method: 'PATCH', table: 'buildings',
      filters: { id: f.building.id, user_id: this.run.actorId, organization_id: DEMO, name: this.run.marker },
      body: { deleted_at: new Date().toISOString() } })) === 'ok', 'building_delete_failed');
    const final = await this.read('buildings', { id: f.building.id }, 'id,deleted_at');
    requireThat(final.length === 1 && final[0].deleted_at, 'building_delete_unverified');
    this.run.fixtureCleanup = { status: 'done', retainedParentTombstones: rooms.length + 1 + (this.run.scopeBuildingTombstone ? 1 : 0) };
    await this.save();
  }
  async cleanupScopeBuilding() {
    const b = this.run.fixtures.scopeBuilding;
    if (!b) return;
    const rows = await this.read('buildings', { id: b.id }, 'id,user_id,name,organization_id,deleted_at');
    requireThat(rows.length <= 1, 'scope_building_ambiguous');
    if (!rows.length) {
      requireThat(!this.run.operations.some(op => op.name === 'create_scope_building' && ['acknowledged', 'reconciled_committed'].includes(op.state)), 'scope_building_missing');
      return;
    }
    requireThat(rows[0].name === b.name && rows[0].user_id === this.run.actorId
      && (await this.read('rooms', { building_id: b.id }, 'id')).length === 0, 'scope_building_ownership_invalid');
    if (!rows[0].deleted_at) requireThat(responseCode(await this.mutate('delete_scope_building', b.id, { method: 'PATCH', table: 'buildings',
      filters: { id: b.id, organization_id: DEMO, user_id: this.run.actorId, name: b.name }, body: { deleted_at: new Date().toISOString() } })) === 'ok', 'scope_building_delete_failed');
    const after = await this.read('buildings', { id: b.id }, 'id,deleted_at');
    requireThat(after.length === 1 && after[0].deleted_at, 'scope_building_delete_unverified');
    this.run.scopeBuildingTombstone = true; await this.save();
  }
}
