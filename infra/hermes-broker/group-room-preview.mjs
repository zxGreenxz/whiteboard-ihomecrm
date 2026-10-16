import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { mayUseGroupTool } from './capability-contract.mjs';

// Pure formatting/canonicalization after trusted live admission.
// This is NOT an authorization implementation or an RPC/queue adapter. None of
// these snapshots may come from MCP arguments. The decision adapter derives
// them using the opaque connection handle + real user JWT and a final SQL fence.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const UID = /^[1-9][0-9]{0,39}$/;
const MAX_AGE_MS = 300_000;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
function exact(value, keys) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('draft_input_invalid');
}
function array(value, cap) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > cap ||
      Reflect.ownKeys(value).length !== value.length + 1) fail('draft_input_invalid');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('draft_input_invalid');
  }
  return value;
}
function ids(value, cap, nonempty = true) {
  const rows = array(value, cap);
  if ((nonempty && !rows.length) || rows.some(row => !id(row)) || new Set(rows).size !== rows.length) fail('draft_input_invalid');
  return [...rows].sort();
}
function label(value, cap = 500) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > cap ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('draft_input_invalid');
  return value;
}
function time(value) {
  if (typeof value !== 'string') fail('draft_input_invalid');
  const parsed = Date.parse(value);
  if (!positive(parsed) || new Date(parsed).toISOString() !== value) fail('draft_input_invalid');
  return parsed;
}
function day(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('draft_input_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('draft_input_invalid');
  return value;
}
function amount(value) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) fail('draft_input_invalid');
  return value;
}
function freeze(value) {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const amountLabel = value => value === null ? 'chưa công bố' : value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Only room/conversation IDs are model-controlled. This formatter accepts one
 * finalized room-read page; all requested rooms must occur in that same page.
 * It does not merge snapshots, broaden missing scopes or silently drop targets.
 * `authority`, `roomRead`, `recipientRead` and `now` are trusted-only inputs.
 * SHA256 below is a proposal binding, NOT a consent token/signature/permission.
 */
export function buildGroupRoomPreview({ intent, authority, roomRead, recipientRead, now }) {
  if (!positive(now)) fail('draft_input_invalid');
  exact(intent, ['roomIds', 'conversationIds']);
  const roomIds = ids(intent.roomIds, 20), conversationIds = ids(intent.conversationIds, 8);
  exact(authority, ['owner', 'binding', 'contextVersion', 'expiresAt', 'effective', 'scopeIds', 'allowedBuildingIds']);
  exact(authority.owner, ['userId', 'organizationId', 'assistantId', 'connectionId']);
  if (Object.values(authority.owner).some(value => !id(value)) || typeof authority.contextVersion !== 'string' || !SHA.test(authority.contextVersion) || !positive(authority.expiresAt)) fail('draft_input_invalid');
  exact(authority.binding, ['epoch', 'policyVersion', 'membershipId', 'authorizationVersion', 'sessionRevision']);
  if (!id(authority.binding.membershipId) || Object.entries(authority.binding).some(([key, value]) => key !== 'membershipId' && !(key === 'policyVersion' && value === 0) && !positive(value))) fail('draft_input_invalid');
  exact(authority.effective, ['read', 'action']);
  for (const mode of ['read', 'action']) {
    const keys = array(authority.effective[mode], 256);
    if (keys.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(key)) || new Set(keys).size !== keys.length) fail('draft_input_invalid');
  }
  if (!mayUseGroupTool(authority.effective, 'preview')) fail('draft_forbidden');
  const scopeIds = ids(authority.scopeIds, 256), allowedBuildingIds = ids(authority.allowedBuildingIds, 256);
  for (const input of [roomRead, recipientRead]) {
    if (!record(input)) fail('draft_input_invalid');
    if (input.organizationId !== authority.owner.organizationId || input.contextVersion !== authority.contextVersion) fail('draft_context_changed');
  }
  exact(roomRead, ['organizationId', 'contextVersion', 'result']);
  const result = roomRead.result;
  exact(result, ['source', 'readAt', 'currency', 'completeness', 'publishedPages', 'totalInSnapshot', 'offset', 'nextOffset', 'salePolicies', 'buildings', 'rooms']);
  if (result.source !== 'hermes_sale_listing_rooms_v1' || result.currency !== 'VND' || result.completeness !== 'complete') fail('draft_source_incomplete');
  if (!Number.isSafeInteger(result.totalInSnapshot) || result.totalInSnapshot < 1 || result.totalInSnapshot > 2000 ||
      !Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset >= result.totalInSnapshot) fail('draft_input_invalid');
  const rows = array(result.rooms, 100), seenRooms = new Set(), facts = new Map();
  if (!rows.length || result.offset + rows.length > result.totalInSnapshot ||
      result.nextOffset !== (result.offset + rows.length < result.totalInSnapshot ? result.offset + rows.length : null)) fail('draft_input_invalid');
  for (const row of rows) {
    if (!record(row) || !id(row.id) || seenRooms.has(row.id)) fail('draft_input_invalid');
    seenRooms.add(row.id);
    if (!roomIds.includes(row.id)) continue;
    exact(row.building, ['id', 'name', 'code']);
    if (!id(row.building.id) || !allowedBuildingIds.includes(row.building.id)) fail('draft_forbidden');
    if (!['free', 'soon', 'pass'].includes(row.status)) fail('draft_input_invalid');
    exact(row.availability, ['kind', 'label', 'availableOn']);
    if (!['ready', 'notice', 'confirm_notice', 'preparing', 'pass'].includes(row.availability.kind) || (row.status === 'pass') !== (row.availability.kind === 'pass')) fail('draft_input_invalid');
    facts.set(row.id, {
      roomId: row.id, buildingId: row.building.id,
      roomLabel: label(row.code === null ? row.name : row.code, 500), buildingLabel: label(row.building.name),
      areaM2: amount(row.areaM2), rentVnd: amount(row.priceVnd), status: row.status,
      availability: { kind: row.availability.kind, label: label(row.availability.label, 500), availableOn: day(row.availability.availableOn) },
    });
  }
  if (roomIds.some(value => !facts.has(value))) fail('draft_selection_missing');
  exact(recipientRead, ['organizationId', 'contextVersion', 'readAt', 'sender', 'allowedConversationIds', 'conversations']);
  exact(recipientRead.sender, ['accountId', 'name', 'ownUid', 'loginRequestedAt', 'botVersion', 'ingressGeneration']);
  const sender = recipientRead.sender;
  if (!id(sender.accountId) || !positive(sender.botVersion) || !id(sender.ingressGeneration) || typeof sender.ownUid !== 'string' || !UID.test(sender.ownUid)) fail('draft_input_invalid');
  if (sender.loginRequestedAt !== null) time(sender.loginRequestedAt);
  label(sender.name);
  const allowed = ids(recipientRead.allowedConversationIds, 256), destinations = new Map();
  for (const row of array(recipientRead.conversations, 256)) {
    exact(row, ['conversationId', 'organizationId', 'accountId', 'threadId', 'threadType', 'name']);
    if (!id(row.conversationId) || destinations.has(row.conversationId) || !id(row.organizationId) || !id(row.accountId) ||
        typeof row.threadId !== 'string' || !UID.test(row.threadId) || !['group', 'user'].includes(row.threadType)) fail('draft_input_invalid');
    destinations.set(row.conversationId, row);
  }
  const recipients = conversationIds.map(conversationId => {
    const row = destinations.get(conversationId);
    if (!row) fail('draft_selection_missing');
    if (!allowed.includes(conversationId) || row.organizationId !== authority.owner.organizationId ||
        row.accountId !== sender.accountId || row.threadType !== 'group') fail('draft_forbidden');
    return { conversationId, threadId: row.threadId, name: label(row.name) };
  });
  if (new Set(recipients.map(row => row.threadId)).size !== recipients.length) fail('draft_input_invalid');
  const roomReadAt = time(result.readAt), recipientReadAt = time(recipientRead.readAt);
  if ([roomReadAt, recipientReadAt].some(at => at > now || now - at >= MAX_AGE_MS) || authority.expiresAt <= now) fail('draft_expired');
  const expiresAt = Math.min(authority.expiresAt, roomReadAt + MAX_AGE_MS, recipientReadAt + MAX_AGE_MS);
  const publicFacts = roomIds.map(value => facts.get(value));
  const body = ['PHÒNG ĐÃ CHỌN', ...publicFacts.map((row, index) =>
    `${index + 1}. ${row.buildingLabel} · ${row.roomLabel} | ${amountLabel(row.areaM2)} m² | ${amountLabel(row.rentVnd)} đ/tháng | ${row.availability.label}`)].join('\n');
  if (Buffer.byteLength(body) > 8192) fail('draft_body_too_large');
  const canonical = {
    schema: 'hermes.room-group-preview.v1', actionId: 'zalo.broadcast', fieldSet: 'selected-room-sale-text-v1',
    owner: Object.fromEntries(['userId', 'organizationId', 'assistantId', 'connectionId'].map(key => [key, authority.owner[key]])),
    binding: Object.fromEntries(['epoch', 'policyVersion', 'membershipId', 'authorizationVersion', 'sessionRevision'].map(key => [key, authority.binding[key]])),
    contextVersion: authority.contextVersion,
    scopeIds, allowedBuildingIds, source: { rpc: result.source, roomReadAt: result.readAt, recipientReadAt: recipientRead.readAt },
    sender: Object.fromEntries(['accountId', 'name', 'ownUid', 'loginRequestedAt', 'botVersion', 'ingressGeneration'].map(key => [key, sender[key]])),
    recipients, publicFacts, body, expiresAt,
  };
  return freeze({ status: 'draft_only', canonical, digest: hash(canonical),
    display: { body, sender: sender.name, recipients: recipients.map(row => ({ conversationId: row.conversationId, name: row.name })), expiresAt } });
}

function requestIntent(value) {
  try {
    exact(value, ['roomIds', 'conversationIds']);
    return freeze({ roomIds: ids(value.roomIds, 20), conversationIds: ids(value.conversationIds, 8) });
  } catch { throw new BrokerError('invalid_request'); }
}

const deny = code => { throw new BrokerError(code); };
function timestamp(value) {
  return positive(value) && value <= 8_640_000_000_000_000;
}
function decisionSnapshot(payload, expected, now) {
  try { exact(payload, ['decision', 'authority', 'recipientRead']); } catch { deny('backend_unavailable'); }
  const decision = payload.decision;
  try { exact(decision, ['kind', 'outcome', 'decisionId', 'tokenDigest', 'intentDigest', 'roomReadDigest',
    'contextVersion', 'checkedAt', 'expiresAt']); } catch { deny('backend_unavailable'); }
  if (decision.kind !== 'hermes.group-room-preview.v1' || !['allow', 'deny'].includes(decision.outcome) ||
      !id(decision.decisionId) || !['tokenDigest', 'intentDigest', 'roomReadDigest', 'contextVersion']
        .every(key => typeof decision[key] === 'string' && SHA.test(decision[key])) ||
      !timestamp(decision.checkedAt) || !timestamp(decision.expiresAt)) deny('backend_unavailable');
  if (decision.outcome === 'deny') deny('forbidden');
  if (['tokenDigest', 'intentDigest', 'roomReadDigest'].some(key => decision[key] !== expected[key]) ||
      !record(payload.authority) || decision.contextVersion !== payload.authority.contextVersion ||
      decision.checkedAt < expected.startedAt || decision.checkedAt > now || decision.expiresAt <= now ||
      decision.expiresAt > decision.checkedAt + MAX_AGE_MS) deny('context_changed');
  return payload;
}

/** Preview orchestration, mounted through the trusted group factory. Its
 * separately named send finalizer queues a SQL-derived message under current
 * delegated user authority. Neither finalizer accepts a model-authored body.
 *
 * `roomReads` is the existing createRoomReadService. `decisions` is a mandatory,
 * trusted server dependency whose prepare(token, intent, {signal}) returns an
 * opaque, single-use local receipt, and finalize(token, receipt, binding,
 * {signal}) returns {decision, authority, recipientRead}. A JSON field claiming
 * verification is never accepted as an MCP
 * argument or as a replacement for this dependency.
 *
 * Backend implementation requirements:
 * - prepare derives actor/org/assistant/connection from the opaque token, reads
 *   read capabilities using the existing authority engine, and captures monotonic
 *   connection/policy/membership/session/auth/scope/bot versions. It fails closed
 *   when rooms.view or chat_zalo.view is absent; only dispatch additionally needs chat_zalo.send.
 * - finalize consumes its receipt and obtains a LAST bound SQL decision using
 *   the real user session. One statement rechecks versions, current room scope,
 *   group membership, sending bot/account and read permissions. Dispatch also checks the action. It
 *   rejects any change since prepare and binds the supplied intent/room digests.
 *   Return current available-room facts from that same SQL statement, reproject
 *   synchronously with binding.roomReadAt and the same first-page filters, and
 *   reject if its digest differs. Echoing a digest alone is not freshness proof.
 * - both operations keep JWT/token/receipts local; only the explicitly named
 *   dispatch operation may enqueue. It uses a dedicated action RPC, must
 *   respect abort and do not retry unknown writes. Use no caller-asserted actor
 *   or fabricated JWT. The checks below validate protocol, not live SQL truth.
 *
 * Caller admission/quota/audit are still required. Await audit BETWEEN prepare
 * and finalize; only finalize releases the public preview. Its final awaited
 * operation is decisions.finalize (or the explicit decisions.dispatch queue
 * write). Dispatched write uncertainty propagates without a retry. Receipts are token-bound, process-local,
 * single-use, short lived and contain no accessible data. No convenience method
 * bypasses the audit seam. The room operation reads one fixed page (first 100); all
 * selected rooms must occur in it. It never merges pages from distinct reads.
 */
export function createGroupRoomPreviewService({ roomReads, decisions, clock = Date.now, timeoutMs = 30000 } = {}) {
  if ([roomReads?.prepareAvailableRooms, roomReads?.finalizeAvailableRooms, decisions?.prepare,
    decisions?.finalize, clock].some(fn => typeof fn !== 'function') ||
    !positive(timeoutMs) || timeoutMs > 30000) throw new TypeError('group_preview_backend_required');
  // Capture bound methods at construction; request objects cannot replace them.
  const prepareRooms = roomReads.prepareAvailableRooms.bind(roomReads);
  const finalizeRooms = roomReads.finalizeAvailableRooms.bind(roomReads);
  const prepareDecision = decisions.prepare.bind(decisions), finalizeDecision = decisions.finalize.bind(decisions);
  const issued = new WeakMap();
  const now = () => { const value = clock(); if (!timestamp(value)) deny('backend_unavailable'); return value; };
  const tokenDigest = value => {
    if (typeof value !== 'string' || !TOKEN.test(value)) deny('unauthorized');
    return createHash('sha256').update(value).digest('hex');
  };
  async function bounded(signal, deadline, operation) {
    if (!(signal instanceof AbortSignal)) deny('invalid_request');
    if (signal.aborted || now() >= deadline) deny('timeout');
    const controller = new AbortController(); let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = () => { controller.abort(); rejectAbort(new BrokerError('timeout')); };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, Math.min(timeoutMs, deadline - now()));
    const check = () => { if (signal.aborted || controller.signal.aborted || now() >= deadline) deny('timeout'); };
    try { return await Promise.race([Promise.resolve().then(() => { check(); return operation(controller.signal, check); }), aborted]); }
    catch (error) {
      if (error instanceof BrokerError) throw error;
      if (error?.code === 'draft_forbidden') deny('forbidden');
      if (['draft_expired', 'draft_context_changed'].includes(error?.code)) deny('context_changed');
      if (error?.code === 'draft_selection_missing') deny('invalid_request');
      if (error?.code === 'draft_body_too_large') deny('response_too_large');
      deny('backend_unavailable');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
  }
  async function prepareGroupRoomPreview(presentedToken, suppliedIntent, { signal } = {}) {
    const digest = tokenDigest(presentedToken), intent = requestIntent(suppliedIntent);
    const startedAt = now(), deadline = startedAt + timeoutMs;
    return bounded(signal, deadline, async (innerSignal, check) => {
      // Check both read capabilities before reading the selected room facts.
      const decisionReceipt = await prepareDecision(presentedToken, intent, { signal: innerSignal }); check();
      if (decisionReceipt === null || typeof decisionReceipt !== 'object') deny('backend_unavailable');
      const roomReceipt = await prepareRooms(presentedToken, { offset: 0, limit: 100 }, { signal: innerSignal }); check();
      if (roomReceipt === null || typeof roomReceipt !== 'object') deny('backend_unavailable');
      const receipt = Object.freeze({});
      issued.set(receipt, { digest, intent, intentDigest: hash(intent), startedAt, deadline, decisionReceipt, roomReceipt });
      return receipt;
    });
  }
  async function finalize(presentedToken, prepared, { signal, onDispatch, onRejected } = {}, send = false) {
    const digest = tokenDigest(presentedToken);
    if (!issued.has(prepared)) deny('context_changed');
    const snapshot = issued.get(prepared); issued.delete(prepared);
    if (digest !== snapshot.digest) deny('context_changed');
    let uncertain = false;
    if (send && (typeof decisions.dispatch !== 'function' || [onDispatch, onRejected].some(fn => typeof fn !== 'function'))) deny('tool_not_available');
    const dispatched = dispatchId => { uncertain = true; onDispatch(dispatchId); }, rejected = () => { uncertain = false; onRejected(); };
    try { return await bounded(signal, snapshot.deadline, async (innerSignal, check) => {
      const result = await finalizeRooms(presentedToken, snapshot.roomReceipt, { signal: innerSignal }); check();
      // Clone and freeze before the final await: a dependency cannot mutate the
      // room content after its digest was sent to the backend decision point.
      let roomResult;
      try { roomResult = freeze(structuredClone(result)); } catch { deny('backend_unavailable'); }
      time(roomResult?.readAt);
      const binding = freeze({ intentDigest: snapshot.intentDigest, roomReadDigest: hash(roomResult), roomReadAt: roomResult.readAt });
      const final = await (send ? decisions.dispatch(presentedToken, snapshot.decisionReceipt, binding,
        { signal: innerSignal, onDispatch: dispatched, onRejected: rejected }) : finalizeDecision(presentedToken, snapshot.decisionReceipt, binding, { signal: innerSignal })); check();
      if (send) exact(final, ['decision', 'authority', 'recipientRead', 'dispatch']);
      const current = decisionSnapshot(send ? { decision: final.decision, authority: final.authority, recipientRead: final.recipientRead } : final,
        { ...binding, tokenDigest: digest, startedAt: snapshot.startedAt }, now());
      if (send && !mayUseGroupTool(current.authority.effective, 'send')) deny('forbidden');
      const preview = buildGroupRoomPreview({ intent: snapshot.intent, authority: current.authority,
        roomRead: { organizationId: current.authority.owner?.organizationId,
          contextVersion: current.authority.contextVersion, result: roomResult },
        recipientRead: current.recipientRead, now: now() });
      if (send) {
        const dispatch = final.dispatch; exact(dispatch, ['id', 'expiresAt', 'recipients']);
        const expiresAt = time(dispatch.expiresAt), rows = array(dispatch.recipients, 8), seen = new Set(), jobs = new Set();
        if (!id(dispatch.id) || expiresAt <= now() || expiresAt > now() + MAX_AGE_MS || rows.length !== snapshot.intent.conversationIds.length) deny('backend_unavailable');
        const recipients = rows.map(row => {
          exact(row, ['conversationId', 'jobId', 'status']);
          const selected = preview.display.recipients.find(value => value.conversationId === row.conversationId);
          if (!selected || !id(row.jobId) || row.status !== 'queued' || seen.has(row.conversationId) || jobs.has(row.jobId)) deny('backend_unavailable');
          seen.add(row.conversationId); jobs.add(row.jobId); return { ...selected, status: 'queued' };
        });
        return freeze({ status: 'queued', dispatchId: dispatch.id, expiresAt: dispatch.expiresAt, recipients });
      }
      const expiresAt = Math.min(preview.canonical.expiresAt, current.decision.expiresAt);
      const canonical = { ...preview.canonical, expiresAt,
        decision: { decisionId: current.decision.decisionId, checkedAt: current.decision.checkedAt,
          intentDigest: binding.intentDigest, roomReadDigest: binding.roomReadDigest } };
      // Internal owner/provider/binding facts participate in the digest but are
      // never sent to the model. Digest is NOT approval, a nonce or a send token.
      return freeze({ status: 'preview_only', fieldSet: canonical.fieldSet, digest: hash(canonical),
        display: { ...preview.display, expiresAt } });
    }); } catch (error) { if (send && uncertain) deny('send_outcome_unknown'); throw error; }
  }
  return Object.freeze({ prepareGroupRoomPreview,
    finalizeGroupRoomPreview: (token, receipt, options) => finalize(token, receipt, options),
    ...(typeof decisions.dispatch === 'function' ? {
      finalizeGroupRoomSend: (token, receipt, options) => finalize(token, receipt, options, true),
    } : {}),
  });
}
