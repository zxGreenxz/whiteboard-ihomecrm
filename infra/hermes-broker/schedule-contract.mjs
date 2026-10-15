// CRM owns this schedule. Native Hermes schedules remain outside this contract.
// Limits reuse the current standing-grant and group-send bounds; timezone and
// catch-up behavior match the existing worker automation scheduler.
export const SCHEDULE_LIMITS = Object.freeze({ days: 30, messagesPerDay: 200, groups: 8, buildings: 20, rooms: 20 });
// The SQL template registry decides which of these is currently enabled; the
// policy notice starts disabled and a disabled template is refused by CRM.
export const SCHEDULE_TEMPLATES = Object.freeze(['rooms_public_text_v1', 'sale_policy_public_text_v1']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const id = value => typeof value === 'string' && UUID.test(value);
const iso = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new TypeError('invalid_schedule_request'); };
// Same character rule as the SQL ledger: printable text, newline/tab allowed.
const note = value => typeof value === 'string' && value.length >= 1 && value.length <= 500 && value.trim() !== '' &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
function ids(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 || new Set(value).size !== value.length) fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !id(descriptor.value)) fail();
  }
  return [...value].sort();
}
function settings(value, now) {
  if (!exact(value, ['template', 'buildingIds', 'conversationIds', 'weekdays', 'time', 'timeZone', 'maxRooms', 'maxMessagesPerDay', 'expiresAt'])) fail();
  if (!SCHEDULE_TEMPLATES.includes(value.template) || typeof value.timeZone !== 'string' || value.timeZone.length > 100 ||
      typeof value.time !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.time)) fail();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }); } catch { fail(); }
  if (!Array.isArray(value.weekdays) || Object.getPrototypeOf(value.weekdays) !== Array.prototype ||
      value.weekdays.length < 1 || value.weekdays.length > 7 || Reflect.ownKeys(value.weekdays).length !== value.weekdays.length + 1 ||
      value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(value.weekdays).size !== value.weekdays.length) fail();
  const expires = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== value.expiresAt || expires <= now || expires > now + 30 * 86400000 ||
      !Number.isInteger(value.maxRooms) || value.maxRooms < 1 || value.maxRooms > SCHEDULE_LIMITS.rooms ||
      !Number.isInteger(value.maxMessagesPerDay) || value.maxMessagesPerDay < 1 || value.maxMessagesPerDay > SCHEDULE_LIMITS.messagesPerDay) fail();
  const conversationIds = ids(value.conversationIds, SCHEDULE_LIMITS.groups);
  if (value.maxMessagesPerDay < conversationIds.length) fail();
  return { template: value.template, buildingIds: ids(value.buildingIds, SCHEDULE_LIMITS.buildings), conversationIds,
    weekdays: [...value.weekdays].sort((a, b) => a - b), time: value.time, timeZone: value.timeZone,
    maxRooms: value.maxRooms, maxMessagesPerDay: value.maxMessagesPerDay, expiresAt: value.expiresAt };
}
const operations = Object.freeze({ crm_room_schedule_create: 'create', crm_room_schedule_update: 'update',
  crm_room_schedule_revoke: 'revoke', crm_room_schedule_list: 'list', crm_room_schedule_issues: 'issues',
  crm_room_schedule_reconcile: 'reconcile' });
export const scheduleOperation = name => Object.hasOwn(operations, name) ? operations[name] : undefined;
export function mayUseSchedule(effective, operation) {
  const view = effective?.read?.includes('chat_zalo.view') === true;
  if (operation === 'list' || operation === 'issues') return view;
  // Attesting a delivery outcome needs the Action that produced it; SQL checks
  // the job's own origin (schedule => manage_automation, one-off => send).
  if (operation === 'reconcile') return view && (effective?.action?.includes('chat_zalo.manage_automation') === true ||
    effective?.action?.includes('chat_zalo.send') === true);
  if (!effective?.action?.includes('chat_zalo.manage_automation')) return false;
  return operation === 'revoke' || ['create', 'update'].includes(operation) && effective.action.includes('chat_zalo.send') &&
    view && effective.read?.includes('rooms.view') === true;
}
const OUTCOMES = ['queued', 'no_rooms', 'missed', 'baseline', 'unchanged'];
const DELIVERY = ['queued', 'processing', 'sent', 'failed', 'unknown', 'confirmed_sent', 'confirmed_not_sent'];
const KINDS = ['authority', 'run', 'delivery', 'expiry'];
function summary(value) {
  if (!exact(value, ['scheduleId', 'revision', 'state', 'settings', 'createdAt', 'lastRuns', 'openIssues']) || !id(value.scheduleId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(value.state) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.lastRuns) || value.lastRuns.length > 200 ||
      !Array.isArray(value.openIssues) || value.openIssues.length > 10) fail();
  // Historical settings may already be expired; shape validation uses their own
  // grant boundary rather than requiring a future expiry when reading history.
  const expiry = Date.parse(value.settings?.expiresAt);
  const checked = settings(value.settings, expiry - 1);
  const seen = new Set();
  const lastRuns = value.lastRuns.map(run => {
    if (!exact(run, ['date', 'conversationId', 'outcome', 'reason', 'dispatchId', 'deliveryStatus']) || typeof run.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(run.date) || !id(run.conversationId) || seen.has(run.conversationId) || !OUTCOMES.includes(run.outcome) ||
        !(run.reason === null || (run.outcome === 'missed' && typeof run.reason === 'string' && CODE.test(run.reason))) ||
        (run.outcome === 'queued' ? !id(run.dispatchId) || !DELIVERY.includes(run.deliveryStatus) : run.dispatchId !== null || run.deliveryStatus !== null)) fail();
    seen.add(run.conversationId); return { ...run };
  });
  const openIssues = value.openIssues.map(issue => {
    if (!exact(issue, ['kind', 'reason', 'occurrences', 'openedAt']) || !KINDS.includes(issue.kind) || typeof issue.reason !== 'string' ||
        !CODE.test(issue.reason) || !Number.isSafeInteger(issue.occurrences) || issue.occurrences < 1 || !iso(issue.openedAt)) fail();
    return { ...issue };
  });
  return { scheduleId: value.scheduleId, revision: value.revision, state: value.state, settings: checked, createdAt: value.createdAt, lastRuns, openIssues };
}
function detail(value) {
  if (!record(value) || JSON.stringify(value).length > 4096) fail();
  return structuredClone(value);
}
function issues(value, input) {
  if (!exact(value, ['issues', 'unknownDeliveries']) || !Array.isArray(value.issues) || value.issues.length > input.limit ||
      !Array.isArray(value.unknownDeliveries) || value.unknownDeliveries.length > input.limit) fail();
  const incidents = value.issues.map(item => {
    if (!exact(item, ['incidentId', 'scheduleId', 'kind', 'reason', 'detail', 'occurrences', 'openedAt', 'lastSeenAt', 'closedAt', 'closeReason']) ||
        !id(item.incidentId) || !id(item.scheduleId) || (input.scheduleId !== null && item.scheduleId !== input.scheduleId) || !KINDS.includes(item.kind) ||
        typeof item.reason !== 'string' || !CODE.test(item.reason) || !Number.isSafeInteger(item.occurrences) || item.occurrences < 1 ||
        !iso(item.openedAt) || !iso(item.lastSeenAt) || (item.closedAt === null) !== (item.closeReason === null) ||
        !(item.closedAt === null || iso(item.closedAt)) ||
        !(item.closeReason === null || ['recovered', 'superseded', 'schedule_revoked', 'grant_replaced'].includes(item.closeReason))) fail();
    return { ...item, detail: detail(item.detail) };
  });
  const unknown = value.unknownDeliveries.map(item => {
    if (!exact(item, ['jobId', 'dispatchId', 'origin', 'scheduleId', 'conversationId', 'createdAt']) || !id(item.jobId) || !id(item.dispatchId) ||
        !['standing_grant', 'external_mcp'].includes(item.origin) || (item.origin === 'standing_grant' ? !id(item.scheduleId) : item.scheduleId !== null) ||
        (input.scheduleId !== null && item.scheduleId !== input.scheduleId) || !id(item.conversationId) || !iso(item.createdAt)) fail();
    return { ...item };
  });
  if (new Set(incidents.map(item => item.incidentId)).size !== incidents.length || new Set(unknown.map(item => item.jobId)).size !== unknown.length) fail();
  return { issues: incidents, unknownDeliveries: unknown };
}
export function scheduleResult(operation, value, _identity, input) {
  if (operation === 'list') {
    if (!exact(value, ['schedules', 'nextCursor']) || !Array.isArray(value.schedules) || value.schedules.length > input.limit || !(value.nextCursor === null || id(value.nextCursor))) fail();
    const schedules = value.schedules.map(summary);
    if (new Set(schedules.map(row => row.scheduleId)).size !== schedules.length) fail();
    if (value.nextCursor !== null && (schedules.length !== input.limit || value.nextCursor !== schedules.at(-1)?.scheduleId)) fail();
    return { schedules, nextCursor: value.nextCursor };
  }
  if (operation === 'issues') return issues(value, input);
  if (operation === 'reconcile') {
    const result = value?.reconciliation;
    if (!exact(value, ['reconciliation']) || !exact(result, ['id', 'kind', 'targetId', 'decision', 'note', 'via', 'createdAt']) || !id(result.id) ||
        result.kind !== 'queue_job' || result.targetId !== input.jobId || result.decision !== input.decision || result.note !== input.note ||
        result.via !== 'hermes_connector' || !iso(result.createdAt)) fail();
    return { reconciliation: { ...result } };
  }
  if (!exact(value, ['schedule'])) fail();
  const schedule = summary(value.schedule);
  if (schedule.scheduleId !== (operation === 'create' ? input.requestId : input.scheduleId) ||
      schedule.revision !== (operation === 'create' ? 1 : input.expectedRevision + 1) ||
      (operation === 'revoke' ? schedule.state !== 'REVOKED' : schedule.state !== 'ACTIVE')) fail();
  if (operation !== 'revoke' && JSON.stringify(schedule.settings) !== JSON.stringify(input.settings)) fail();
  return { schedule };
}
export function scheduleInput(operation, input, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) fail();
  if (operation === 'list') {
    if (!record(input) || Object.keys(input).some(k => !['limit', 'cursor'].includes(k))) fail();
    const result = { limit: 20, cursor: null, ...input };
    if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20 || !(result.cursor === null || id(result.cursor))) fail();
    return result;
  }
  if (operation === 'issues') {
    if (!record(input) || Object.keys(input).some(k => !['limit', 'scheduleId'].includes(k))) fail();
    const result = { limit: 20, scheduleId: null, ...input };
    if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20 || !(result.scheduleId === null || id(result.scheduleId))) fail();
    return result;
  }
  if (operation === 'reconcile') {
    if (!exact(input, ['requestId', 'jobId', 'decision', 'note']) || !id(input.requestId) || !id(input.jobId) ||
        !['sent', 'not_sent'].includes(input.decision) || !note(input.note)) fail();
    return { requestId: input.requestId, jobId: input.jobId, decision: input.decision, note: input.note };
  }
  const keys = operation === 'create' ? ['requestId', 'settings'] : operation === 'update'
    ? ['requestId', 'scheduleId', 'expectedRevision', 'settings'] : operation === 'revoke'
      ? ['requestId', 'scheduleId', 'expectedRevision'] : [];
  if (!keys.length || !exact(input, keys) || !id(input.requestId)) fail();
  if (operation !== 'create' && (!id(input.scheduleId) || !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 || input.expectedRevision >= Number.MAX_SAFE_INTEGER)) fail();
  return { requestId: input.requestId, ...(operation !== 'create' ? { scheduleId: input.scheduleId, expectedRevision: input.expectedRevision } : {}),
    ...(operation !== 'revoke' ? { settings: settings(input.settings, now) } : {}) };
}
const uuid = { type: 'string', format: 'uuid' };
const settingsSchema = { type: 'object', additionalProperties: false, required: ['template', 'buildingIds', 'conversationIds', 'weekdays', 'time', 'timeZone', 'maxRooms', 'maxMessagesPerDay', 'expiresAt'], properties: {
  template: { enum: [...SCHEDULE_TEMPLATES], description: 'rooms_public_text_v1: daily public vacant-room bulletin. sale_policy_public_text_v1: at the set time, compare the public sale policy (company sale policy and sale notes of offered rooms in these buildings) with what each group last received; the first run only records a baseline, later runs send the current public policy once when it changed. CRM may report a template as disabled.' },
  buildingIds: { type: 'array', items: uuid, minItems: 1, maxItems: 20, uniqueItems: true },
  conversationIds: { type: 'array', items: uuid, minItems: 1, maxItems: 8, uniqueItems: true },
  weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1, maxItems: 7, uniqueItems: true, description: 'ISO weekday: Monday=1, Sunday=7.' },
  time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }, timeZone: { type: 'string', maxLength: 100, description: 'Explicit IANA timezone; must equal the CRM organization timezone.' },
  maxRooms: { type: 'integer', minimum: 1, maximum: 20, description: 'Room lines per message (bulletin rooms or policy room notes); a larger set is reported, never truncated.' },
  maxMessagesPerDay: { type: 'integer', minimum: 1, maximum: 200 },
  expiresAt: { type: 'string', format: 'date-time', description: 'Explicit UTC expiry within 30 days. Ask the user if expiry or any other required schedule detail is missing.' },
} };
const descriptions = Object.freeze({
  list: 'Read CRM schedules owned by this connection, including revision, last runs and open issues. CRM remains the only scheduler.',
  issues: 'Read why CRM schedules of this connection are blocked or failing (machine-readable reason, open/closed state) and which deliveries of this connection are UNKNOWN_EFFECT. Read-only; nothing is retried.',
  reconcile: 'Record the user\'s explicit confirmation that one UNKNOWN_EFFECT delivery of this connection did ("sent") or did not ("not_sent") reach the Zalo group, with the user\'s own words as note. Only when the user checked and said so; never guess. This never sends again: a new send is a new request with a new requestId. Reuse requestId on an uncertain outcome.',
});
const mutationDescription = operation => `${operation === 'revoke' ? 'Revoke' : operation === 'update' ? 'Replace the complete scope and settings of' : 'Create'} a CRM schedule (room bulletin or public sale-policy notice) only for a clear user request. CRM verifies current Read/Action rights and standing grant before each run and provider send, records blocked runs and notifies the schedule owner. Never create a second native Hermes cron for this CRM job. Reuse requestId on an uncertain outcome; read the schedule before issuing a different mutation. No PIN or per-job approval is required.`;
const inputSchema = operation => operation === 'list' ? { type: 'object', additionalProperties: false, required: [], properties: {
  limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
  cursor: { type: ['string', 'null'], format: 'uuid', description: 'Use nextCursor from the previous page; null starts from the beginning.' } } }
  : operation === 'issues' ? { type: 'object', additionalProperties: false, required: [], properties: {
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 }, scheduleId: { type: ['string', 'null'], format: 'uuid' } } }
    : operation === 'reconcile' ? { type: 'object', additionalProperties: false, required: ['requestId', 'jobId', 'decision', 'note'], properties: {
      requestId: uuid, jobId: uuid, decision: { enum: ['sent', 'not_sent'] }, note: { type: 'string', minLength: 1, maxLength: 500 } } }
      : { type: 'object', additionalProperties: false, required: operation === 'create' ? ['requestId', 'settings'] :
        operation === 'update' ? ['requestId', 'scheduleId', 'expectedRevision', 'settings'] : ['requestId', 'scheduleId', 'expectedRevision'], properties: {
        requestId: uuid, ...(operation !== 'create' ? { scheduleId: uuid, expectedRevision: { type: 'integer', minimum: 1 } } : {}),
        ...(operation !== 'revoke' ? { settings: settingsSchema } : {}) } };
export const SCHEDULE_TOOLS = Object.freeze(Object.entries(operations).map(([name, operation]) => Object.freeze({ name,
  description: descriptions[operation] ?? mutationDescription(operation), inputSchema: inputSchema(operation),
  annotations: { readOnlyHint: ['list', 'issues'].includes(operation), destructiveHint: operation === 'revoke', idempotentHint: true, openWorldHint: false },
})));
