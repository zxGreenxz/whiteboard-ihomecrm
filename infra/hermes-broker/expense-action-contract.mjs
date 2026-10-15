import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';
// Hermes "Báo chi nhanh": one EXPENSE voucher through the canonical CRM writer.
// income_expenses.create is the tool grant. income_expenses.approve is only an
// overlay: without it SQL refuses a voucher the writer would approve at birth
// through the maker's own approve permission. No approve/post tool exists here.
export const EXPENSE_ACTION = 'income_expenses.create';
export const EXPENSE_APPROVE_OVERLAY = 'income_expenses.approve';
export const EXPENSE_ACTIONS = Object.freeze([EXPENSE_ACTION, EXPENSE_APPROVE_OVERLAY]);
const OPERATIONS = Object.freeze({ 'expense.options': 'options', 'expense.create': 'create', 'expense.status': 'status' });
const TOOL_OPERATIONS = Object.freeze({ crm_expense_input_options: 'expense.options', crm_expense_create: 'expense.create', crm_expense_status: 'expense.status' });
const KINDS = Object.freeze(['buildings', 'rooms', 'categories', 'cashbooks']);
const MAX_VND = 9_999_999_999_999;
const fail = () => { throw new TypeError('invalid_expense_action'); };
const clean = (value, max) => typeof value === 'string' && value.length >= 1 && [...value].length <= max && !/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= '2100-12-31';
const vnd = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_VND;
const amountText = value => typeof value === 'string' && /^\d{1,13}(?:\.\d{1,2})?$/.test(value);
export const expenseActionOperation = name => Object.hasOwn(TOOL_OPERATIONS, name) ? TOOL_OPERATIONS[name] : undefined;
export const expenseSqlOperation = operation => Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : undefined;
export const mayUseExpenseAction = (effective, operation) => Object.hasOwn(OPERATIONS, operation) && effective?.action?.includes(EXPENSE_ACTION) === true;
export function expenseActionInput(operation, input) {
  if (operation === 'expense.options') {
    if (!domainExact(input, Object.keys(input ?? {})) || Object.keys(input).some(key => !['kind', 'buildingId', 'query', 'limit', 'cursor'].includes(key))) fail();
    const value = { kind: null, buildingId: null, query: '', limit: 20, cursor: null, ...input };
    if (!KINDS.includes(value.kind) || !(value.kind === 'rooms' ? domainId(value.buildingId) : value.buildingId === null) ||
        typeof value.query !== 'string' || [...value.query].length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(value.query) ||
        !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50 || !(value.cursor === null || domainId(value.cursor))) fail();
    return { kind: value.kind, buildingId: value.buildingId, query: value.query.trim(), limit: value.limit, cursor: value.cursor };
  }
  if (operation === 'expense.status') {
    if (!domainExact(input, ['requestId']) || !domainId(input.requestId)) fail();
    return { requestId: input.requestId };
  }
  if (operation !== 'expense.create' || !domainExact(input, ['requestId', 'buildingId', 'roomId', 'cashbookId', 'voucherDate', 'name', 'vendor', 'lines']) ||
      !domainId(input.requestId) || !domainId(input.buildingId) || !(input.roomId === null || domainId(input.roomId)) || !domainId(input.cashbookId) ||
      !date(input.voucherDate) || !clean(input.name, 200) || input.name.trim() !== input.name || !(input.vendor === null || clean(input.vendor, 100)) ||
      !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) fail();
  const lines = input.lines.map(line => {
    if (!domainExact(line, ['categoryId', 'amount', 'description']) || !domainId(line.categoryId) || !vnd(line.amount) ||
        !(line.description === null || clean(line.description, 200))) fail();
    return { categoryId: line.categoryId, amount: line.amount, description: line.description };
  });
  if (lines.reduce((sum, line) => sum + line.amount, 0) > MAX_VND) fail();
  return { requestId: input.requestId, buildingId: input.buildingId, roomId: input.roomId, cashbookId: input.cashbookId,
    voucherDate: input.voucherDate, name: input.name, vendor: input.vendor, lines };
}
export function expenseActionResult(operation, value, identity, input) {
  if (operation === 'expense.options') {
    if (!domainExact(value, ['organizationId', 'kind', 'buildingId', 'items', 'nextCursor']) || value.organizationId !== identity.row.organizationId ||
        value.kind !== input.kind || value.buildingId !== input.buildingId || !Array.isArray(value.items) || value.items.length > input.limit ||
        value.items.some((item, index) => !domainExact(item, ['id', 'label']) || !domainId(item.id) || !clean(item.label, 200) ||
          item.id <= (index ? value.items[index - 1].id : input.cursor ?? '') || item.kind !== undefined) ||
        !(value.nextCursor === null || value.nextCursor === value.items.at(-1)?.id && value.items.length === input.limit)) fail();
    // A cashbook label must never carry an account-number-like digit run.
    if (input.kind === 'cashbooks' && value.items.some(item => /\d{5,}/.test(item.label))) fail();
    return { ...value, items: value.items.map(item => ({ ...item })) };
  }
  if (!['expense.create', 'expense.status'].includes(operation) || !domainExact(value, ['organizationId', 'requestId', 'outcome', 'voucher']) ||
      value.organizationId !== identity.row.organizationId || value.requestId !== input.requestId || !['applied', 'not_found', 'unknown'].includes(value.outcome)) fail();
  if (value.outcome !== 'applied') { if (operation !== 'expense.status' || value.voucher !== null) fail(); return { ...value }; }
  const v = value.voucher;
  if (!domainExact(v, ['id', 'code', 'buildingId', 'roomId', 'cashbookId', 'voucherDate', 'totalAmount', 'approvalStatus', 'lineCount', 'createdBy']) ||
      !domainId(v.id) || !(v.code === null || clean(v.code, 200)) || !domainId(v.buildingId) || !(v.roomId === null || domainId(v.roomId)) ||
      !domainId(v.cashbookId) || !date(v.voucherDate) || !amountText(v.totalAmount) || !['UNAPPROVED', 'APPROVED'].includes(v.approvalStatus) ||
      !Number.isSafeInteger(v.lineCount) || v.lineCount < 1 || v.lineCount > 20 || v.createdBy !== identity.row.userId) fail();
  if (operation === 'expense.create' && (v.buildingId !== input.buildingId || v.roomId !== input.roomId || v.cashbookId !== input.cashbookId ||
      v.voucherDate !== input.voucherDate || v.lineCount !== input.lines.length ||
      Number(v.totalAmount) !== input.lines.reduce((sum, line) => sum + line.amount, 0))) fail();
  return { ...value, voucher: { ...v } };
}
const uuid = { type: 'string', format: 'uuid' };
export const EXPENSE_ACTION_TOOLS = Object.freeze([
  Object.freeze({ name: 'crm_expense_input_options', description: 'Lấy ID/nhãn toà, phòng, hạng mục chi, sổ quỹ dùng được để ghi phiếu chi nhanh theo quyền Thao tác của bạn; chỉ là nhãn, không phải dữ liệu đọc.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { enum: KINDS }, buildingId: { type: ['string', 'null'], format: 'uuid' },
      query: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: ['string', 'null'], format: 'uuid' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }),
  Object.freeze({ name: 'crm_expense_create', description: `Ghi MỘT phiếu CHI nhanh (như Báo chi nhanh) qua writer CRM. Trạng thái do thang duyệt/bộ máy chi CRM quyết: UNAPPROVED = chờ duyệt; Hermes không duyệt hay vào sổ. Số tiền là số nguyên VND. ${REQUEST_ID_GUIDANCE} Mất phản hồi chỉ gọi crm_expense_status, không tạo lại. Chỉ gọi khi người dùng yêu cầu ghi rõ ràng; chỉ soạn thì không gọi.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'buildingId', 'roomId', 'cashbookId', 'voucherDate', 'name', 'vendor', 'lines'], properties: {
      requestId: REQUEST_ID_PROPERTY, buildingId: uuid, roomId: { type: ['string', 'null'], format: 'uuid' }, cashbookId: uuid,
      voucherDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, name: { type: 'string', minLength: 1, maxLength: 200 },
      vendor: { type: ['string', 'null'], maxLength: 100 },
      lines: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['categoryId', 'amount', 'description'], properties: {
        categoryId: uuid, amount: { type: 'integer', minimum: 1, maximum: MAX_VND }, description: { type: ['string', 'null'], maxLength: 200 } } } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }),
  Object.freeze({ name: 'crm_expense_status', description: `Đối soát requestId đã dùng cho crm_expense_create. not_found hoặc unknown KHÔNG cho phép tạo phiếu bằng requestId mới (yêu cầu cũ có thể vẫn đang ghi); nếu cần thử lại chỉ gọi lại crm_expense_create với CÙNG requestId và cùng nội dung — CRM không ghi trùng một requestId. ${REQUEST_ID_STATUS_GUIDANCE}`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: uuid } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }),
]);
