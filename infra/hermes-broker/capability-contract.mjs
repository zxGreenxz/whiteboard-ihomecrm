import { TASK_ACTION } from './task-contract.mjs';
import { ROOM_PASS_ACTION } from './room-pass-contract.mjs';
import { DOMAIN_READ_CAPABILITIES } from './domain-contract.mjs';
// Implemented CRM capabilities only. This is a mode/resource contract, never a
// role grant map. Current grants come exclusively from the CRM resolver; the
// durable authority intersects them with the persisted Hermes overlay.
export const HERMES_CAPABILITIES = Object.freeze({
  [TASK_ACTION]: Object.freeze({ mode: 'action', resource: 'building' }),
  [ROOM_PASS_ACTION]: Object.freeze({ mode: 'action', resource: 'building' }),
  ...Object.fromEntries(DOMAIN_READ_CAPABILITIES.map(key => [key, Object.freeze({ mode: 'read', resource: 'building' })])),
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
export const HERMES_READ_CAPABILITIES = Object.freeze(Object.keys(HERMES_CAPABILITIES).filter(key => HERMES_CAPABILITIES[key].mode === 'read'));
export const HERMES_ACTION_CAPABILITIES = Object.freeze(Object.keys(HERMES_CAPABILITIES).filter(key => HERMES_CAPABILITIES[key].mode === 'action'));
export const requiresBuildingScope = (read, action = []) => [...read, ...action].some(key => HERMES_CAPABILITIES[key]?.resource === 'building');
export function mayUseGroupTool(effective, operation) {
  if (!effective?.read?.includes('chat_zalo.view')) return false;
  if (operation === 'directory' || operation === 'status') return true;
  if (!effective.read.includes('rooms.view')) return false;
  return operation === 'preview' || operation === 'send' && effective.action?.includes('chat_zalo.send') === true;
}
