// Hermes upstream has no UUID tool; without one a model improvises the
// idempotency key (native terminal, endless argument loops). The connector
// mints it instead (broker.mjs). Stateless: an issued id is never stored,
// reserved or bound. Each action keeps its own UUID validation, idempotency and
// UNKNOWN_EFFECT reconciliation for whatever requestId it receives.
// Pure data: capability-contract.mjs reaches this file from the browser bundle,
// so it must not import node built-ins.
export const REQUEST_ID_GUIDANCE = 'Lấy requestId bằng `crm_new_request_id` MỘT lần cho mỗi lệnh mới; dùng lại đúng mã đó khi thử lại hoặc tra trạng thái; không tự tạo mã, không dùng lại mã của lệnh khác.';
export const REQUEST_ID_STATUS_GUIDANCE = 'Truyền đúng requestId của lệnh gốc; không lấy mã mới bằng `crm_new_request_id` để tra.';
// Same UUID schema as before; only the model-facing description is added.
export const REQUEST_ID_PROPERTY = Object.freeze({ type: 'string', format: 'uuid',
  description: 'Mã lấy từ crm_new_request_id cho đúng lệnh này; giữ nguyên khi thử lại hoặc tra trạng thái.' });
export const NEW_REQUEST_ID_TOOL = Object.freeze({
  name: 'crm_new_request_id',
  description: 'Cấp một requestId mới (UUID v4 ngẫu nhiên) cho MỘT lệnh CRM sắp gửi. Không đọc hay ghi CRM, không lưu mã. Gọi một lần cho mỗi lệnh mới; khi thử lại hoặc tra trạng thái thì dùng lại mã cũ. Không dùng terminal hay công cụ khác để tự tạo mã.',
  inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
});
// A listed tool that starts a new idempotent CRM command: it requires requestId
// and is not a *_status reconciliation of an existing command.
export const startsCrmRequest = tool => Array.isArray(tool?.inputSchema?.required) &&
  tool.inputSchema.required.includes('requestId') && typeof tool.name === 'string' && !tool.name.endsWith('_status');
