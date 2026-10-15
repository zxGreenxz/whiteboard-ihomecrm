import { domainExact, domainId, canonicalInstant } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';
export const TASK_ACTION = 'tasks.create';
const nullable = check => value => value === null || check(value);
const text = (value, max) => typeof value === 'string' && [...value].length <= max && !value.includes('\0');
const title = value => text(value, 200) && value.length > 0 && value.replace(/^ +| +$/g, '') === value && !/[\r\n\t]/.test(value);
const instant = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const priority = value => ['NORMAL', 'LOW', 'URGENT'].includes(value);
const fail = () => { throw new TypeError('invalid_task_action'); };
export const mayUseTask = (effective, operation) => ['create', 'status'].includes(operation) && effective?.action?.includes(TASK_ACTION) === true;
export function taskInput(operation, input) {
  if (operation === 'status') {
    if (!domainExact(input, ['requestId']) || !domainId(input.requestId)) fail();
  } else if (operation === 'create') {
    if (!domainExact(input, ['requestId', 'title', 'description', 'buildingId', 'roomId', 'jobTypeId', 'priority', 'assigneeId', 'deadline']) ||
      !domainId(input.requestId) || !title(input.title) || !nullable(v => text(v, 4000))(input.description) ||
      !domainId(input.buildingId) || !nullable(domainId)(input.roomId) || !domainId(input.jobTypeId) ||
      !priority(input.priority) || !nullable(domainId)(input.assigneeId) || !(input.deadline === null || canonicalInstant(input.deadline) !== null)) fail();
    // Any zoned RFC 3339 deadline becomes the canonical form SQL requires and echoes;
    // the result check below still compares the SQL job deadline strictly.
    return { ...input, deadline: input.deadline === null ? null : canonicalInstant(input.deadline) };
  } else fail();
  return { ...input };
}
export function taskResult(operation, value, identity, input) {
  if (!['create', 'status'].includes(operation) || !domainExact(value, ['organizationId', 'requestId', 'outcome', 'job']) ||
    value.organizationId !== identity.row.organizationId || value.requestId !== input.requestId ||
    !['applied', 'not_found', 'unknown'].includes(value.outcome)) fail();
  if (value.outcome !== 'applied') {
    if (operation !== 'status' || value.job !== null) fail();
    return { ...value };
  }
  const job = value.job;
  if (!domainExact(job, ['id', 'code', 'title', 'buildingId', 'roomId', 'jobTypeId', 'priority', 'assigneeId', 'deadline', 'status', 'createdBy']) ||
    !domainId(job.id) || !text(job.code, 64) || !job.code || !title(job.title) || !domainId(job.buildingId) ||
    !nullable(domainId)(job.roomId) || !domainId(job.jobTypeId) || !priority(job.priority) || !nullable(domainId)(job.assigneeId) ||
    !nullable(instant)(job.deadline) || job.status !== 'IN_PROGRESS' || job.createdBy !== identity.row.userId) fail();
  const buildings = identity.scopesByPermission?.[TASK_ACTION]?.buildingIds;
  if (Array.isArray(buildings) && !buildings.includes(job.buildingId)) fail();
  if (operation === 'create' && ['title', 'buildingId', 'roomId', 'jobTypeId', 'priority', 'assigneeId', 'deadline'].some(key => job[key] !== input[key])) fail();
  return { ...value, job: { ...job } };
}
const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };
export const TASK_TOOLS = Object.freeze([
  { name: 'crm_task_create', description: `Tạo và giao công việc CRM dưới chính người đang kết nối. ${REQUEST_ID_GUIDANCE} Sau khi mất phản hồi chỉ đối soát status, không tạo lại. Chưa gồm vật tư, ảnh, hoàn thành hoặc thưởng.`,
    inputSchema: { type: 'object', additionalProperties: false,
      required: ['requestId', 'title', 'description', 'buildingId', 'roomId', 'jobTypeId', 'priority', 'assigneeId', 'deadline'],
      properties: { requestId: REQUEST_ID_PROPERTY, title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: ['string', 'null'], maxLength: 4000 },
        buildingId: uuid, roomId: nullableUuid, jobTypeId: uuid, priority: { enum: ['NORMAL', 'LOW', 'URGENT'] }, assigneeId: nullableUuid,
        deadline: { type: ['string', 'null'], format: 'date-time', description: 'UTC hoặc có múi giờ, ví dụ 2026-10-16T05:00:00Z (không múi giờ bị từ chối); null nếu không có hạn.' } } } },
  { name: 'crm_task_status', description: `Đối soát requestId đã dùng. not_found hoặc unknown không cho phép tự gửi lại yêu cầu tạo. ${REQUEST_ID_STATUS_GUIDANCE}`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: uuid } } },
]);
