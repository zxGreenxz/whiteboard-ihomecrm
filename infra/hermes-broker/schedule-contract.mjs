// CRM owns this schedule. Native Hermes schedules remain outside this contract.
// Limits reuse the current standing-grant and group-send bounds; timezone and
// catch-up behavior match the existing worker automation scheduler.
export const SCHEDULE_LIMITS = Object.freeze({ days: 30, messagesPerDay: 200, groups: 8, buildings: 20, rooms: 20 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = value => typeof value === 'string' && UUID.test(value);
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new TypeError('invalid_schedule_request'); };
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
  if (value.template !== 'rooms_public_text_v1' || typeof value.timeZone !== 'string' || value.timeZone.length > 100 ||
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
  crm_room_schedule_revoke: 'revoke', crm_room_schedule_list: 'list' });
export const scheduleOperation = name => Object.hasOwn(operations, name) ? operations[name] : undefined;
export function mayUseSchedule(effective, operation) {
  if (operation === 'list') return effective?.read?.includes('chat_zalo.view') === true;
  if (!effective?.action?.includes('chat_zalo.manage_automation')) return false;
  return operation === 'revoke' || ['create', 'update'].includes(operation) && effective.action.includes('chat_zalo.send') &&
    effective.read?.includes('chat_zalo.view') === true && effective.read?.includes('rooms.view') === true;
}
function summary(value) {
  if (!exact(value, ['scheduleId', 'revision', 'state', 'settings', 'createdAt', 'lastRuns']) || !id(value.scheduleId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(value.state) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.lastRuns) || value.lastRuns.length > 200) fail();
  // Historical settings may already be expired; shape validation uses their own
  // grant boundary rather than requiring a future expiry when reading history.
  const expiry = Date.parse(value.settings?.expiresAt);
  const checked = settings(value.settings, expiry - 1);
  const seen = new Set();
  const lastRuns = value.lastRuns.map(run => {
    if (!exact(run, ['date', 'conversationId', 'outcome', 'dispatchId', 'deliveryStatus']) || typeof run.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(run.date) ||
        !id(run.conversationId) || seen.has(run.conversationId) || !['queued', 'no_rooms', 'missed'].includes(run.outcome) ||
        (run.outcome === 'queued' ? !id(run.dispatchId) || !['queued', 'processing', 'sent', 'failed', 'unknown'].includes(run.deliveryStatus) : run.dispatchId !== null || run.deliveryStatus !== null)) fail();
    seen.add(run.conversationId); return { ...run };
  });
  return { scheduleId: value.scheduleId, revision: value.revision, state: value.state, settings: checked, createdAt: value.createdAt, lastRuns };
}
export function scheduleResult(operation, value, _identity, input) {
  if (operation === 'list') {
    if (!exact(value, ['schedules', 'nextCursor']) || !Array.isArray(value.schedules) || value.schedules.length > input.limit || !(value.nextCursor === null || id(value.nextCursor))) fail();
    const schedules = value.schedules.map(summary);
    if (new Set(schedules.map(row => row.scheduleId)).size !== schedules.length) fail();
    if (value.nextCursor !== null && (schedules.length !== input.limit || value.nextCursor !== schedules.at(-1)?.scheduleId)) fail();
    return { schedules, nextCursor: value.nextCursor };
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
  template: { const: 'rooms_public_text_v1' }, buildingIds: { type: 'array', items: uuid, minItems: 1, maxItems: 20, uniqueItems: true },
  conversationIds: { type: 'array', items: uuid, minItems: 1, maxItems: 8, uniqueItems: true },
  weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1, maxItems: 7, uniqueItems: true, description: 'ISO weekday: Monday=1, Sunday=7.' },
  time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }, timeZone: { type: 'string', maxLength: 100, description: 'Explicit IANA timezone; must equal the CRM organization timezone.' },
  maxRooms: { type: 'integer', minimum: 1, maximum: 20 }, maxMessagesPerDay: { type: 'integer', minimum: 1, maximum: 200 },
  expiresAt: { type: 'string', format: 'date-time', description: 'Explicit UTC expiry within 30 days. Ask the user if expiry or any other required schedule detail is missing.' },
} };
export const SCHEDULE_TOOLS = Object.freeze(Object.entries(operations).map(([name, operation]) => Object.freeze({ name,
  description: operation === 'list' ? 'Read CRM room schedules owned by this connection, including revision and last run. CRM remains the only scheduler.' :
    `${operation === 'revoke' ? 'Revoke' : operation === 'update' ? 'Replace the complete scope and settings of' : 'Create'} a CRM room bulletin schedule only for a clear user request. CRM verifies current Read/Action rights and standing grant before each run and provider send. Never create a second native Hermes cron for this CRM job. Reuse requestId on an uncertain outcome; read the schedule before issuing a different mutation. No PIN or per-job approval is required.`,
  inputSchema: { type: 'object', additionalProperties: false, required: operation === 'list' ? [] : operation === 'create' ? ['requestId', 'settings'] :
    operation === 'update' ? ['requestId', 'scheduleId', 'expectedRevision', 'settings'] : ['requestId', 'scheduleId', 'expectedRevision'], properties: operation === 'list' ? { limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 }, cursor: { type: ['string', 'null'], format: 'uuid', description: 'Use nextCursor from the previous page; null starts from the beginning.' } } : {
      requestId: uuid, ...(operation !== 'create' ? { scheduleId: uuid, expectedRevision: { type: 'integer', minimum: 1 } } : {}),
      ...(operation !== 'revoke' ? { settings: settingsSchema } : {}),
    } }, annotations: { readOnlyHint: operation === 'list', destructiveHint: operation === 'revoke', idempotentHint: true, openWorldHint: false },
})));
