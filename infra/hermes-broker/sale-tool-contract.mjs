// One public Sale tool keeps the fixed MCP catalogue bounded. Operation schemas
// are discovered on demand; each operation still uses its existing validator,
// authorization, canonical RPC, request receipt and uncertainty handling.
import { SALE_ACTION_TOOLS } from './sale-action-contract.mjs';
import { SALE_POLICY_TOOLS } from './sale-policy-contract.mjs';
import { SALE_BULK_TOOLS } from './sale-bulk-contract.mjs';

export const SALE_TOOL = Object.freeze({
  name: 'crm_sale_action',
  description: 'Sale phòng: cập nhật, lock, cọc, chính sách (room sale). operation=list lấy thao tác và khuôn input được cấp; sau đó dùng đúng operation/input. requestId lấy từ crm_new_request_id, giữ nguyên khi thử lại/tra trạng thái. confirmation_required: chỉ gửi lại input kèm confirmToken khi người dùng đồng ý preview. unknown: tra thao tác status tương ứng, không tạo mã mới.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { type: 'string', maxLength: 40 }, input: { type: 'object' },
  } },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
});
const tools = [...SALE_ACTION_TOOLS, ...SALE_POLICY_TOOLS, ...SALE_BULK_TOOLS];
const operations = new Map(tools.map(tool => [tool.name.slice('crm_sale_'.length), tool]));
export const saleToolOperation = tool => tool.name.slice('crm_sale_'.length);
export const saleToolDefinition = operation => typeof operation === 'string' ? operations.get(operation) : undefined;
export const isInternalSaleTool = name => tools.some(tool => tool.name === name);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export function saleToolInput(value) {
  if (!record(value) || Object.keys(value).some(key => !['operation', 'input'].includes(key)) ||
      !(value.operation === 'list' || saleToolDefinition(value.operation)) ||
      (Object.hasOwn(value, 'input') && !record(value.input))) throw new TypeError('invalid_sale_tool');
  const input = value.input ?? {};
  if (value.operation === 'list' && Object.keys(input).length) throw new TypeError('invalid_sale_tool');
  return { operation: value.operation, input };
}
const bridgeNames = text => tools.reduce((result, tool) => result.replaceAll(tool.name,
  `${SALE_TOOL.name} operation=${saleToolOperation(tool)}`), text);
export const saleToolListing = granted => ({ operations: granted.map(tool => ({
  operation: saleToolOperation(tool), description: bridgeNames(tool.description),
  inputSchema: structuredClone(tool.inputSchema), annotations: { ...tool.annotations },
})) });
export function saleToolResult(result, operation) {
  return result?.outcome === 'confirmation_required'
    ? { ...result, tool: SALE_TOOL.name, operation }
    : result;
}
