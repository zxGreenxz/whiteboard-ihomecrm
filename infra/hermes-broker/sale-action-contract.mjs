import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';

// Action-only projection: never borrow a cached reader's admission or grants.
export const SALE_ACTIONS = Object.freeze(['rooms.edit', 'sale_phong.manage_images', 'sale_phong.lock_room', 'deposits.create', 'deposits.edit']);
// Báo cọc / thu thêm CÓ TIỀN (crm_sale_reservation_create / _topup) ghi phiếu THU một bước: không bản xem trước, không confirmToken,
// bộ ghi CRM có thể tự duyệt lúc sinh. Ngoài deposits.create + income_expenses.create (như cũ), hai thao tác này đòi thêm khoá riêng
// Hermes dưới đây: bật income_expenses.create cho trang Thu chi (crm_action_*) không còn mở chúng. Khoá seed TẮT (migration
// hermes_sale_deposit_receipt_key_v1). SQL hermes_sale_actions_v1 đòi cùng khoá ở registry, chính sách công ty và kết nối, NHƯNG
// production có 0 dòng hermes_org_policies (chính sách trung tính = mọi khoá đang bật) và kết nối sống đều inherit_crm (tự nhận mọi
// khoá đang bật): chỉ lật dòng registry là cả ba lớp SQL thoả. Rào còn lại là ở đây: không lớp quyền nào của connector cấp khoá này
// nên hai thao tác luôn ẩn. Bật thật phải cùng một lượt: connector có lớp cấp khoá + xem trước / confirmToken, SQL có dòng
// hermes_org_policies tường minh hoặc cấp theo từng kết nối. Không nằm trong SALE_ACTIONS: hermes_sale_capabilities_v1 trả đúng năm khoá.
export const SALE_DEPOSIT_RECEIPT_KEY = 'deposits.create_receipt';
const DEPOSIT_RECEIPT_OPS = Object.freeze(['reservation_create', 'reservation_topup']);
const DEPOSIT_RECEIPT_KEYS = Object.freeze(['income_expenses.create', SALE_DEPOSIT_RECEIPT_KEY]);
const EDIT_ACTIONS = ['rooms.edit', 'sale_phong.edit'];
const OPTION_ACTIONS = [...SALE_ACTIONS, 'sale_phong.edit'];
export const SALE_PATCH_FIELDS = Object.freeze(['rent_price', 'area', 'room_type', 'amenities', 'sale_note', 'sale_bonus_note', 'images', 'description']);
const OPS = Object.freeze({
  crm_sale_room_options: 'options', crm_sale_room_observe: 'observe', crm_sale_room_patch: 'patch',
  crm_sale_room_lock: 'lock', crm_sale_room_release: 'release', crm_sale_reservation_create: 'reservation_create',
  crm_sale_reservation_update: 'reservation_update', crm_sale_reservation_topup: 'reservation_topup',
  crm_sale_reservation_assign: 'reservation_assign', crm_sale_action_status: 'status',
});
const MAX_MONEY = 9_999_999_999_999;
const fail = () => { throw new TypeError('invalid_sale_action'); };
const text = (v, max) => typeof v === 'string' && [...v].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v);
const nullable = (v, predicate) => v === null || predicate(v);
const money = v => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MONEY;
const positive = v => Number.isSafeInteger(v) && v > 0;
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const revision = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const safeKeys = (input, required, optional = []) => domainExact(input, Object.keys(input ?? {})) &&
  required.every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key => [...required, ...optional].includes(key));
const imageUrl = v => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try { const url = new URL(v); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
};
export const saleActionOperation = name => Object.hasOwn(OPS, name) ? OPS[name] : undefined;
export const saleActionIsMutation = operation => Object.values(OPS).includes(operation) && !['options', 'observe', 'status'].includes(operation);
export function saleActionPermissions(operation, input) {
  if (operation === 'patch') return input && Object.keys(input).filter(k => SALE_PATCH_FIELDS.includes(k)).every(k => k === 'images')
    ? [...EDIT_ACTIONS, 'sale_phong.manage_images'] : EDIT_ACTIONS;
  if (operation === 'lock') return ['sale_phong.lock_room'];
  if (operation === 'release') return ['sale_phong.lock_room', 'deposits.create'];
  if (['reservation_create', 'reservation_topup'].includes(operation)) return ['deposits.create'];
  if (['reservation_update', 'reservation_assign'].includes(operation)) return ['deposits.edit'];
  if (operation === 'observe') return [...EDIT_ACTIONS, 'sale_phong.manage_images'];
  if (operation === 'options' && input) return [input.action];
  return OPTION_ACTIONS;
}
export function mayUseSaleAction(effective, operation, input) {
  if (!Object.values(OPS).includes(operation)) return false;
  // Without input (catalogue/service prepare), patch may be images-only.
  const keys = operation === 'patch' && !input ? [...EDIT_ACTIONS, 'sale_phong.manage_images'] : saleActionPermissions(operation, input);
  return keys.some(key => effective?.action?.includes(key)) &&
    (!DEPOSIT_RECEIPT_OPS.includes(operation) || DEPOSIT_RECEIPT_KEYS.every(key => effective?.action?.includes(key)));
}
function receiptInput(input) {
  if (!domainExact(input, ['amount', 'accountId', 'voucherDate', 'name', 'description']) ||
      !money(input.amount) || input.amount === 0 || !nullable(input.accountId, domainId) || !date(input.voucherDate) ||
      !nullable(input.name, v => text(v, 200) && v.trim().length > 0) || !nullable(input.description, v => text(v, 1000))) fail();
  return { ...input };
}
export function saleActionInput(operation, input) {
  if (operation === 'options') {
    if (!safeKeys(input, ['action'], ['buildingId', 'query', 'limit', 'cursor'])) fail();
    const v = { buildingId: null, query: '', limit: 20, cursor: null, ...input };
    if (!OPTION_ACTIONS.includes(v.action) || !nullable(v.buildingId, domainId) || !text(v.query, 100) ||
      !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 50 || !nullable(v.cursor, domainId)) fail();
    return { ...v, query: v.query.trim() };
  }
  if (operation === 'observe') {
    if (!domainExact(input, ['roomId']) || !domainId(input.roomId)) fail();
    return { ...input };
  }
  if (operation === 'status') {
    if (!domainExact(input, ['requestId']) || !domainId(input.requestId)) fail();
    return { ...input };
  }
  if (!domainId(input?.requestId)) fail();
  if (operation === 'patch') {
    if (!safeKeys(input, ['requestId', 'roomId', 'expectedRevision'], SALE_PATCH_FIELDS) ||
      !domainId(input.roomId) || !revision(input.expectedRevision) || !SALE_PATCH_FIELDS.some(k => Object.hasOwn(input, k))) fail();
    for (const k of SALE_PATCH_FIELDS) if (Object.hasOwn(input, k)) {
      const v = input[k];
      if (k === 'rent_price' ? !money(v) : k === 'area' ? !(v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-7) :
        k === 'amenities' ? !(Array.isArray(v) && v.length <= 50 && v.every(s => text(s, 200) && s.trim().length > 0)) :
        k === 'images' ? !(Array.isArray(v) && v.length <= 50 && v.every(imageUrl) && new Set(v).size === v.length) :
        !nullable(v, s => text(s, k === 'room_type' ? 200 : 2000))) fail();
    }
    return { ...input, ...(input.images ? { images: [...input.images] } : {}), ...(input.amenities ? { amenities: [...input.amenities] } : {}) };
  }
  if (operation === 'lock') {
    if (!domainExact(input, ['requestId', 'roomId', 'hours', 'note']) || !domainId(input.roomId) ||
      ![6, 12, 24].includes(input.hours) || !nullable(input.note, v => text(v, 300))) fail();
    return { ...input };
  }
  if (operation === 'release') {
    if (!domainExact(input, ['requestId', 'lockId']) || !domainId(input.lockId)) fail();
    return { ...input };
  }
  if (operation === 'reservation_create') {
    if (!domainExact(input, ['requestId', 'roomId', 'customerId', 'customerHint', 'intendedMoveInOn', 'topupDueOn', 'depositTarget', 'notes', 'receipt']) ||
      !domainId(input.roomId) || !nullable(input.customerId, domainId) || !nullable(input.customerHint, v => text(v, 120) && v.trim().length > 0) ||
      (!!input.customerId === !!input.customerHint) || !nullable(input.intendedMoveInOn, date) || !nullable(input.topupDueOn, date) ||
      !nullable(input.depositTarget, money) || !nullable(input.notes, v => text(v, 2000))) fail();
    return { ...input, receipt: receiptInput(input.receipt) };
  }
  if (!domainId(input.reservationId) || !positive(input.expectedRevision)) fail();
  if (operation === 'reservation_topup') {
    if (!domainExact(input, ['requestId', 'reservationId', 'expectedRevision', 'receipt'])) fail();
    return { ...input, receipt: receiptInput(input.receipt) };
  }
  if (operation === 'reservation_assign') {
    if (!domainExact(input, ['requestId', 'reservationId', 'expectedRevision', 'customerId']) || !domainId(input.customerId)) fail();
    return { ...input };
  }
  if (operation !== 'reservation_update' || !domainExact(input, ['requestId', 'reservationId', 'expectedRevision', 'changes']) ||
    !safeKeys(input.changes, [], ['hold_until', 'intended_move_in_on', 'topup_due_on', 'deposit_target', 'notes']) || !Object.keys(input.changes).length) fail();
  for (const [k, v] of Object.entries(input.changes))
    if (!nullable(v, k === 'notes' ? s => text(s, 2000) : k === 'deposit_target' ? money : date)) fail();
  return { ...input, changes: { ...input.changes } };
}
function scopeAllowed(identity, buildingId, operation, input) {
  return saleActionPermissions(operation, input).some(key => identity.effective.action.includes(key) &&
    identity.scopesByPermission?.[key]?.buildingIds?.includes(buildingId));
}
// SQL emits only these action receipts. No customer phone, arbitrary history,
// internal contacts or account details can cross this validator.
export function saleActionResult(operation, value, identity, input) {
  if (!value || value.organizationId !== identity.row.organizationId) fail();
  if (operation === 'options') {
    if (!domainExact(value, ['organizationId', 'items', 'nextCursor']) || !Array.isArray(value.items) || value.items.length > input.limit ||
      !nullable(value.nextCursor, domainId)) fail();
    for (const item of value.items) if (!domainExact(item, ['id', 'buildingId', 'label', 'buildingLabel']) || !domainId(item.id) ||
      !domainId(item.buildingId) || !text(item.label, 200) || !text(item.buildingLabel, 200) || !scopeAllowed(identity, item.buildingId, operation, input)) fail();
    return structuredClone(value);
  }
  if (operation === 'observe') {
    if (!domainExact(value, ['organizationId', 'room']) || !domainExact(value.room, ['id', 'buildingId', 'revision', 'updatedAt', 'fields']) ||
      value.room.id !== input.roomId || !domainId(value.room.buildingId) || !revision(value.room.revision) || !nullable(value.room.updatedAt, timestamp) ||
      !safeKeys(value.room.fields, [], SALE_PATCH_FIELDS) || !scopeAllowed(identity, value.room.buildingId, operation, input) ||
      Object.keys(value.room.fields).some(k => k !== 'images') && !EDIT_ACTIONS.some(key => identity.effective.action.includes(key) &&
        identity.scopesByPermission?.[key]?.buildingIds?.includes(value.room.buildingId))) fail();
    return structuredClone(value);
  }
  if (!domainExact(value, ['organizationId', 'requestId', 'operation', 'outcome', 'receipt']) || value.requestId !== input.requestId ||
    !['applied', 'not_found', 'unknown'].includes(value.outcome)) fail();
  if (value.outcome !== 'applied') {
    if (operation !== 'status' || value.receipt !== null || value.operation !== null) fail();
    return { ...value };
  }
  if (!saleActionIsMutation(value.operation) || operation !== 'status' && value.operation !== operation ||
      !domainExact(value.receipt, ['id', 'roomId', 'buildingId', 'revision', 'state', 'receivedAmount', 'receipts', 'expiresAt', 'fields']) ||
      !domainId(value.receipt.id) || !domainId(value.receipt.roomId) || !domainId(value.receipt.buildingId) ||
      !scopeAllowed(identity, value.receipt.buildingId, operation === 'status' ? value.operation : operation,
        operation === 'status' && value.operation === 'patch' && Array.isArray(value.receipt.fields) ? Object.fromEntries(value.receipt.fields.map(k => [k, null])) : input)) fail();
  const r = value.receipt;
  if (operation !== 'status' && (input.roomId && r.roomId !== input.roomId ||
    input.lockId && r.id !== input.lockId || input.reservationId && r.id !== input.reservationId)) fail();
  if (!(r.revision === null || revision(r.revision) || positive(r.revision)) ||
      !['UPDATED', 'LOCKED', 'RELEASED', 'HOLD', 'CONVERTED', 'CANCELLED'].includes(r.state) ||
      !nullable(r.receivedAmount, v => typeof v === 'number' && Number.isFinite(v) && v >= 0) ||
      !nullable(r.expiresAt, timestamp) || !Array.isArray(r.fields) || r.fields.some(k => !SALE_PATCH_FIELDS.includes(k)) ||
      !Array.isArray(r.receipts) || r.receipts.length > 200) fail();
  for (const source of r.receipts) if (!domainExact(source, ['voucherId', 'amount', 'received', 'approvalStatus']) ||
      !domainId(source.voucherId) || typeof source.amount !== 'number' || !Number.isFinite(source.amount) || source.amount < 0 ||
      typeof source.received !== 'boolean' || !nullable(source.approvalStatus, v => ['UNAPPROVED', 'APPROVED', 'REJECTED'].includes(v))) fail();
  return structuredClone(value);
}
const uuid = { type: 'string', format: 'uuid' }, nullableId = { type: ['string', 'null'], format: 'uuid' };
const nullableText = maxLength => ({ type: ['string', 'null'], maxLength });
const nullableDate = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const moneySchema = { type: 'integer', minimum: 0, maximum: MAX_MONEY };
const receiptSchema = { type: 'object', additionalProperties: false, required: ['amount', 'accountId', 'voucherDate', 'name', 'description'],
  properties: { amount: { ...moneySchema, minimum: 1 }, accountId: nullableId, voucherDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    name: nullableText(200), description: nullableText(1000) } };
const write = (name, description, properties, optional = []) => Object.freeze({ name,
  description: `${description} ${REQUEST_ID_GUIDANCE} Mất phản hồi: crm_sale_action_status; giữ nguyên requestId và nội dung khi đối soát/thử lại. Chỉ ghi khi người dùng đã yêu cầu rõ ràng.`,
  inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', ...Object.keys(properties).filter(k => !optional.includes(k))],
    properties: { requestId: REQUEST_ID_PROPERTY, ...properties } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const read = (name, description, properties, required = Object.keys(properties)) => Object.freeze({ name, description,
  inputSchema: { type: 'object', additionalProperties: false, required, properties },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
export const SALE_ACTION_TOOLS = Object.freeze([
  read('crm_sale_room_options', 'Tìm ID/nhãn phòng trong phạm vi quyền thao tác Sale được chọn. Không suy đoán ID khi trùng tên; cho người dùng chọn.',
    { action: { enum: OPTION_ACTIONS }, buildingId: nullableId, query: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: nullableId }, ['action']),
  read('crm_sale_room_observe', 'Lấy phiên bản và thông tin được phép sửa của một phòng ngay trước khi cập nhật. Cần quyền CRM rooms.view hoặc sale_phong.view và quyền thao tác sửa/ảnh trên phòng.',
    { roomId: uuid }),
  write('crm_sale_room_patch', 'Cập nhật thông tin Sale của một phòng theo expectedRevision vừa đọc. Chữ mới công khai phải được người dùng duyệt preview. Ảnh là URL HTTPS đã tải lên; không upload từ máy bằng công cụ này.',
    { roomId: uuid, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{32}$' }, rent_price: moneySchema,
      area: { type: ['number', 'null'], minimum: 0, maximum: 1000000 }, room_type: nullableText(200),
      amenities: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } },
      sale_note: nullableText(2000), sale_bonus_note: nullableText(2000), description: nullableText(2000),
      images: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uri', maxLength: 2048 } },
      confirmToken: { type: 'string', description: 'Chỉ gửi token từ preview sau khi người dùng đồng ý rõ ràng với nguyên văn chữ công khai.' } }, [...SALE_PATCH_FIELDS, 'confirmToken']),
  write('crm_sale_room_lock', 'Lock tạm 6/12/24 giờ; không thu tiền, không tạo cọc, tự hết hạn theo máy chủ.', { roomId: uuid, hours: { enum: [6, 12, 24] }, note: nullableText(300) }),
  write('crm_sale_room_release', 'Gỡ lock bằng ID chính xác; quyền người đã lock hoặc người tạo cọc do CRM kiểm tra.', { lockId: uuid }),
  write('crm_sale_reservation_create', 'Báo cọc có tiền qua bộ ghi CRM. Chọn customerId HOẶC customerHint. Chờ duyệt không có nghĩa đã nhận tiền; chỉ received=true/receivedAmount phản ánh nhận tiền.',
    { roomId: uuid, customerId: nullableId, customerHint: nullableText(120), intendedMoveInOn: nullableDate, topupDueOn: nullableDate,
      depositTarget: { ...moneySchema, type: ['integer', 'null'] }, notes: nullableText(2000), receipt: receiptSchema }),
  write('crm_sale_reservation_update', 'Sửa ngày/hạn/số tiền mục tiêu/ghi chú cọc theo revision hiện tại. Hủy/hoàn tiền/ký hợp đồng dùng giao diện Quản lý cọc.',
    { reservationId: uuid, expectedRevision: { type: 'integer', minimum: 1 }, changes: { type: 'object', additionalProperties: false, minProperties: 1,
      properties: { hold_until: nullableDate, intended_move_in_on: nullableDate, topup_due_on: nullableDate,
        deposit_target: { ...moneySchema, type: ['integer', 'null'] }, notes: nullableText(2000) } } }),
  write('crm_sale_reservation_topup', 'Báo thu thêm vào hồ sơ cọc hiện tại. Không đồng nhất phiếu đã duyệt với tiền đã nhận.',
    { reservationId: uuid, expectedRevision: { type: 'integer', minimum: 1 }, receipt: receiptSchema }),
  write('crm_sale_reservation_assign', 'Gắn khách danh bạ vào cọc đang chỉ có tên gợi nhớ, theo revision hiện tại.', { reservationId: uuid, expectedRevision: { type: 'integer', minimum: 1 }, customerId: uuid }),
  read('crm_sale_action_status', `Đối soát kết quả lệnh Sale bằng requestId. not_found/unknown không chứng minh yêu cầu đã thất bại: không đổi requestId để ghi lại. ${REQUEST_ID_STATUS_GUIDANCE}`, { requestId: uuid }),
]);
