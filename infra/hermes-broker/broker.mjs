import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS,TASK_OPTIONS_HINTS,taskActionOperation,taskActionInput,mayUseTaskAction,taskOptionsHint,taskOptionsCompanyWide,taskOptionsRetry } from './task-input-contract.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ROOM_PASS_TOOLS, roomPassOperation, roomPassInput, mayUseRoomPass } from './room-pass-contract.mjs';
import { DOMAIN_TOOLS, CACHED_READ_OPERATIONS, FAST_READ_OPERATIONS, domainOperation, domainInput, mayUseDomain, splitReadNames } from './domain-contract.mjs';
import { SCHEDULE_TOOLS, scheduleOperation, scheduleInput, mayUseSchedule } from './schedule-contract.mjs';
import { ZALO_BROADCAST_TOOLS, zaloBroadcastOperation, zaloBroadcastInput, mayUseZaloBroadcast } from './zalo-broadcast-contract.mjs';
import { WORK_MEMORY_TOOLS, workMemoryOperation, workMemoryInput, mayUseWorkMemory } from './work-memory-contract.mjs';
import { CUSTOMER_ACTION_TOOLS, customerActionOperation, customerActionInput, mayUseCustomerAction } from './customer-action-contract.mjs';
import { EXPENSE_ACTION_TOOLS, expenseActionOperation, expenseActionInput, mayUseExpenseAction } from './expense-action-contract.mjs';
import { MemoryAssistantStore, MemoryConnectionStore, MemorySessionStore } from './stores.mjs';
import { groupPreviewIntent, groupPreviewResponse, groupSendResponse,
  GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL } from './group-preview-mount.mjs';
import { mayUseGroupTool } from './capability-contract.mjs';
import { EXTERNAL_GROUP_TOOLS, externalGroupOperation, externalGroupInput } from './external-group-mount.mjs';
import { advanceAuthorityRequest, BROKER_AUTHORITY, runAuthorityRequest } from './authority-request-scope.mjs';
import { NEW_REQUEST_ID_TOOL, startsCrmRequest } from './request-id-contract.mjs';
import { advertisedTool, normalizeToolArguments } from './tool-argument-shape.mjs';
import { readMisuseHint } from './read-misuse-hints.mjs';
import { createPublicTextGuard, splitConfirmToken } from './public-text-guard.mjs';
import { ACTION_REASONS, ACTION_REJECT_REASONS } from './action-reasons.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const CONTEXT_PERMISSION = 'assistant.context.read';
const TOOL = Object.freeze({
  name: 'crm_auth_context',
  // B5d (21/10): also the company name and the buildings (id, name, code) of the widest read scope, so one call
  // gives the names the read tools accept as buildingName.
  description: 'Read the verified identity, effective assistant permissions, company name and the buildings (id, name, code) this connection may read.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const ROOM_PERMISSION = 'rooms.view';
const ROOM_TOOL = Object.freeze({
  name: 'crm_available_rooms',
  // R2b C1 (21/10/2026, audit L33 + câu 10/49/54/56/76): mô tả tiếng Anh 600 B → tiếng Việt gọn, nói rõ đây là trang Sale
  // công khai chứ không phải trạng thái CRM, rồi chỉ sang tool đúng cho phòng trống thật / sắp trống / một phòng cụ thể.
  // Câu đầu ≤ 60 ký tự vì danh sách tool_search của Hermes chỉ hiện câu đầu cắt còn 60 ký tự; "price" giữ chữ tiếng Anh mà
  // chỉ mục BM25 (token ASCII) của bản cũ có cho truy vấn "available rooms … price". Bù byte cho các mô tả định tuyến mới
  // (tools/list ≤ 64 000 B, đo ở tool-argument-shape.test.mjs).
  description: 'Trang Sale công khai: phòng rao (trống/sắp trống/pass), giá (price). Kèm ngày trống, nội thất, chính sách, liên hệ; không phải trạng thái CRM. Phòng trống thật: crm_read_occupancy (số), crm_read_report re_vacant_rooms (danh sách); sắp trống N ngày: crm_read_occupancy_report upcoming; một phòng (ai ở, trống): crm_room_lookup. listing=no_sale_page: chưa có link Sale, không phải hết phòng.',
  inputSchema: { type: 'object', properties: {
    buildingName: { type: 'string', maxLength: 120 },
    offset: { type: 'integer', minimum: 0, maximum: 2000, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
// Original definitions by name: tools/list advertises advertisedTool(tool) and
// tools/call shapes arguments against the original before any validator. Built
// per broker, not at module load: external-group-mount imports this module back.
function toolDefinitions() {
  const tools = [TOOL, ROOM_TOOL, ...TASK_TOOLS, ...TASK_INPUT_TOOLS, ...ROOM_PASS_TOOLS, ...CUSTOMER_ACTION_TOOLS,
    ...EXPENSE_ACTION_TOOLS, ...DOMAIN_TOOLS, ...SCHEDULE_TOOLS, ...ZALO_BROADCAST_TOOLS, ...WORK_MEMORY_TOOLS, ...EXTERNAL_GROUP_TOOLS, NEW_REQUEST_ID_TOOL];
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  if (byName.size !== tools.length) throw new TypeError('ambiguous_tool_definition');
  return byName;
}
// tools/list is the connector's own catalogue, static per grant set, not CRM
// data. It has its own ceiling: one over the tools/call data cap would cost the
// connection every tool at once (response_too_large on the listing).
export const TOOLS_LIST_MAX_BYTES = 196_608;
// Per-connection admission. Both rates are sliding 60-second windows; tools/call
// also counts against the request rate. timeoutMs bounds one whole invocation
// (identify -> authority -> handler -> audit -> final check -> finalize).
// maxResultBytes caps every response except tools/list (maxToolsListBytes).
const DEFAULT_LIMITS = Object.freeze({
  tokenLifetimeMs: 15 * 60_000,
  maxRequestsPerMinute: 60,
  maxToolCallsPerMinute: 60,
  maxConcurrentCalls: 2,
  timeoutMs: 10_000,
  maxResultBytes: 16_384,
  maxToolsListBytes: TOOLS_LIST_MAX_BYTES,
});
const RATE_WINDOW_MS = 60_000;
// Every code here can be audited as a denied/timeout tools/call event (recordAudit in invoke), so the host audit
// protocol must accept all of them: infra/hermes-runtime/audit-codes.test.mjs pins ERROR_STATUS ⊆ AUDIT_CODES
// (21/10 production: read_name_unresolved missing there became backend_unavailable for every unresolved name).
export const ERROR_STATUS = Object.freeze({
  unauthorized: 401, forbidden: 403, context_changed: 409, invalid_request: 400,
  // B5d: buildingName/roomName the directory in scope could not resolve (0 or ambiguous); `detail` names only
  // the model's own string and buildings/rooms the asker's RLS already lists (mcp-http forwards it).
  read_name_unresolved: 400,
  group_recipient_limit: 400, group_room_limit: 400,
  tool_not_available: 403, rate_limited: 429, busy: 429, timeout: 504, confirmation_invalid: 400,
  backend_unavailable: 503, response_too_large: 502, result_too_large: 413, send_outcome_unknown: 503, memory_outcome_unknown: 503, schedule_outcome_unknown: 503, room_pass_outcome_unknown: 503, task_outcome_unknown: 503,
  customer_outcome_unknown: 503, expense_outcome_unknown: 503, zalo_broadcast_outcome_unknown: 503,
  // Đợt 1 nền chung thao tác ghi (crm_action_*): lỗi thật (quyền/nghiệp vụ) mang `reason` của danh sách đóng
  // action-reasons.mjs (dạng rejected) + `detail` = câu tĩnh của mã đó; thiếu/mơ hồ đầu vào KHÔNG là lỗi (needs_input).
  action_rejected: 400, action_outcome_unknown: 503,
});
// Write uncertainty codes. Each carries the caller's stable requestId so the
// model reconciles with the matching *_status tool instead of creating again.
const MUTATION_UNKNOWN = Object.freeze(['memory_outcome_unknown', 'schedule_outcome_unknown', 'room_pass_outcome_unknown',
  'task_outcome_unknown', 'customer_outcome_unknown', 'expense_outcome_unknown', 'zalo_broadcast_outcome_unknown', 'action_outcome_unknown']);
export const REQUEST_RECEIPT_UNKNOWN = Object.freeze(['room_pass_outcome_unknown', 'task_outcome_unknown', 'customer_outcome_unknown',
  'expense_outcome_unknown', 'zalo_broadcast_outcome_unknown', 'action_outcome_unknown']);
// Cutover P6.06: the CRM automation "Gửi ảnh phòng trống" is the one scheduler for
// vacant-room sends (crm_zalo_broadcast_*). Hermes' own text schedules stay
// readable/revocable for existing rows but can no longer be created or replaced.
const RETIRED_SCHEDULE_OPERATIONS = Object.freeze(['create', 'update']);

export class BrokerError extends Error {
  constructor(code) {
    super(Object.hasOwn(ERROR_STATUS, code) ? code : 'backend_unavailable');
    this.name = 'BrokerError';
    this.code = this.message;
    this.status = ERROR_STATUS[this.code];
  }
}

/** Lỗi thật của thao tác ghi: reason ngoài danh sách đóng hoặc không phải dạng rejected ⇒ crm_refused. */
export function actionRejected(code) {
  const error = new BrokerError('action_rejected');
  error.reason = ACTION_REJECT_REASONS.includes(code) ? code : 'crm_refused';
  error.detail = ACTION_REASONS[error.reason].text;
  return error;
}

const fail = (code) => { throw new BrokerError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => `hc_${randomBytes(32).toString('base64url')}`;
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const validId = (value) => typeof value === 'string' && UUID.test(value);
const record = (value) => object(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactRecord = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const canonicalId = (value) => validId(value) && value === value.toLowerCase();
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const dataRecord = value => record(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
  Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exactData = (value, keys) => dataRecord(value) && exactRecord(value, keys);

function roomFilters(value) {
  if (!dataRecord(value) || Object.keys(value).some(key => !['buildingName', 'offset', 'limit'].includes(key))) fail('invalid_request');
  const { buildingName = '', offset = 0, limit = 50 } = value;
  if (typeof buildingName !== 'string' || buildingName.length > 120 || !Number.isInteger(offset) || offset < 0 || offset > 2000 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_request');
  return Object.freeze({ buildingName, offset, limit });
}

// Legacy: the whole published page is read (≤2000 rows) and sliced here. Page: one
// SQL page with the exact filtered total; the tool can still only page to offset 2000.
const ROOM_SOURCES = Object.freeze({ hermes_sale_listing_rooms_v1: 2000, hermes_available_rooms_page_v1: 10_000_000 });
const ROOM_MAX_OFFSET = 2000;
// Protocol validation only. Sale facts and authorization are owned by the shared
// room service/projection. Never serialize extra fields from a dependency.
function roomResult(value, request, identity) {
  const text = (value, cap, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= cap);
  const amount = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  const day = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
  const next = request.offset + request.limit;
  if (!exactData(value, ['source', 'readAt', 'currency', 'completeness', 'listing', 'notice', 'publishedPages', 'totalInSnapshot', 'offset', 'nextOffset',
    'salePolicies', 'buildings', 'rooms']) ||
      !Object.hasOwn(ROOM_SOURCES, value.source) || value.currency !== 'VND' ||
      value.listing !== (value.publishedPages > 0 ? 'published' : 'no_sale_page') ||
      (value.listing === 'published' ? value.notice !== null : !text(value.notice, 600) || value.totalInSnapshot !== 0) ||
      !['complete', 'source_capped'].includes(value.completeness) || typeof value.readAt !== 'string' ||
      // The page source knows its exact total: capped means (and only means) deeper than the tool can page.
      (value.source === 'hermes_available_rooms_page_v1' && value.completeness !== (value.totalInSnapshot > ROOM_MAX_OFFSET ? 'source_capped' : 'complete')) ||
      !Number.isFinite(Date.parse(value.readAt)) || new Date(value.readAt).toISOString() !== value.readAt ||
      !Number.isSafeInteger(value.publishedPages) || value.publishedPages < 0 || value.publishedPages > 1000 ||
      !Number.isInteger(value.totalInSnapshot) || value.totalInSnapshot < 0 || value.totalInSnapshot > ROOM_SOURCES[value.source] ||
      value.offset !== request.offset || value.nextOffset !== (next < value.totalInSnapshot && next <= ROOM_MAX_OFFSET ? next : null) ||
      !Array.isArray(value.salePolicies) || value.salePolicies.length > 50 || !value.salePolicies.every(policy => text(policy, 2000)) ||
      !Array.isArray(value.buildings) || value.buildings.length > 100 ||
      !Array.isArray(value.rooms) || value.rooms.length !== Math.min(request.limit, Math.max(0, value.totalInSnapshot - request.offset))) fail('backend_unavailable');
  const seen = new Set(), buildings = identity.scopesByPermission[ROOM_PERMISSION].buildingIds, listed = new Set();
  for (const building of value.buildings) {
    if (!exactData(building, ['id', 'name', 'code', 'address', 'contact']) || !canonicalId(building.id) || listed.has(building.id) ||
        !buildings.includes(building.id) || !text(building.name, 500) || !text(building.code, 256, true) || !text(building.address, 1000, true) ||
        !exactData(building.contact, ['name', 'phone']) || !text(building.contact.name, 256, true) || !text(building.contact.phone, 256, true)) fail('backend_unavailable');
    listed.add(building.id);
  }
  for (const room of value.rooms) {
    if (!exactData(room, ['id', 'code', 'name', 'building', 'floor', 'areaM2', 'priceVnd', 'rentVnd', 'depositVnd', 'status', 'availability',
      'statusLines', 'roomType', 'amenities', 'salePolicy']) ||
        !canonicalId(room.id) || seen.has(room.id) || !text(room.code, 256, true) || !text(room.name, 500) ||
        !exactData(room.building, ['id', 'name', 'code']) || !canonicalId(room.building.id) || !buildings.includes(room.building.id) || !listed.has(room.building.id) ||
        !text(room.building.name, 500) || !room.building.name.toLowerCase().includes(request.buildingName.toLowerCase()) || !text(room.building.code, 256, true) ||
        !(room.floor === null || (Number.isInteger(room.floor) && room.floor >= -100 && room.floor <= 1000)) ||
        ![room.areaM2, room.priceVnd, room.rentVnd, room.depositVnd].every(amount) || !['free', 'soon', 'pass'].includes(room.status) ||
        !exactData(room.availability, ['kind', 'label', 'availableOn']) ||
        !['ready', 'notice', 'confirm_notice', 'preparing', 'pass'].includes(room.availability.kind) ||
        (room.status === 'pass') !== (room.availability.kind === 'pass') ||
        !text(room.availability.label, 600) || !day(room.availability.availableOn) ||
        !Array.isArray(room.statusLines) || room.statusLines.length < 1 || room.statusLines.length > 4 || !room.statusLines.every(line => text(line, 600)) ||
        ![room.roomType, room.amenities, room.salePolicy].every(value => text(value, 600, true))) fail('backend_unavailable');
    seen.add(room.id);
  }
  return { content: [{ type: 'text', text: JSON.stringify(structuredClone(value)) }], isError: false };
}

function authorityList(value, predicate) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some((item) => !predicate(item)) ||
      new Set(value).size !== value.length) fail('backend_unavailable');
}

function authorityPermissions(value) {
  if (!exactRecord(value, ['read', 'action'])) fail('backend_unavailable');
  for (const kind of ['read', 'action']) authorityList(value[kind], (key) => typeof key === 'string' && KEY.test(key));
}

// The injected authority is a trusted backend dependency. Still validate its
// complete result before any handler or audit sees it, and detach the projection
// from its branded comparison receipt. Credential fields are never accepted here.
function authorityIdentity(value, now) {
  if (!exactRecord(value, ['row', 'effective', 'policyEpoch', 'isSuperadmin', 'assistantScopeIds', 'scopesByPermission', 'contextVersion']) ||
      !exactRecord(value.row, ['id', 'assistantId', 'userId', 'organizationId', 'expiresAt', 'epoch', 'state', 'restrictions']) ||
      ['id', 'assistantId', 'userId', 'organizationId'].some((key) => !canonicalId(value.row[key])) ||
      value.row.state !== 'active' || !positive(value.row.epoch) || !positive(value.row.expiresAt) ||
      typeof value.isSuperadmin !== 'boolean' ||
      ![value.policyEpoch, value.contextVersion].every((version) => typeof version === 'string' && /^[a-f0-9]{64}$/.test(version))) {
    fail('backend_unavailable');
  }
  if (value.row.expiresAt <= now) fail('unauthorized');
  authorityPermissions(value.row.restrictions); authorityPermissions(value.effective);
  for (const kind of ['read', 'action']) {
    if (value.effective[kind].some((key) => !value.row.restrictions[kind].includes(key))) fail('backend_unavailable');
  }
  authorityList(value.assistantScopeIds, canonicalId);
  const scopes = value.scopesByPermission;
  if (!record(scopes) || Object.keys(scopes).length > 256 ||
      [...value.effective.read, ...value.effective.action].some((key) => !Object.hasOwn(scopes, key))) fail('backend_unavailable');
  for (const [key, scope] of Object.entries(scopes)) {
    if (!KEY.test(key) || !exactRecord(scope, ['buildingIds', 'cashbookIds'])) fail('backend_unavailable');
    authorityList(scope.buildingIds, canonicalId); authorityList(scope.cashbookIds, canonicalId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 131_072) fail('backend_unavailable');
  return structuredClone(value);
}

function permissions(value, error = 'invalid_request') {
  if (!exactKeys(value, ['read', 'action'])) fail(error);
  const result = {};
  for (const kind of ['read', 'action']) {
    if (!Array.isArray(value[kind]) || value[kind].length > 256 ||
        value[kind].some((key) => typeof key !== 'string' || !KEY.test(key))) fail(error);
    result[kind] = [...new Set(value[kind])].sort();
  }
  return result;
}

function effectivePermissions(current, ceiling, restriction) {
  return Object.fromEntries(['read', 'action'].map((kind) => [kind,
    current[kind].filter((key) => ceiling[kind].includes(key) && restriction[kind].includes(key)),
  ]));
}

function safeConnection(row) {
  return {
    id: row.id, assistantId: row.assistantId, userId: row.userId,
    organizationId: row.organizationId, expiresAt: row.expiresAt,
    epoch: row.epoch, state: row.state, restrictions: structuredClone(row.restrictions),
  };
}

function validSession(value, now) {
  if (!object(value) || !validId(value.userId) || typeof value.sessionId !== 'string' ||
      value.sessionId.length < 1 || value.sessionId.length > 256 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) fail('unauthorized');
  return { userId: value.userId, sessionId: value.sessionId, expiresAt: value.expiresAt };
}

function validAuthorization(value, userId, organizationId, now) {
  if (!object(value) || value.userId !== userId || typeof value.isSuperadmin !== 'boolean' ||
      typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256 ||
      !Array.isArray(value.activeOrganizationIds) || value.activeOrganizationIds.some((id) => !validId(id))) {
    fail('forbidden');
  }
  const organizations = [...new Set(value.activeOrganizationIds)];
  // Ordinary users have exactly one company. A directory entry alone is never authority.
  if (!value.isSuperadmin && (organizations.length !== 1 || organizations[0] !== organizationId)) fail('forbidden');
  const member = value.membership;
  if (!object(member) || member.organizationId !== organizationId || member.status !== 'ACTIVE' ||
      member.revokedAt !== null ||
      !(member.validFrom === null || (Number.isSafeInteger(member.validFrom) && member.validFrom <= now)) ||
      !(member.validTo === null || (Number.isSafeInteger(member.validTo) && member.validTo > now))) fail('forbidden');
  return {
    isSuperadmin: value.isSuperadmin, epoch: value.epoch,
    permissions: permissions(value.permissions, 'forbidden'),
    companyCeilings: permissions(value.companyCeilings, 'forbidden'),
  };
}

/**
 * All adapters are trusted backend dependencies, never MCP arguments.
 * auth.verifySession({accessToken, signal}) -> {userId, sessionId, expiresAt: epochMs}
 * auth.readAuthorization({accessToken,userId,organizationId,signal}) -> current server
 * {userId,isSuperadmin,activeOrganizationIds,membership,epoch,permissions,companyCeilings}.
 * The adapter must independently verify current CRM authority, not echo client claims.
 * No service-role, raw RPC forwarding, password input, token minting, or refresh exists here.
 * Alternatively inject authority.{identifyConnection,resolve,checkUnchanged}.
 * identifyConnection binds the opaque token to a current connection id before
 * per-connection admission; resolve supplies the branded authority receipt.
 * This mode disables all P1 control-plane methods and never falls back to memory.
 * crm_available_rooms additionally requires an explicitly injected room service
 * and nonempty rooms.view + assistant scopes. No generic RPC route is exposed.
 */
export function createBroker({
  auth,
  authority,
  roomReads,
  groupPreviews,
  externalGroups,
  workMemory,
  schedules,
  zaloBroadcasts,
  domains,
  roomPass,
  tasks,
  customers,
  expenses,
  actions,
  dependencyScope,
  clock = Date.now,
  limits: suppliedLimits = {},
  sessionStore,
  connectionStore,
  assistantStore,
  audit,
  observe,
  callLog,
} = {}) {
  if (observe !== undefined && typeof observe !== 'function') throw new TypeError('invalid_observer');
  if (callLog !== undefined && typeof callLog !== 'function') throw new TypeError('invalid_call_log');
  const definitions = toolDefinitions();
  let injectedAuthority;
  if (authority !== undefined) {
    if (!authority || ['identifyConnection', 'resolve', 'checkUnchanged'].some((key) => typeof authority[key] !== 'function')) {
      throw new TypeError('trusted_authority_adapter_required');
    }
    // Capture one adapter instance, including its comparison-receipt brand.
    injectedAuthority = Object.fromEntries(['identifyConnection', 'resolve', 'checkUnchanged']
      .map((key) => [key, authority[key].bind(authority)]));
  } else {
    if (typeof auth?.verifySession !== 'function' || typeof auth?.readAuthorization !== 'function') {
      throw new TypeError('trusted_auth_adapter_required');
    }
    sessionStore ??= new MemorySessionStore();
    connectionStore ??= new MemoryConnectionStore();
    assistantStore ??= new MemoryAssistantStore();
  }
  let task;
  if (tasks !== undefined) {
    if (!injectedAuthority || ['prepareTask', 'finalizeTask'].some(key => typeof tasks?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_task_service_required');
    task = Object.fromEntries(['prepareTask', 'finalizeTask'].map(key => [key, tasks[key].bind(tasks)]));
  }
  let pass;
  if (roomPass !== undefined) {
    if (!injectedAuthority || ['prepareRoomPass', 'finalizeRoomPass'].some(key => typeof roomPass?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_room_pass_service_required');
    pass = Object.fromEntries(['prepareRoomPass', 'finalizeRoomPass'].map(key => [key, roomPass[key].bind(roomPass)]));
  }
  let customer;
  if (customers !== undefined) {
    if (!injectedAuthority || ['prepareCustomerAction', 'finalizeCustomerAction'].some(key => typeof customers?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_customer_action_service_required');
    customer = Object.fromEntries(['prepareCustomerAction', 'finalizeCustomerAction'].map(key => [key, customers[key].bind(customers)]));
  }
  let expense;
  if (expenses !== undefined) {
    if (!injectedAuthority || ['prepareExpenseAction', 'finalizeExpenseAction'].some(key => typeof expenses?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_expense_action_service_required');
    expense = Object.fromEntries(['prepareExpenseAction', 'finalizeExpenseAction'].map(key => [key, expenses[key].bind(expenses)]));
  }
  // Đợt 1 nền chung: họ thao tác ghi dùng chung (crm_action_*), lõi ở action-runtime.mjs; broker chỉ móc định nghĩa,
  // danh sách tool và một nhánh callTool. Danh mục rỗng hay kết nối không giữ khoá thao tác nào ⇒ không hiện tool nào.
  let action;
  if (actions !== undefined) {
    if (!injectedAuthority || !Array.isArray(actions?.definitions) || ['listed', 'route', 'begin', 'handle', 'finish', 'context'].some(key => typeof actions?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_action_runtime_required');
    for (const tool of actions.definitions) {
      if (definitions.has(tool.name)) throw new TypeError('ambiguous_tool_definition');
      definitions.set(tool.name, tool);
    }
    action = actions;
  }
  let domain;
  if (domains !== undefined) {
    if (!injectedAuthority || ['prepareDomain', 'finalizeDomain'].some(key => typeof domains?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_domain_service_required');
    domain = Object.fromEntries(['prepareDomain', 'finalizeDomain'].map(key => [key, domains[key].bind(domains)]));
    if (domains.readAuthority !== undefined) {
      // The mount and this dispatcher must agree on both opt-in lanes (fast plan, cached admission).
      const sameSet = (value, expected) => Array.isArray(value) && value.length === expected.length && expected.every(op => value.includes(op));
      if (['identifyConnection', 'resolve', 'checkUnchanged'].some(key => typeof domains.readAuthority?.[key] !== 'function') ||
          !sameSet(domains.fastReadOperations, FAST_READ_OPERATIONS) ||
          !sameSet(domains.cachedReadOperations, CACHED_READ_OPERATIONS)) throw new TypeError('trusted_domain_service_required');
      domain.readAuthority = domains.readAuthority;
    }
    // B5d: optional directory port for crm_auth_context (company name + buildings in scope). Both or neither.
    if (domains.prepareContext !== undefined || domains.finalizeContext !== undefined) {
      if (['prepareContext', 'finalizeContext'].some(key => typeof domains[key] !== 'function')) throw new TypeError('trusted_domain_service_required');
      domain.prepareContext = domains.prepareContext.bind(domains); domain.finalizeContext = domains.finalizeContext.bind(domains);
    }
  }
  let schedule;
  if (schedules !== undefined) {
    if (!injectedAuthority || ['prepareSchedule', 'finalizeSchedule'].some(key => typeof schedules?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_schedule_service_required');
    schedule = Object.fromEntries(['prepareSchedule', 'finalizeSchedule'].map(key => [key, schedules[key].bind(schedules)]));
  }
  let broadcast;
  if (zaloBroadcasts !== undefined) {
    if (!injectedAuthority || ['prepareZaloBroadcast', 'finalizeZaloBroadcast'].some(key => typeof zaloBroadcasts?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_zalo_broadcast_service_required');
    broadcast = Object.fromEntries(['prepareZaloBroadcast', 'finalizeZaloBroadcast'].map(key => [key, zaloBroadcasts[key].bind(zaloBroadcasts)]));
  }
  let memory;
  if (workMemory !== undefined) {
    if (!injectedAuthority || ['prepareMemory', 'finalizeMemory'].some(key => typeof workMemory?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('trusted_work_memory_service_required');
    memory = Object.fromEntries(['prepareMemory', 'finalizeMemory'].map(key => [key, workMemory[key].bind(workMemory)]));
  }
  let rooms;
  if (roomReads !== undefined) {
    if (!injectedAuthority || !roomReads || ['prepareAvailableRooms', 'finalizeAvailableRooms'].some(key => typeof roomReads[key] !== 'function')) {
      throw new TypeError('trusted_durable_room_service_required');
    }
    rooms = Object.fromEntries(['prepareAvailableRooms', 'finalizeAvailableRooms'].map(key => [key, roomReads[key].bind(roomReads)]));
  }
  // Trusted host composition only. This port never appears in MCP callTool.
  // Its authority uses the same persisted store/session/permission intersection.
  let groups;
  if (groupPreviews !== undefined) {
    if (!injectedAuthority || !exactData(groupPreviews, ['authority', 'createService']) ||
        typeof groupPreviews.createService !== 'function' ||
        ['identifyConnection', 'resolve', 'checkUnchanged'].some(key => typeof groupPreviews.authority?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') {
      throw new TypeError('trusted_group_preview_composition_required');
    }
    groups = { createService: groupPreviews.createService.bind(groupPreviews),
      authority: Object.fromEntries(['identifyConnection', 'resolve', 'checkUnchanged']
        .map(key => [key, groupPreviews.authority[key].bind(groupPreviews.authority)])) };
  }
  let external;
  if (externalGroups !== undefined) {
    if (!injectedAuthority || !exactData(externalGroups, ['authority', 'createService']) ||
        typeof externalGroups.createService !== 'function' ||
        ['identifyConnection', 'resolve', 'checkUnchanged'].some(key => typeof externalGroups.authority?.[key] !== 'function') ||
        typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') {
      throw new TypeError('trusted_external_group_composition_required');
    }
    external = { createService: externalGroups.createService.bind(externalGroups),
      authority: Object.fromEntries(['identifyConnection', 'resolve', 'checkUnchanged']
        .map(key => [key, externalGroups.authority[key].bind(externalGroups.authority)])) };
  }
  if (dependencyScope !== undefined && ['begin', 'track'].some(key => typeof dependencyScope?.[key] !== 'function')) {
    throw new TypeError('invalid_dependency_scope');
  }
  const mayReadRooms = identity => Boolean(rooms && identity.effective.read.includes(ROOM_PERMISSION) &&
    identity.assistantScopeIds.length && identity.scopesByPermission[ROOM_PERMISSION]?.buildingIds.length);
  // Host opt-in (readFastPath): the fixed private plan ('fast') and the cached
  // catalog admission ('cached', B2-2) both read current authority inside their
  // business RPC, so the second authority build is skipped and the read catalog
  // supplies the identity. Every other domain (zalo_conversations) and a host
  // without the opt-in keep the full authority and post-audit check unchanged.
  const domainReadContext = operation => {
    if (!domain?.readAuthority) return {};
    const path = FAST_READ_OPERATIONS.includes(operation) ? 'fast' : CACHED_READ_OPERATIONS.includes(operation) ? 'cached' : null;
    return path === null ? {} : { authority: domain.readAuthority, initialDomainReadAdmission: true, domainReadPath: path };
  };
  // Shared definitions (not copies) of every tool this identity may call now.
  const grantedTools = identity => [
    ...(identity.effective.read.includes(CONTEXT_PERMISSION) ? [TOOL] : []),
    ...(mayReadRooms(identity) ? [ROOM_TOOL] : []),
    ...(task ? [...TASK_TOOLS,...TASK_INPUT_TOOLS].filter(tool => mayUseTaskAction(identity.effective, taskActionOperation(tool.name))) : []),
    ...(pass ? ROOM_PASS_TOOLS.filter(tool => mayUseRoomPass(identity.effective, roomPassOperation(tool.name))) : []),
    ...(customer ? CUSTOMER_ACTION_TOOLS.filter(tool => mayUseCustomerAction(identity.effective, customerActionOperation(tool.name))) : []),
    ...(expense ? EXPENSE_ACTION_TOOLS.filter(tool => mayUseExpenseAction(identity.effective, expenseActionOperation(tool.name))) : []),
    ...(action ? action.listed(identity.effective) : []),
    ...(domain ? DOMAIN_TOOLS.filter(tool => mayUseDomain(identity.effective, domainOperation(tool.name))) : []),
    ...(schedule ? SCHEDULE_TOOLS.filter(tool => !RETIRED_SCHEDULE_OPERATIONS.includes(scheduleOperation(tool.name)) &&
      mayUseSchedule(identity.effective, scheduleOperation(tool.name))) : []),
    ...(broadcast ? ZALO_BROADCAST_TOOLS.filter(tool => mayUseZaloBroadcast(identity.effective, zaloBroadcastOperation(tool.name))) : []),
    ...(memory ? WORK_MEMORY_TOOLS.filter(tool => mayUseWorkMemory(identity.effective, workMemoryOperation(tool.name))) : []),
    ...(external ? EXTERNAL_GROUP_TOOLS.filter(tool => {
      const operation = externalGroupOperation(tool.name);
      return mayUseGroupTool(identity.effective, operation) &&
        (!['preview', 'send'].includes(operation) || mayReadRooms(identity));
    }) : []),
  ];
  // crm_new_request_id follows the listing itself: it exists exactly while at
  // least one granted action starts a new requestId command.
  const mayIssueRequestId = identity => grantedTools(identity).some(startsCrmRequest);
  if (!exactKeys(suppliedLimits, Object.keys(DEFAULT_LIMITS))) throw new TypeError('invalid_limits');
  const limits = { ...DEFAULT_LIMITS, ...suppliedLimits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid_limits');
  }
  if (limits.tokenLifetimeMs > DEFAULT_LIMITS.tokenLifetimeMs || limits.timeoutMs > 30_000 ||
      limits.maxResultBytes > 65_536 || limits.maxToolsListBytes > TOOLS_LIST_MAX_BYTES) throw new TypeError('unsafe_limits');
  const usage = new Map();
  // Rào chữ công khai: chữ tự do mới ra bề mặt công khai luôn qua xác nhận hai bước (public-text-guard.mjs).
  const publicText = createPublicTextGuard({ clock });
  const receipts = [];
  const writeAudit = audit ?? (async (event) => {
    receipts.push(structuredClone(event));
    if (receipts.length > 1000) receipts.shift();
  });
  if (typeof writeAudit !== 'function') throw new TypeError('invalid_audit_adapter');

  const recordAudit = event => dependencyScope ? dependencyScope.track(() => writeAudit(event)) : writeAudit(event);
  async function bounded(operation, externalSignal) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) fail('invalid_request');
    if (externalSignal?.aborted) fail('timeout');
    const controller = new AbortController();
    let timer, stop;
    const interrupted = new Promise((_, reject) => {
      stop = () => { controller.abort(); reject(new BrokerError('timeout')); };
      externalSignal?.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([
        operation(controller.signal),
        interrupted,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BrokerError('timeout'));
          }, limits.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError('backend_unavailable');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', stop);
      controller.abort();
    }
  }

  async function resolveIdentity(accessToken, organizationId, signal) {
    const session = validSession(await auth.verifySession({ accessToken, signal }), clock());
    if (signal.aborted) fail('timeout');
    const authorization = validAuthorization(await auth.readAuthorization({
      accessToken, userId: session.userId, organizationId, signal,
    }), session.userId, organizationId, clock());
    if (signal.aborted) fail('timeout');
    return { session, authorization };
  }

  async function authorize(presentedToken, signal) {
    if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
    const digest = hash(presentedToken);
    const row = await connectionStore.getByDigest(digest);
    if (!row || row.state !== 'active' || row.expiresAt <= clock()) fail('unauthorized');
    const credential = await sessionStore.get(row.credentialRef);
    if (!credential || credential.expiresAt <= clock()) fail('unauthorized');
    const current = await resolveIdentity(credential.accessToken, row.organizationId, signal);
    if (current.session.userId !== row.userId || current.session.sessionId !== credential.sessionId ||
        current.session.userId !== credential.userId) fail('unauthorized');
    const latest = await connectionStore.get(row.id);
    // Recheck after awaited identity calls; a revoke/rotation may have raced them.
    if (!latest || latest.state !== 'active' || latest.expiresAt <= clock() || latest.tokenDigest !== digest) fail('unauthorized');
    if (latest.epoch !== row.epoch) fail('context_changed');
    const effective = effectivePermissions(current.authorization.permissions,
      current.authorization.companyCeilings, row.restrictions);
    return { row, effective, policyEpoch: current.authorization.epoch,
      isSuperadmin: current.authorization.isSuperadmin,
      contextVersion: hash(JSON.stringify({ connectionEpoch: row.epoch,
        authorizationEpoch: current.authorization.epoch, isSuperadmin: current.authorization.isSuperadmin, effective })) };
  }

  async function checkUnchanged(presentedToken, before, signal) {
    const after = await authorize(presentedToken, signal);
    if (after.row.id !== before.row.id || after.row.epoch !== before.row.epoch ||
        after.policyEpoch !== before.policyEpoch || after.isSuperadmin !== before.isSuperadmin ||
        JSON.stringify(after.effective) !== JSON.stringify(before.effective)) fail('context_changed');
  }

  // Sliding windows: an admitted call stays counted for exactly 60 seconds, so
  // a burst at a fixed-window boundary cannot double the rate. Rejected calls
  // are not counted. retryAfterMs is when the oldest counted call leaves.
  function enter(id, operation) {
    const now = clock();
    // |now - time| keeps a clock step backwards from pinning calls indefinitely.
    const counted = time => Math.abs(now - time) < RATE_WINDOW_MS;
    let entry = usage.get(id);
    if (!entry) {
      if (usage.size >= 4096) {
        for (const [key, value] of usage) if (!value.active && !value.requests.some(counted)) usage.delete(key);
      }
      entry = { requests: [], toolCalls: [], active: 0 }; usage.set(id, entry);
    }
    entry.requests = entry.requests.filter(counted); entry.toolCalls = entry.toolCalls.filter(counted);
    if (entry.active >= limits.maxConcurrentCalls) { const error = new BrokerError('busy'); error.retryAfterMs = 1000; throw error; }
    const limited = (list, max) => {
      if (list.length < max) return;
      const error = new BrokerError('rate_limited');
      error.retryAfterMs = Math.min(RATE_WINDOW_MS, Math.max(1000, Math.min(...list) + RATE_WINDOW_MS - now));
      throw error;
    };
    limited(entry.requests, limits.maxRequestsPerMinute);
    if (operation === 'tools/call') limited(entry.toolCalls, limits.maxToolCallsPerMinute);
    entry.requests.push(now);
    if (operation === 'tools/call') entry.toolCalls.push(now);
    entry.active += 1;
    return () => { entry.active -= 1; };
  }
  const report = (connectionId, operation, code) => {
    if (!observe || !canonicalId(connectionId)) return;
    try { observe(Object.freeze({ connectionId, operation, ...(code === undefined ? {} : { code }) })); }
    catch { /* Health observation never changes the call outcome. */ }
  };
  // Một dòng tool_call_timing mỗi lần invoke (option callLog): mốc ms từng pha,
  // cỡ kết quả, kết cục. Không tham số, kết quả, token, ID đầy đủ hay dữ liệu
  // khách; tên tool chỉ khi có trong catalogue. Lỗi của sink bị nuốt.
  const OK_RESULT_CODES = Object.freeze(['task_options_hint', 'task_options_legacy']);
  const logCall = (record) => {
    if (!callLog) return;
    try { callLog(record()); } catch { /* Timing log never changes the call outcome. */ }
  };

  async function invoke(presentedToken, operation, handler, finalize, context = {}) {
    let release;
    let identity;
    let comparisonReceipt;
    const requestId = randomUUID();
    const selectedAuthority = context.authority ?? injectedAuthority;
    const maxBytes = operation === 'tools/list' ? limits.maxToolsListBytes : limits.maxResultBytes;
    let connectionId;
    const startedAt = performance.now();
    // Each phase stays null until it has run (or thrown); checkMs is skipped on the initial-admission paths.
    // A phase still pending when the call settles (timeout/abort) reports its elapsed time so far.
    const timing = { identifyMs: null, resolveMs: null, handlerMs: null, auditMs: null, checkMs: null, finalizeMs: null };
    let resultBytes = 0, pending = null;
    const timed = async (phase, step) => {
      const at = performance.now(); pending = { phase, at };
      try { return await step(); } finally { timing[phase] = Math.round(performance.now() - at); if (pending?.phase === phase) pending = null; }
    };
    // One authority request window per invocation; see authority-request-scope.
    const work = () => runAuthorityRequest(async () => { try {
      const result = await bounded(async (signal) => {
        if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
        if (selectedAuthority) {
          const identified = await timed('identifyMs', () => selectedAuthority.identifyConnection(presentedToken, { signal, [BROKER_AUTHORITY]: true }));
          if (!exactRecord(identified, ['connectionId']) || !canonicalId(identified.connectionId)) fail('backend_unavailable');
          connectionId = identified.connectionId;
        } else {
          const cheap = await timed('identifyMs', () => connectionStore.getByDigest(hash(presentedToken)));
          if (!cheap || cheap.state !== 'active' || cheap.expiresAt <= clock()) fail('unauthorized');
          connectionId = cheap.id;
        }
        if (signal.aborted) fail('timeout');
        // The joined identify read precedes admission; expensive Auth/crypto does not.
        release = enter(connectionId, operation);
        if (selectedAuthority) {
          comparisonReceipt = await timed('resolveMs', () => selectedAuthority.resolve(presentedToken, { signal, [BROKER_AUTHORITY]: true }));
          identity = authorityIdentity(comparisonReceipt, clock());
        } else identity = await timed('resolveMs', () => authorize(presentedToken, signal));
        if (signal.aborted) fail('timeout');
        // A token cannot switch actors after reserving another connection's quota.
        if (identity.row.id !== connectionId) fail('context_changed');
        let result = await timed('handlerMs', () => handler(identity, signal));
        if (signal.aborted) fail('timeout');
        if (!finalize && Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('response_too_large');
        // A prepared response still needs its audit receipt before disclosure.
        // Direct room reads and the opt-in domain lanes (fast plan, cached
        // admission: their SQL compares session and binding live) complete on
        // the initial admission; shared group/writer paths retain their
        // post-audit authority check.
        await timed('auditMs', () => recordAudit({ requestId, operation, connectionId: identity.row.id, outcome: 'prepared' }));
        if (!context.initialRoomAdmission && !context.initialDomainReadAdmission) {
          advanceAuthorityRequest();
          await timed('checkMs', async () => {
            if (selectedAuthority) {
              const checked = await selectedAuthority.checkUnchanged(presentedToken, comparisonReceipt, { signal, [BROKER_AUTHORITY]: true });
              if (checked !== undefined) fail('backend_unavailable');
              if (comparisonReceipt.contextVersion !== identity.contextVersion) fail('context_changed');
            } else await checkUnchanged(presentedToken, identity, signal);
          });
        }
        if (signal.aborted) fail('timeout');
        // Finalizers consume private receipts before local result validation.
        if (finalize) result = await timed('finalizeMs', () => finalize(result, identity, signal));
        if (signal.aborted) fail('timeout');
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > maxBytes) fail('response_too_large');
        resultBytes = bytes;
        return result;
      }, context.signal);
      report(identity?.row.id, operation);
      return result;
    } catch (error) {
      const safe = context.mutationUncertain?.() ? new BrokerError(context.mutationCode ?? 'memory_outcome_unknown') : context.sendUncertain?.() ? new BrokerError('send_outcome_unknown') : error instanceof BrokerError ? error : new BrokerError('backend_unavailable');
      const dispatchId = context.sendDispatchId?.();
      if (safe.code === 'send_outcome_unknown' && canonicalId(dispatchId)) safe.dispatchId = dispatchId;
      const mutationRequestId = context.mutationRequestId?.();
      if (REQUEST_RECEIPT_UNKNOWN.includes(safe.code) && canonicalId(mutationRequestId)) safe.requestId = mutationRequestId;
      // A quota/concurrency rejection is attributable to the identified connection.
      report(identity?.row.id ?? connectionId, operation, safe.code);
      // Audit failure is fail-closed. Never return a successful data response without a receipt.
      // D9: lý do của action_rejected vào sổ audit (danh sách đóng; host-ownership.mjs REASONS nhận đúng tập này).
      const reason = safe.code === 'action_rejected' && ACTION_REJECT_REASONS.includes(safe.reason) ? { reason: safe.reason } : {};
      try { await bounded(() => recordAudit({ requestId, operation, connectionId: identity?.row.id ?? null,
        outcome: safe.code === 'timeout' ? 'timeout' : 'denied', code: safe.code, ...reason })); }
      catch (auditError) { if (safe.code !== 'send_outcome_unknown' && !MUTATION_UNKNOWN.includes(safe.code)) throw auditError; }
      throw safe;
    } });
    const settle = (error) => logCall(() => {
      const id = identity?.row.id ?? connectionId;
      if (pending && timing[pending.phase] === null) timing[pending.phase] = Math.round(performance.now() - pending.at);
      return { event: 'tool_call_timing', ts: new Date(clock()).toISOString(), operation,
        tool: operation === 'tools/call' && typeof context.tool === 'string' && definitions.has(context.tool) ? context.tool : null,
        path: context.initialDomainReadAdmission ? context.domainReadPath ?? 'fast' : context.initialRoomAdmission ? 'room' : 'normal',
        ...timing, totalMs: Math.round(performance.now() - startedAt), resultBytes: error ? 0 : resultBytes,
        // An ordinary result that only carries guidance (crm_task_input_options hint) keeps outcome 'ok' and names
        // itself with one fixed code, so misuse stays countable in the journal (OK_RESULT_CODES).
        outcome: error ? 'error' : 'ok', code: error ? (error instanceof BrokerError ? error.code : 'unknown')
          : OK_RESULT_CODES.includes(context.resultCode?.()) ? context.resultCode() : null,
        connection: canonicalId(id) ? hash(id).slice(0, 8) : null };
    });
    try {
      let result;
      if (dependencyScope) {
        // Keep the per-connection slot while raw SQL/Auth/audit ignores abort.
        // The public timeout remains bounded; release belongs to actual drain.
        const owned = dependencyScope.begin(work);
        void owned.drained.then(() => release?.(), () => release?.());
        result = await owned.result;
      } else {
        try { result = await work(); } finally { release?.(); }
      }
      settle();
      return result;
    } catch (error) { settle(error); throw error; }
  }

  return Object.freeze({
    auditReceipts() { return structuredClone(receipts); },
    async listGroupTools(presentedToken, commandContext, { signal } = {}) {
      if (!groups) fail('tool_not_available');
      if (!(signal instanceof AbortSignal) || !exactData(commandContext, ['commandId', 'claimId']) ||
          !canonicalId(commandContext.commandId) || !canonicalId(commandContext.claimId)) fail('invalid_request');
      const claim = Object.freeze({ ...commandContext }); let service;
      return invoke(presentedToken, 'private/group-directory', async (identity, innerSignal) => {
        if (!mayUseGroupTool(identity.effective, 'directory')) fail('tool_not_available');
        service = groups.createService(claim);
        if (!service || ['prepareGroupDirectory', 'finalizeGroupDirectory'].some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
        const prepared = await service.prepareGroupDirectory(presentedToken, { signal: innerSignal });
        if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
        return prepared;
      }, async (prepared, identity, innerSignal) => {
        await service.finalizeGroupDirectory(presentedToken, prepared, { signal: innerSignal });
        const tools = [[GROUP_DIRECTORY_TOOL, 'directory'], [GROUP_PREVIEW_TOOL, 'preview'],
          [GROUP_SEND_TOOL, 'send'], [GROUP_SEND_STATUS_TOOL, 'status']]
          .filter(([, operation]) => mayUseGroupTool(identity.effective, operation) &&
            (!['preview', 'send'].includes(operation) || mayReadRooms(identity)))
          .map(([tool]) => tool);
        return Object.freeze({ tools: Object.freeze(tools) });
      }, { authority: groups.authority, signal });
    },
    async sendGroupRooms(presentedToken, commandContext, suppliedIntent, { signal, onDispatch = () => {}, onRejected = () => {} } = {}) {
      if (!groups) fail('tool_not_available');
      if (!(signal instanceof AbortSignal) || [onDispatch, onRejected].some(fn => typeof fn !== 'function') ||
          !exactData(commandContext, ['commandId', 'claimId']) || !canonicalId(commandContext.commandId) || !canonicalId(commandContext.claimId)) fail('invalid_request');
      const claim = Object.freeze({ ...commandContext }); let service, uncertain = false, dispatchId, intent, invalid = false;
      try { intent = groupPreviewIntent(suppliedIntent); } catch (error) { invalid = ['group_recipient_limit', 'group_room_limit'].includes(error?.code) ? error.code : 'invalid_request'; }
      return invoke(presentedToken, 'private/group-room-send', async (identity, innerSignal) => {
        if (!mayReadRooms(identity) || !mayUseGroupTool(identity.effective, 'send')) fail('tool_not_available');
        if (invalid) fail(invalid); service = groups.createService(claim);
        if (!service || ['prepareGroupRoomPreview', 'finalizeGroupRoomSend'].some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
        const prepared = await service.prepareGroupRoomPreview(presentedToken, intent, { signal: innerSignal });
        if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable'); return prepared;
      }, async (prepared, _identity, innerSignal) => groupSendResponse(await service.finalizeGroupRoomSend(presentedToken, prepared, {
        signal: innerSignal, onDispatch(id) { uncertain = true; if (!canonicalId(id)) fail('backend_unavailable'); dispatchId = id; onDispatch(id); }, onRejected() { uncertain = false; onRejected(); },
      }), clock()), { authority: groups.authority, signal, sendUncertain: () => uncertain, sendDispatchId: () => dispatchId });
    },
    async groupDirectory(presentedToken, commandContext, { signal } = {}) {
      if (!groups) fail('tool_not_available');
      if (!(signal instanceof AbortSignal) || !exactData(commandContext, ['commandId', 'claimId']) ||
          !canonicalId(commandContext.commandId) || !canonicalId(commandContext.claimId)) fail('invalid_request');
      const claim = Object.freeze({ ...commandContext }); let service;
      return invoke(presentedToken, 'private/group-directory', async (identity, innerSignal) => {
        if (!mayUseGroupTool(identity.effective, 'directory')) fail('tool_not_available');
        service = groups.createService(claim);
        if (!service || ['prepareGroupDirectory', 'finalizeGroupDirectory'].some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
        const prepared = await service.prepareGroupDirectory(presentedToken, { signal: innerSignal });
        if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
        return prepared;
      }, (prepared, _identity, innerSignal) => service.finalizeGroupDirectory(presentedToken, prepared, { signal: innerSignal }),
      { authority: groups.authority, signal });
    },
    async groupSendStatus(presentedToken, commandContext, dispatchId, { signal } = {}) {
      if (!groups) fail('tool_not_available');
      if (!(signal instanceof AbortSignal) || !canonicalId(dispatchId) || !exactData(commandContext, ['commandId', 'claimId']) ||
          !canonicalId(commandContext.commandId) || !canonicalId(commandContext.claimId)) fail('invalid_request');
      const claim = Object.freeze({ ...commandContext }); let service;
      return invoke(presentedToken, 'private/group-send-status', async (identity, innerSignal) => {
        if (!mayUseGroupTool(identity.effective, 'status')) fail('tool_not_available');
        service = groups.createService(claim);
        if (!service || ['prepareGroupDirectory', 'finalizeGroupSendStatus'].some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
        const prepared = await service.prepareGroupDirectory(presentedToken, { signal: innerSignal });
        if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable'); return prepared;
      }, (prepared, _identity, innerSignal) => service.finalizeGroupSendStatus(presentedToken, prepared, dispatchId, { signal: innerSignal }),
      { authority: groups.authority, signal });
    },
    // Host-only. The runtime gateway supplies commandContext from the active
    // supervisor WeakMap after a definite dispatch ACK, never model JSON.
    async previewGroupRooms(presentedToken, commandContext, suppliedIntent, { signal } = {}) {
      if (!groups) fail('tool_not_available');
      if (!(signal instanceof AbortSignal) || !exactData(commandContext, ['commandId', 'claimId']) ||
          !canonicalId(commandContext.commandId) || !canonicalId(commandContext.claimId)) fail('invalid_request');
      const claim = Object.freeze({ ...commandContext });
      let intent, invalid = false, service;
      try { intent = groupPreviewIntent(suppliedIntent); } catch (error) { invalid = ['group_recipient_limit', 'group_room_limit'].includes(error?.code) ? error.code : 'invalid_request'; }
      return invoke(presentedToken, 'private/group-room-preview', async (identity, innerSignal) => {
        if (!mayReadRooms(identity) || !mayUseGroupTool(identity.effective, 'preview')) fail('tool_not_available');
        if (invalid) fail(invalid);
        service = groups.createService(claim);
        if (!service || ['prepareGroupRoomPreview', 'finalizeGroupRoomPreview'].some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
        const prepared = await service.prepareGroupRoomPreview(presentedToken, intent, { signal: innerSignal });
        if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
        return prepared;
      }, async (prepared, _identity, innerSignal) =>
        groupPreviewResponse(await service.finalizeGroupRoomPreview(presentedToken, prepared, { signal: innerSignal }), intent, clock()),
      { authority: groups.authority, signal });
    },
    async issueConnection(input) {
      if (injectedAuthority) fail('forbidden');
      if (!exactKeys(input, ['accessToken', 'organizationId', 'restrictions']) ||
          typeof input.accessToken !== 'string' || input.accessToken.length < 1 || input.accessToken.length > 16_384 ||
          !validId(input.organizationId)) fail('invalid_request');
      const restrictions = permissions(input.restrictions);
      return bounded(async (signal) => {
        const current = await resolveIdentity(input.accessToken, input.organizationId, signal);
        const now = clock();
        const row = {
          id: randomUUID(), userId: current.session.userId, organizationId: input.organizationId,
          assistantId: await assistantStore.getOrCreate(current.session.userId, input.organizationId),
          restrictions, state: 'active', epoch: 1,
          expiresAt: Math.min(current.session.expiresAt, now + limits.tokenLifetimeMs),
        };
        const issuedToken = token();
        row.tokenDigest = hash(issuedToken);
        row.credentialRef = await sessionStore.put({ ...current.session, accessToken: input.accessToken });
        if (signal.aborted) { await sessionStore.delete(row.credentialRef); fail('timeout'); }
        try {
          await connectionStore.create(row);
          if (signal.aborted) fail('timeout');
        } catch (error) {
          await connectionStore.delete(row.id);
          await sessionStore.delete(row.credentialRef);
          throw error;
        }
        return { token: issuedToken, connection: safeConnection(row) };
      });
    },
    // Trusted control-plane methods. They are intentionally absent from MCP.
    async revokeConnection(id) {
      if (injectedAuthority) fail('forbidden');
      const row = await connectionStore.get(id);
      if (!row) fail('unauthorized');
      if (row.state === 'revoked') return;
      if (!await connectionStore.replace(id, row.epoch, { ...row, state: 'revoked', epoch: row.epoch + 1 })) fail('context_changed');
      await sessionStore.delete(row.credentialRef);
    },
    async restrictConnection(id, nextRestrictions) {
      if (injectedAuthority) fail('forbidden');
      const restrictions = permissions(nextRestrictions);
      const row = await connectionStore.get(id);
      if (!row || row.state !== 'active') fail('unauthorized');
      // P1 management only tightens. Regrant/rotation requires a fresh verified connection.
      for (const kind of ['read', 'action']) {
        if (restrictions[kind].some((key) => !row.restrictions[kind].includes(key))) fail('forbidden');
      }
      if (!await connectionStore.replace(id, row.epoch, { ...row, restrictions, epoch: row.epoch + 1 })) fail('context_changed');
    },
    async authenticate(presentedToken) {
      return invoke(presentedToken, 'authenticate', (identity) => safeConnection(identity.row));
    },
    async listTools(presentedToken) {
      return invoke(presentedToken, 'tools/list', (identity) => {
        const tools = grantedTools(identity);
        return { tools: [...tools, ...(tools.some(startsCrmRequest) ? [NEW_REQUEST_ID_TOOL] : [])].map(tool => advertisedTool(tool)) };
      }, undefined, external ? { authority: external.authority } : {});
    },
    async callTool(presentedToken, name, args) {
      // Omitted/blank/nil-UUID placeholders of nullable fields become null per
      // the original definition; an unknown name or non-object is left as is.
      args = normalizeToolArguments(definitions.get(name), args);
      // Every tools/call carries its tool name for tool_call_timing (name only; invoke logs it only when catalogued).
      const call = (handler, finalize, context = {}) => invoke(presentedToken, 'tools/call', handler, finalize, { ...context, tool: name });
      // No CRM read/write and no stored state, but the same token/authority,
      // per-connection tools/call quota, audit and post-audit authority check
      // as every tool: a revoked or expired connection never receives an id.
      if (name === NEW_REQUEST_ID_TOOL.name) {
        const invalid = !dataRecord(args) || Object.keys(args).length !== 0;
        return call((identity) => {
          if (!mayIssueRequestId(identity)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          return { content: [{ type: 'text', text: JSON.stringify({ requestId: randomUUID() }) }], isError: false };
        }, undefined, external ? { authority: external.authority } : {});
      }
      // Thao tác ghi dùng chung: needs_input là kết quả thường; lỗi thật mang reason; mất phản hồi ⇒ action_outcome_unknown.
      const actionRoute = action?.route(name);
      if (actionRoute) {
        const plan = action.begin(actionRoute, args);
        return call((identity, signal) => action.handle(plan, presentedToken, identity, signal),
          plan.op === 'list' ? undefined : (receipt, identity, signal) => action.finish(plan, presentedToken, receipt, identity, signal),
          action.context(plan));
      }
      const taskOperation = taskActionOperation(name);
      if (task && taskOperation) {
        let input, invalid = false, uncertain = false, retry = null, resultCode = null;
        try { input = taskActionInput(taskOperation, args); } catch { invalid = true; }
        // 22/10 (câu 29): a crm_task_input_options call refused by the validator answers ONE static hint
        // (task-input-contract.mjs) as an ordinary result, never reaching CRM: Hermes pauses the whole MCP
        // server for ~60 s after three isError results in a row (TEST 21/10: 21/27 task creations lost).
        // tool_call_timing still names it (code task_options_hint / task_options_legacy, outcome ok).
        const hint = invalid && taskOperation === 'options' ? taskOptionsHint(args) : null;
        return call(async (identity, signal) => {
          if (!mayUseTaskAction(identity.effective, taskOperation)) fail('tool_not_available');
          if (hint !== null) { retry = taskOptionsRetry(hint); return Object.freeze({}); }
          if (invalid) fail('invalid_request');
          const receipt = await task.prepareTask(presentedToken, taskOperation, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          if (retry !== null) { resultCode = 'task_options_hint'; return { content: [{ type: 'text', text: JSON.stringify(retry) }], isError: false }; }
          let result;
          try {
            result = await task.finalizeTask(presentedToken, receipt, { signal,
              onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          } catch (error) {
            // SQL before 20261021172540 (v5) refuses a company-wide jobTypes/assignees lookup with 22023: the same
            // static guidance (pass a building) instead of a plain error. Transition only: remove this branch (and
            // TASK_OPTIONS_HINTS.legacy) once 20261021172540 is live on production — afterwards a 22023 here (e.g. the
            // 256-building cap) would get a misleading "pass buildingId" instead of the plain error.
            if (!(error instanceof BrokerError) || error.code !== 'invalid_request' || !taskOptionsCompanyWide(taskOperation, input)) throw error;
            resultCode = 'task_options_legacy';
            return { content: [{ type: 'text', text: JSON.stringify(taskOptionsRetry(TASK_OPTIONS_HINTS.legacy)) }], isError: false };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'task_outcome_unknown', mutationRequestId: () => input?.requestId,
          resultCode: () => resultCode });
      }
      const passOperation = roomPassOperation(name);
      if (pass && passOperation) {
        // confirmToken thuộc rào chữ công khai, không phải đầu vào CRM: tách trước validator.
        const split = splitConfirmToken(name, args);
        let input, invalid = split.invalid, uncertain = false, confirmation;
        try { input = roomPassInput(passOperation, split.args); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (!mayUseRoomPass(identity.effective, passOperation)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          // Trước mọi I/O ghi: chữ công khai mới luôn phải qua xác nhận hai bước.
          const reviewed = publicText.review(identity.row.id, name, input, split.confirmToken);
          if (reviewed.refused) fail('confirmation_invalid');
          if (reviewed.confirmation) { confirmation = reviewed.confirmation; return Object.freeze({}); }
          const receipt = await pass.prepareRoomPass(presentedToken, passOperation, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          if (confirmation) return { content: [{ type: 'text', text: JSON.stringify(confirmation) }], isError: false };
          const result = await pass.finalizeRoomPass(presentedToken, receipt, { signal,
            onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'room_pass_outcome_unknown', mutationRequestId: () => input?.requestId });
      }
      // Customer/lead and expense create share one shape: fixed DTO, branded
      // receipt prepared before audit, final bound-JWT RPC as the last await.
      // Lost ACK after dispatch is a distinct unknown code with the requestId;
      // nothing here retries a create.
      const customerOp = customerActionOperation(name);
      if (customer && customerOp) {
        let input, invalid = false, uncertain = false;
        try { input = customerActionInput(customerOp, args); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (!mayUseCustomerAction(identity.effective, customerOp)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          const receipt = await customer.prepareCustomerAction(presentedToken, customerOp, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          const result = await customer.finalizeCustomerAction(presentedToken, receipt, { signal,
            onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'customer_outcome_unknown', mutationRequestId: () => input?.requestId });
      }
      const expenseOp = expenseActionOperation(name);
      if (expense && expenseOp) {
        let input, invalid = false, uncertain = false;
        try { input = expenseActionInput(expenseOp, args); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (!mayUseExpenseAction(identity.effective, expenseOp)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          const receipt = await expense.prepareExpenseAction(presentedToken, expenseOp, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          const result = await expense.finalizeExpenseAction(presentedToken, receipt, { signal,
            onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'expense_outcome_unknown', mutationRequestId: () => input?.requestId });
      }
      const domainOp = domainOperation(name);
      if (domain && domainOp) {
        let input, invalid = false, names = null, deferred = false;
        // R2b: a call shaped the wrong way (contracts/invoices + dates, pending_approvals + building/status, income_expenses +
        // type, assets asking for vehicles, a building code as buildingId) carries a static routing hint as `detail` of its
        // invalid_request (read-misuse-hints.mjs; mcp-http forwards only those strings). Computed on the normalized arguments,
        // before the names leave them; attached only when the validator refused. Every hint rule names input that no name
        // resolution can repair (the mount runs domainInput before any directory RPC), so a list-domain call with names and a
        // hint is refused here with the same code it would get from the mount, now with the detail.
        const hint = readMisuseHint(domainOp, args);
        // B5d: buildingName/roomName leave the arguments before the unchanged validator; the mount resolves
        // them to ids with the asker's JWT (directory under RLS) inside prepare, then validates again. An
        // input that only passes once the names are ids (a report whose roomId is required) is validated there.
        try { ({ args, names } = splitReadNames(domainOp, args)); } catch { invalid = true; }
        if (!invalid) { try { input = domainInput(domainOp, args); } catch { if (names === null || !dataRecord(args) || hint !== null) invalid = true; else { input = args; deferred = true; } } }
        return call(async (identity, signal) => {
          if (!mayUseDomain(identity.effective, domainOp)) fail('tool_not_available');
          if (invalid) { const error = new BrokerError('invalid_request'); if (hint !== null) error.detail = hint; throw error; }
          // Đợt 2 (crm_read_report): tool hiện vì có khoá của MỘT báo cáo nào đó; báo cáo được gọi cần đúng khoá của nó
          // (a deferred input is checked by the mount once resolved and validated).
          if (!deferred && !mayUseDomain(identity.effective, domainOp, input)) fail('forbidden');
          const receipt = await domain.prepareDomain(presentedToken, domainOp, input, names === null ? { signal } : { signal, names });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => ({ content: [{ type: 'text', text: JSON.stringify(
          await domain.finalizeDomain(presentedToken, receipt, { signal })) }], isError: false }),
        domainReadContext(domainOp));
      }
      const scheduleOp = scheduleOperation(name);
      if (schedule && scheduleOp) {
        let input, invalid = false, uncertain = false;
        try { input = scheduleInput(scheduleOp, args, clock()); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (RETIRED_SCHEDULE_OPERATIONS.includes(scheduleOp) || !mayUseSchedule(identity.effective, scheduleOp)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          const receipt = await schedule.prepareSchedule(presentedToken, scheduleOp, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          const result = await schedule.finalizeSchedule(presentedToken, receipt, { signal,
            onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'schedule_outcome_unknown' });
      }
      // Same receipt shape as room pass: fixed DTO, branded receipt before audit,
      // the bound-JWT SQL call last. Reads never dispatch; a lost write ACK is
      // zalo_broadcast_outcome_unknown (+ requestId for send/update), never retried.
      const broadcastOp = zaloBroadcastOperation(name);
      if (broadcast && broadcastOp) {
        let input, invalid = false, uncertain = false;
        try { input = zaloBroadcastInput(broadcastOp, args); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (!mayUseZaloBroadcast(identity.effective, broadcastOp)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          // Listed for manage_automation, but turning sends on/adding recipients also needs chat_zalo.send.
          if (!mayUseZaloBroadcast(identity.effective, broadcastOp, input)) fail('forbidden');
          const receipt = await broadcast.prepareZaloBroadcast(presentedToken, broadcastOp, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          const result = await broadcast.finalizeZaloBroadcast(presentedToken, receipt, { signal,
            onDispatch() { uncertain = true; }, onRejected() { uncertain = false; } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain, mutationCode: 'zalo_broadcast_outcome_unknown', mutationRequestId: () => input?.requestId });
      }
      const memoryOperation = workMemoryOperation(name);
      if (memory && memoryOperation) {
        let input, invalid = false, uncertain = false;
        try { input = workMemoryInput(memoryOperation, args); } catch { invalid = true; }
        return call(async (identity, signal) => {
          if (!mayUseWorkMemory(identity.effective, memoryOperation)) fail('tool_not_available');
          if (invalid) fail('invalid_request');
          const receipt = await memory.prepareMemory(presentedToken, memoryOperation, input, { signal });
          if (!exactData(receipt, []) || !Object.isFrozen(receipt)) fail('backend_unavailable');
          return receipt;
        }, async (receipt, _identity, signal) => {
          const result = await memory.finalizeMemory(presentedToken, receipt, {
            signal, onDispatch() { uncertain = true; }, onRejected() { uncertain = false; },
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { mutationUncertain: () => uncertain });
      }
      const operation = externalGroupOperation(name);
      if (external && operation) {
        let input, invalid, service, uncertain = false, dispatchId;
        try { input = externalGroupInput(operation, args); }
        catch (error) { invalid = ['group_recipient_limit', 'group_room_limit'].includes(error?.code) ? error.code : 'invalid_request'; }
        return call(async (identity, signal) => {
          if (!mayUseGroupTool(identity.effective, operation) ||
              ['preview', 'send'].includes(operation) && !mayReadRooms(identity)) fail('tool_not_available');
          if (invalid) fail(invalid);
          service = external.createService(operation === 'send' ? { requestId: input.requestId } : {});
          const methods = ['directory', 'status'].includes(operation) ? ['prepareGroupDirectory',
            operation === 'directory' ? 'finalizeGroupDirectory' : 'finalizeGroupSendStatus'] :
            ['prepareGroupRoomPreview', operation === 'preview' ? 'finalizeGroupRoomPreview' : 'finalizeGroupRoomSend'];
          if (!service || methods.some(key => typeof service[key] !== 'function')) fail('backend_unavailable');
          const prepared = ['directory', 'status'].includes(operation) ? await service.prepareGroupDirectory(presentedToken, { signal }) :
            await service.prepareGroupRoomPreview(presentedToken, { roomIds: input.roomIds, conversationIds: input.conversationIds }, { signal });
          if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
          return prepared;
        }, async (prepared, _identity, signal) => {
          let result;
          if (operation === 'directory') result = await service.finalizeGroupDirectory(presentedToken, prepared, { signal });
          else if (operation === 'status') result = await service.finalizeGroupSendStatus(presentedToken, prepared, input.dispatchId, { signal });
          else if (operation === 'preview') result = groupPreviewResponse(await service.finalizeGroupRoomPreview(presentedToken, prepared, { signal }), input, clock());
          else result = groupSendResponse(await service.finalizeGroupRoomSend(presentedToken, prepared, {
            signal, onDispatch(id) { uncertain = true; if (id !== input.requestId) fail('backend_unavailable'); dispatchId = id; },
            onRejected() { uncertain = false; },
          }), clock());
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        }, { authority: external.authority, sendUncertain: () => uncertain, sendDispatchId: () => dispatchId });
      }
      // Snapshot caller-controlled filters before any awaited admission. Invalid
      // input still goes through the shared admission/audit path.
      let request, invalidFilters = false, contextReceipt;
      if (name === ROOM_TOOL.name) { try { request = roomFilters(args); } catch { invalidFilters = true; } }
      const contextDirectory = name === TOOL.name && Boolean(domain?.prepareContext);
      return call(async (identity, signal) => {
        if (name === ROOM_TOOL.name) {
          if (!mayReadRooms(identity)) fail('tool_not_available');
          if (invalidFilters) fail('invalid_request');
          const prepared = await rooms.prepareAvailableRooms(presentedToken, request, { signal });
          if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
          return prepared;
        }
        if (name !== TOOL.name || !identity.effective.read.includes(CONTEXT_PERMISSION)) fail('tool_not_available');
        if (!exactKeys(args, []) || Object.keys(args).length !== 0) fail('invalid_request');
        const result = {
          assistantId: identity.row.assistantId, userId: identity.row.userId,
          organizationId: identity.row.organizationId, permissions: identity.effective,
          contextVersion: identity.contextVersion,
        };
        if (!contextDirectory) return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
        // B5d: company name and the buildings of the widest read scope, read with the asker's JWT (directory under RLS).
        const buildingIds = [...new Set(identity.effective.read.flatMap(key => identity.scopesByPermission[key]?.buildingIds ?? []))].slice(0, 256);
        contextReceipt = await domain.prepareContext(presentedToken, { organizationId: identity.row.organizationId, buildingIds, contextVersion: identity.contextVersion }, { signal });
        if (!exactData(contextReceipt, []) || !Object.isFrozen(contextReceipt)) fail('backend_unavailable');
        return result;
      }, name === ROOM_TOOL.name && rooms ? async (prepared, identity, signal) =>
        roomResult(await rooms.finalizeAvailableRooms(presentedToken, prepared, { signal, useInitialAdmission: true }), request, identity)
        : contextDirectory ? async (result, _identity, signal) => {
          // null: the directory SQL is not deployed yet (never an empty list standing in for "no buildings").
          const directory = await domain.finalizeContext(presentedToken, contextReceipt, { signal });
          // R2c phần 2 (c): userName = tên hiển thị của chính người hỏi (null: hàm SQL chưa có hoặc hồ sơ không đọc được).
          if (!exactData(directory, ['organizationName', 'userName', 'buildings']) || !(directory.organizationName === null || typeof directory.organizationName === 'string') ||
              !(directory.userName === null || typeof directory.userName === 'string') ||
              !(directory.buildings === null || Array.isArray(directory.buildings) && directory.buildings.length <= 256 &&
                directory.buildings.every(row => exactData(row, ['id', 'name', 'code']) && canonicalId(row.id)))) fail('backend_unavailable');
          const { assistantId, userId, organizationId, permissions, contextVersion } = result;
          return { content: [{ type: 'text', text: JSON.stringify({ assistantId, userId, userName: directory.userName, organizationId, organizationName: directory.organizationName,
            permissions, contextVersion, buildings: structuredClone(directory.buildings) }) }], isError: false };
        } : undefined,
      { initialRoomAdmission: name === ROOM_TOOL.name && Boolean(rooms) });
    },
  });
}
