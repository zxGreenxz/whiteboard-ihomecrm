import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY } from './request-id-contract.mjs';

// Follow/progress/cancel extend the existing CRM task family. Grants are the
// existing CRM task permissions intersected with the Hermes overlay; nothing
// here maps a role or adds a second assignment permission set.
export const TASK_FOLLOW_READ = 'tasks.view';
export const TASK_FOLLOW_ACTION = 'tasks.create';
export const TASK_PROGRESS_ACTION = 'tasks.edit';
export const TASK_CANCEL_ACTION = 'tasks.delete';
const NAMES = Object.freeze({ crm_task_follow_list: 'list', crm_task_follow_set: 'set', crm_task_follow_stop: 'stop',
  crm_task_progress: 'progress', crm_task_cancel: 'cancel' });
export const TASK_FOLLOW_OPERATIONS = Object.freeze(Object.values(NAMES));
export const taskFollowOperation = name => typeof name === 'string' && Object.hasOwn(NAMES, name) ? NAMES[name] : null;
export const isTaskFollowOperation = operation => TASK_FOLLOW_OPERATIONS.includes(operation);
export const isTaskFollowWrite = operation => isTaskFollowOperation(operation) && operation !== 'list';
export function mayUseTaskFollow(effective, operation) {
  const read = effective?.read?.includes(TASK_FOLLOW_READ) === true, action = key => effective?.action?.includes(key) === true;
  if (operation === 'list') return read;
  if (operation === 'set' || operation === 'stop') return read && action(TASK_FOLLOW_ACTION);
  if (operation === 'progress') return action(TASK_PROGRESS_ACTION);
  if (operation === 'cancel') return action(TASK_CANCEL_ACTION);
  return false;
}

const fail = () => { throw new TypeError('invalid_task_follow'); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const nullable = check => value => value === null || check(value);
const SECRET = /hc_[A-Za-z0-9_-]{43}|hzn_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
// Same bounded text rule as SQL: trimmed, no control characters (newline only
// where multiline), no line separators and no credential-shaped strings.
const text = (value, max, multiline = false) => typeof value === 'string' && value.replace(/^[ \n]+|[ \n]+$/g, '') === value &&
  value.length > 0 && [...value].length <= max && !(multiline ? value.replaceAll('\n', '') : value).match(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u) &&
  !SECRET.test(value);
const label = (value, max) => typeof value === 'string' && value.length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const instant = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
const digest = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// SQL input of each operation. organizationId is the connection's company:
// since 20/10/2026 (B5b) the model no longer names it (the 16/10 schema made it
// required, so "how many jobs am I following?" first cost a crm_auth_context
// call, ≈5 s); the adapter binds it before any RPC (bindTaskFollowCompany) and
// a value the model still sends may only restate it.
const KEYS = Object.freeze({
  list: ['organizationId', 'role', 'assigneeUserId', 'status', 'limit', 'offset'],
  set: ['organizationId', 'requestId', 'jobId', 'objective', 'remindBeforeMinutes', 'notifyAssigner', 'parentFollowId'],
  stop: ['organizationId', 'requestId', 'followId', 'expectedVersion'],
  progress: ['organizationId', 'requestId', 'jobId', 'note', 'expectedNoteDigest'],
  cancel: ['organizationId', 'requestId', 'jobId', 'reason'],
});
export function taskFollowInput(operation, raw) {
  if (!isTaskFollowOperation(operation) || !domainExact(raw, Object.keys(raw ?? {})) || Object.keys(raw).some(key => !KEYS[operation].includes(key))) fail();
  const value = operation === 'list' ? { assigneeUserId: null, status: 'open', limit: 20, offset: 0, ...raw }
    : operation === 'set' ? { remindBeforeMinutes: null, notifyAssigner: true, parentFollowId: null, ...raw } : { ...raw };
  const company = Object.hasOwn(value, 'organizationId');
  if (!domainExact(value, company ? KEYS[operation] : KEYS[operation].filter(key => key !== 'organizationId')) || (company && !domainId(value.organizationId))) fail();
  if (operation === 'list') {
    if (!['assigned_to_me', 'assigned_by_me', 'team'].includes(value.role) || !['open', 'completed', 'all'].includes(value.status) ||
      !(value.role === 'team' ? nullable(domainId)(value.assigneeUserId) : value.assigneeUserId === null || typeof value.assigneeUserId === 'string') ||
      !integer(value.limit, 1, 50) || !integer(value.offset, 0, 200)) fail();
    // assigneeUserId only narrows role=team. Elsewhere any string (16/10 20:44Z:
    // a real user id with assigned_by_me) is dropped to the null SQL requires.
    if (value.role !== 'team') value.assigneeUserId = null;
  } else if (!domainId(value.requestId)) fail();
  if (operation === 'set' && (!domainId(value.jobId) || !text(value.objective, 500) || !nullable(v => integer(v, 0, 10080))(value.remindBeforeMinutes) ||
    typeof value.notifyAssigner !== 'boolean' || !nullable(domainId)(value.parentFollowId))) fail();
  if (operation === 'stop' && (!domainId(value.followId) || !integer(value.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1))) fail();
  if (operation === 'progress' && (!domainId(value.jobId) || !text(value.note, 1000, true) || !digest(value.expectedNoteDigest))) fail();
  if (operation === 'cancel' && (!domainId(value.jobId) || !text(value.reason, 300))) fail();
  return Object.freeze(value);
}
/** Bind the connection's company to a validated input before any RPC: SQL
 * compares p_input.organizationId with the connection row, so the value sent is
 * always the connection's. A company the model named must restate it exactly;
 * any other one is refused here (task_follow_company), as SQL would refuse it. */
export function bindTaskFollowCompany(input, organizationId) {
  if (!domainExact(input, Object.keys(input ?? {})) || !domainId(organizationId)) fail();
  if (Object.hasOwn(input, 'organizationId') && input.organizationId !== organizationId) throw new TypeError('task_follow_company');
  return Object.freeze({ ...input, organizationId });
}

const FOLLOW_KEYS = ['id', 'version', 'state', 'closeReason', 'jobId', 'jobCode', 'assignerUserId', 'executorUserId', 'mode', 'depth',
  'parentFollowId', 'objective', 'remindBeforeMinutes', 'notifyAssigner', 'createdAt'];
function follow(value, extra = []) {
  return domainExact(value, [...FOLLOW_KEYS, ...extra]) && domainId(value.id) && integer(value.version, 1, Number.MAX_SAFE_INTEGER - 1) &&
    ['active', 'done', 'cancelled', 'revoked'].includes(value.state) &&
    (value.state === 'active' ? value.closeReason === null : ['stopped', 'job_cancelled', 'job_deleted', 'completed', 'permission_lost', 'membership_lost'].includes(value.closeReason)) &&
    domainId(value.jobId) && label(value.jobCode, 64) && domainId(value.assignerUserId) && domainId(value.executorUserId) &&
    ['self', 'supervisor'].includes(value.mode) && integer(value.depth, 0, 3) && nullable(domainId)(value.parentFollowId) &&
    label(value.objective, 500) && nullable(v => integer(v, 0, 10080))(value.remindBeforeMinutes) && typeof value.notifyAssigner === 'boolean' &&
    instant(value.createdAt);
}
const applied = (value, identity, input, keys) => domainExact(value, ['organizationId', 'requestId', 'outcome', ...keys]) &&
  value.organizationId === identity.row.organizationId && value.organizationId === input.organizationId &&
  value.requestId === input.requestId && value.outcome === 'applied';
function buildingAllowed(identity, permission, buildingId) {
  const buildings = identity.scopesByPermission?.[permission]?.buildingIds;
  return !Array.isArray(buildings) || buildings.includes(buildingId);
}

// Lượt 11 (nghiệm thu 23–24/10, 20261023185118): SQL thêm total + summary của cả tập lọc và tên toà / phòng của từng dòng. Cửa sổ phát
// hành: connector này nhận cả khuôn cũ (không có) lẫn mới (có đủ cặp), kiểm chặt khi có; áp migration sau khi connector đã lên.
const LIST_KEYS = ['organizationId', 'role', 'status', 'readAt', 'items', 'offset', 'nextOffset'];
const ITEM_KEYS = ['id', 'code', 'title', 'status', 'buildingId', 'roomId', 'deadline', 'overdue', 'assigneeId', 'assigneeName', 'createdBy',
  'progressNote', 'progressDigest', 'follows'];
const placeName = value => value === '' || label(value, 120);
function listSummary(value, identity, input) {
  const { total, summary } = value, count = integer => Number.isSafeInteger(integer) && integer >= 0;
  // Trang có dòng ⇒ tổng ≥ mọi dòng tới hết trang; trang cuối (không còn nextOffset, thiếu dòng) ⇒ đúng bằng. Trang rỗng (offset vượt tổng) hợp lệ.
  const filled = value.items.length > 0;
  if (!count(total) || (filled && total < value.offset + value.items.length) ||
    (filled && value.nextOffset === null && value.items.length < input.limit && total !== value.offset + value.items.length) ||
    !domainExact(summary, ['total', 'open', 'overdue', 'completed', 'byBuilding']) || summary.total !== total || !count(summary.open) ||
    !count(summary.completed) || !count(summary.overdue) || summary.open + summary.completed !== total || summary.overdue > summary.open ||
    (input.status === 'open' && summary.completed !== 0) || (input.status === 'completed' && summary.open !== 0) ||
    !Array.isArray(summary.byBuilding) || summary.byBuilding.length > 50) fail();
  const seen = new Set();
  summary.byBuilding.forEach((group, index) => {
    if (!domainExact(group, ['buildingId', 'buildingName', 'count', 'overdue']) || !nullable(domainId)(group.buildingId) || seen.has(group.buildingId) ||
      !placeName(group.buildingName) || !Number.isSafeInteger(group.count) || group.count < 1 || !count(group.overdue) || group.overdue > group.count ||
      (index > 0 && summary.byBuilding[index - 1].count < group.count) ||
      (group.buildingId !== null && input.role !== 'assigned_to_me' && !buildingAllowed(identity, TASK_FOLLOW_READ, group.buildingId))) fail();
    seen.add(group.buildingId);
  });
  const counted = summary.byBuilding.reduce((sum, group) => sum + group.count, 0), late = summary.byBuilding.reduce((sum, group) => sum + group.overdue, 0);
  if (counted > total || late > summary.overdue || (summary.byBuilding.length < 50 && (counted !== total || late !== summary.overdue))) fail();
}

export function taskFollowResult(operation, value, identity, input) {
  const me = identity.row.userId;
  if (operation === 'list') {
    const totals = domainExact(value, [...LIST_KEYS, 'total', 'summary']);
    if (!(totals || domainExact(value, LIST_KEYS)) || value.organizationId !== identity.row.organizationId ||
      value.organizationId !== input.organizationId || value.role !== input.role || value.status !== input.status || !instant(value.readAt) ||
      !Array.isArray(value.items) || value.items.length > input.limit || value.offset !== input.offset ||
      !(value.nextOffset === null || (value.items.length === input.limit && value.nextOffset === input.offset + input.limit && value.nextOffset <= 200))) fail();
    if (totals) listSummary(value, identity, input);
    const seen = new Set();
    for (const item of value.items) {
      const named = domainExact(item, [...ITEM_KEYS, 'buildingName', 'roomName']);
      if (!(named || domainExact(item, ITEM_KEYS)) || (named !== totals) ||
        (named && (!placeName(item.buildingName) || !nullable(v => label(v, 120))(item.roomName) || (item.roomName !== null && item.roomId === null))) ||
        !domainId(item.id) || seen.has(item.id) || !label(item.code, 64) || !label(item.title, 200) ||
        !['IN_PROGRESS', 'COMPLETED'].includes(item.status) || !domainId(item.buildingId) || !nullable(domainId)(item.roomId) ||
        !nullable(instant)(item.deadline) || typeof item.overdue !== 'boolean' || (item.overdue && (item.status !== 'IN_PROGRESS' || item.deadline === null)) ||
        !nullable(domainId)(item.assigneeId) || !nullable(v => label(v, 120))(item.assigneeName) || !domainId(item.createdBy) ||
        !nullable(v => typeof v === 'string' && [...v].length <= 1000 && !v.includes('\0'))(item.progressNote) || !digest(item.progressDigest) ||
        !Array.isArray(item.follows) || item.follows.length > 5 ||
        item.follows.some(f => !follow(f) || f.state !== 'active' || f.jobId !== item.id || (f.assignerUserId !== me && f.executorUserId !== me)) ||
        // Q35 (20261022031600): việc giao cho CHÍNH người hỏi hiện trong "giao cho tôi" dù ở toà ngoài phạm vi tasks.view (SQL cùng
        // luật RLS). Chỉ role assigned_to_me; assigned_by_me / team vẫn đúng phạm vi toà (ma trận CV-R13, 22/10: rào cũ ném
        // backend_unavailable cho cả trang).
        !(buildingAllowed(identity, TASK_FOLLOW_READ, item.buildingId) || (input.role === 'assigned_to_me' && item.assigneeId === me)) ||
        (input.status === 'open' && item.status !== 'IN_PROGRESS') || (input.status === 'completed' && item.status !== 'COMPLETED') ||
        (input.role === 'assigned_to_me' && item.assigneeId !== me) ||
        (input.role === 'team' && input.assigneeUserId !== null && item.assigneeId !== input.assigneeUserId)) fail();
      seen.add(item.id);
    }
    return structuredClone(value);
  }
  if (operation === 'set') {
    if (!applied(value, identity, input, ['follow']) || !follow(value.follow, ['deadline']) || !nullable(instant)(value.follow.deadline) ||
      value.follow.state !== 'active' || value.follow.jobId !== input.jobId || value.follow.assignerUserId !== me ||
      value.follow.objective !== input.objective || value.follow.remindBeforeMinutes !== input.remindBeforeMinutes ||
      value.follow.notifyAssigner !== input.notifyAssigner || value.follow.parentFollowId !== input.parentFollowId) fail();
    return structuredClone(value);
  }
  if (operation === 'stop') {
    if (!applied(value, identity, input, ['follow']) || !follow(value.follow) || value.follow.id !== input.followId ||
      value.follow.state !== 'cancelled' || value.follow.closeReason !== 'stopped' || value.follow.version !== input.expectedVersion + 1 ||
      value.follow.assignerUserId !== me) fail();
    return structuredClone(value);
  }
  if (operation === 'progress') {
    if (!applied(value, identity, input, ['job', 'notified']) || !domainExact(value.job, ['id', 'code', 'status', 'progressDigest']) ||
      value.job.id !== input.jobId || !label(value.job.code, 64) || value.job.status !== 'IN_PROGRESS' || !digest(value.job.progressDigest) ||
      !integer(value.notified, 0, 1000)) fail();
    return structuredClone(value);
  }
  if (operation === 'cancel') {
    if (!applied(value, identity, input, ['job', 'closedFollows', 'notified']) || !domainExact(value.job, ['id', 'code', 'title', 'status', 'assigneeId']) ||
      value.job.id !== input.jobId || !label(value.job.code, 64) || !label(value.job.title, 200) || value.job.status !== 'DELETED' ||
      !nullable(domainId)(value.job.assigneeId) || !integer(value.closedFollows, 0, 10000) || !integer(value.notified, 0, 10000)) fail();
    return structuredClone(value);
  }
  fail();
}

const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };
// No organizationId property (B5b, 20/10/2026): the company is the connection's.
const tool = (name, description, properties, required, annotations) => Object.freeze({ name, description,
  inputSchema: { type: 'object', additionalProperties: false, required, properties }, annotations });
export const TASK_FOLLOW_TOOLS = Object.freeze([
  tool('crm_task_follow_list', 'Xem việc CRM giao cho tôi, tôi giao hoặc của nhóm (team) trong phạm vi quyền xem công việc hiện tại: trạng thái, người thực hiện, hạn, quá hạn, ghi chú tiến độ và mục tiêu theo dõi. Dữ liệu hiện hành lấy từ CRM, không dùng ký ức thay thế.',
    { role: { enum: ['assigned_to_me', 'assigned_by_me', 'team'] }, assigneeUserId: { ...nullableUuid, description: 'Chỉ dùng với role=team; khác thì bỏ qua.' },
      status: { enum: ['open', 'completed', 'all'], default: 'open' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      offset: { type: 'integer', minimum: 0, maximum: 200, default: 0 } }, ['role'],
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  tool('crm_task_follow_set', `Đặt theo dõi chủ động (standing grant) cho một việc CRM đang mở đã có người thực hiện: nhắc người thực hiện trước hạn, báo quá hạn/hoàn thành/tiến độ cho người giao. Ghi bạn là người giao; không làm thay người nhận. ${REQUEST_ID_GUIDANCE} Mất phản hồi thì gọi lại đúng requestId để đối soát. Chuỗi giao lại cần parentFollowId; giao ngược cho người đang giao việc cho bạn bị chặn để chống vòng lặp.`,
    { requestId: REQUEST_ID_PROPERTY, jobId: uuid, objective: { type: 'string', minLength: 1, maxLength: 500 },
      remindBeforeMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 10080, default: null }, notifyAssigner: { type: 'boolean', default: true },
      parentFollowId: { ...nullableUuid, default: null } }, ['requestId', 'jobId', 'objective'],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  tool('crm_task_follow_stop', `Dừng theo dõi/nhắc do chính bạn đã đặt (dùng version hiện tại). Không xoá việc CRM. ${REQUEST_ID_GUIDANCE}`,
    { requestId: REQUEST_ID_PROPERTY, followId: uuid, expectedVersion: { type: 'integer', minimum: 1 } },
    ['requestId', 'followId', 'expectedVersion'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
  tool('crm_task_progress', `Ghi tiến độ (ghi chú) cho việc CRM đang mở mà bạn thực hiện hoặc đã tạo, theo quyền sửa công việc. Thay toàn bộ ghi chú: lấy progressDigest từ crm_task_follow_list. Hoàn thành việc vẫn làm trong CRM (ảnh, vị trí). ${REQUEST_ID_GUIDANCE}`,
    { requestId: REQUEST_ID_PROPERTY, jobId: uuid, note: { type: 'string', minLength: 1, maxLength: 1000 },
      expectedNoteDigest: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['requestId', 'jobId', 'note', 'expectedNoteDigest'],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
  tool('crm_task_cancel', `Huỷ (xoá) một việc CRM đang mở theo quyền xoá công việc hiện tại khi người dùng yêu cầu rõ. Không huỷ việc đã hoàn thành hoặc đã ghi vật tư. Báo người thực hiện và đóng các theo dõi; ghi người huỷ và người thực hiện. ${REQUEST_ID_GUIDANCE}`,
    { requestId: REQUEST_ID_PROPERTY, jobId: uuid, reason: { type: 'string', minLength: 1, maxLength: 300 } },
    ['requestId', 'jobId', 'reason'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
]);
