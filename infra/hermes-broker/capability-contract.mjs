import { TASK_ACTION } from './task-contract.mjs';
import { ROOM_PASS_ACTION } from './room-pass-contract.mjs';
import { DOMAIN_READ_CAPABILITIES, DOMAIN_READ_CAPABILITIES_V2 } from './domain-contract.mjs';
import { CUSTOMER_ACTIONS } from './customer-action-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-action-contract.mjs';
import { W2_READ_KEYS } from './wave2-registry.mjs';
// Implemented CRM capabilities only. This is a mode/resource contract, never a
// role grant map. Current grants come exclusively from the CRM resolver; the
// durable authority intersects them with the persisted Hermes overlay.
// resource: 'building' = the SQL intersects a building scope overlay;
// 'organization_scope' = the record has no building, yet SQL still requires a
// selected Toàn tổ chức overlay scope; both therefore need a selected scope.
const BEFORE_W2 = Object.freeze({
  [TASK_ACTION]: Object.freeze({ mode: 'action', resource: 'building' }),
  [ROOM_PASS_ACTION]: Object.freeze({ mode: 'action', resource: 'building' }),
  ...Object.fromEntries(DOMAIN_READ_CAPABILITIES.map(key => [key, Object.freeze({ mode: 'read', resource: 'building' })])),
  // Gói E: thu chi, chỉ số, cọc, lãi lỗ (họ SQL v2) cùng giao scope toà.
  ...Object.fromEntries(DOMAIN_READ_CAPABILITIES_V2.map(key => [key, Object.freeze({ mode: 'read', resource: 'building' })])),
  // Gói E: ghi phiếu chi nhanh; approve chỉ là overlay cho phép writer duyệt
  // lúc sinh bằng quyền duyệt của chính user, không có tool duyệt/vào sổ.
  ...Object.fromEntries(EXPENSE_ACTIONS.map(key => [key, Object.freeze({ mode: 'action', resource: 'building' })])),
  // Khách/lead tạo chưa gắn toà; SQL đòi overlay scope Toàn tổ chức đã chọn.
  ...Object.fromEntries(CUSTOMER_ACTIONS.map(key => [key, Object.freeze({ mode: 'action', resource: 'organization_scope' })])),
  'assistant.context.read': Object.freeze({ mode: 'read', resource: 'self' }),
  'assistant.memory.read': Object.freeze({ mode: 'read', resource: 'self' }),
  'assistant.memory.write': Object.freeze({ mode: 'action', resource: 'self' }),
  // Gói D: theo dõi/huỷ việc dùng chính quyền CRM tasks.edit/tasks.delete;
  // Hermes tổng đọc work memory được chia sẻ là một Read riêng (users.view).
  'tasks.edit': Object.freeze({ mode: 'action', resource: 'building' }),
  'tasks.delete': Object.freeze({ mode: 'action', resource: 'building' }),
  'assistant.memory.supervise': Object.freeze({ mode: 'read', resource: 'organization' }),
  'rooms.view': Object.freeze({ mode: 'read', resource: 'building' }),
  'chat_zalo.view': Object.freeze({ mode: 'read', resource: 'organization' }),
  'chat_zalo.manage_automation': Object.freeze({ mode: 'action', resource: 'organization' }),
  'chat_zalo.send': Object.freeze({ mode: 'action', resource: 'organization' }),
});
// Đợt 2 đọc đầy đủ (20261018000000): mọi khoá đọc mới, seed MỘT lần ở trạng thái tắt; 'self' =
// dữ liệu của chính người hỏi, không cần chọn phạm vi toà (wave2-registry.mjs giải thích từng khoá).
// Một khoá chỉ có một mode/resource: khoá đợt 2 trùng khoá đã khai ⇒ lỗi khi nạp module.
const duplicate = Object.keys(W2_READ_KEYS).find(key => Object.hasOwn(BEFORE_W2, key));
if (duplicate) throw new TypeError(`hermes_capability_duplicate:${duplicate}`);
export const HERMES_CAPABILITIES = Object.freeze({ ...BEFORE_W2,
  ...Object.fromEntries(Object.entries(W2_READ_KEYS).map(([key, resource]) => [key, Object.freeze({ mode: 'read', resource })])) });
export const HERMES_READ_CAPABILITIES = Object.freeze(Object.keys(HERMES_CAPABILITIES).filter(key => HERMES_CAPABILITIES[key].mode === 'read'));
export const HERMES_ACTION_CAPABILITIES = Object.freeze(Object.keys(HERMES_CAPABILITIES).filter(key => HERMES_CAPABILITIES[key].mode === 'action'));
export const requiresBuildingScope = (read, action = []) => [...read, ...action].some(key =>
  ['building', 'organization_scope'].includes(HERMES_CAPABILITIES[key]?.resource));
export function mayUseGroupTool(effective, operation) {
  if (!effective?.read?.includes('chat_zalo.view')) return false;
  if (operation === 'directory' || operation === 'status') return true;
  if (!effective.read.includes('rooms.view')) return false;
  return operation === 'preview' || operation === 'send' && effective.action?.includes('chat_zalo.send') === true;
}
