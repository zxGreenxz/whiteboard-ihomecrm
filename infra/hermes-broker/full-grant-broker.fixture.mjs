// Broker của một kết nối giữ MỌI khoá cấp được (đọc + ghi) với một toà trong mọi phạm vi — dùng chung cho phép đo byte
// tools/list (tool-argument-shape.test.mjs) và test kế hoạch tool T4 (tool-plan.test.mjs, R2b 21/10/2026). Cổng giả không
// gọi SQL: prepare ghi [operation, input, names] vào `seen` (names chỉ có ở tool đọc khi mô hình gửi tên toà/phòng) rồi trả
// biên nhận rỗng đông cứng; finalize trả { ok: true }.
// external-group-mount.mjs nạp TRƯỚC broker.mjs: nó import ngược broker.mjs, broker không được đọc mảng tool khi module
// còn đang nạp.
import { EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { ALL_DOMAIN_READ_CAPABILITIES } from './domain-contract.mjs';
import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';

void EXTERNAL_GROUP_TOOLS;
export const fullGrantId = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
export const FULL_GRANT_BUILDING = fullGrantId('f');
export const FULL_GRANT_ORGANIZATION = fullGrantId('d');
export const FULL_GRANT_READ = Object.freeze([...new Set([...HERMES_READ_CAPABILITIES, ...ALL_DOMAIN_READ_CAPABILITIES, 'chat_zalo.view', 'rooms.view',
  'assistant.context.read', 'assistant.memory.read'])]);
export const FULL_GRANT_ACTION = Object.freeze([...new Set([...HERMES_ACTION_CAPABILITIES, 'tasks.create', 'tasks.edit', 'tasks.delete',
  'sale_phong.manage_pass_listings', 'customers.create', 'leads.create', 'income_expenses.create', 'chat_zalo.manage_automation', 'chat_zalo.send',
  'assistant.memory.write'])]);

/** { broker, token, seen }: `t` đóng dependency scope khi test xong; `limits` như createBroker.
 * `actions` (Đợt 1 nền chung): lõi thao tác ghi dùng chung (action-runtime.mjs) + `actionKeys` cấp thêm cho kết nối;
 * `withoutAction`: khoá Action bỏ khỏi kết nối (vd khoá đang tắt ở registry production). */
export function fullGrantBroker(t, limits = { maxResultBytes: 65_536 }, { actions, actionKeys = [], withoutAction = [] } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const CONNECTION = fullGrantId('a'), read = [...FULL_GRANT_READ], seen = [];
  const action = [...new Set([...FULL_GRANT_ACTION, ...actionKeys])].filter(key => !withoutAction.includes(key));
  const identity = { row: { id: CONNECTION, assistantId: fullGrantId('b'), userId: fullGrantId('c'), organizationId: FULL_GRANT_ORGANIZATION,
    expiresAt: Date.now() + 600_000, epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [fullGrantId('e')],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [FULL_GRANT_BUILDING], cashbookIds: [] }])) };
  const authority = { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} };
  const port = (prepare, finalize) => ({
    async [prepare](_token, operation, input, options) {
      seen.push(options?.names ? [operation, input, options.names] : [operation, input]);
      return Object.freeze({});
    },
    async [finalize]() { return { ok: true }; },
  });
  const broker = createBroker({ authority, dependencyScope: scope, audit: async () => {}, limits,
    tasks: port('prepareTask', 'finalizeTask'), domains: port('prepareDomain', 'finalizeDomain'), roomPass: port('prepareRoomPass', 'finalizeRoomPass'),
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast'), roomReads: port('prepareAvailableRooms', 'finalizeAvailableRooms'),
    externalGroups: { authority, createService: () => ({}) },
    ...(actions ? { actions } : {}),
    // Host-only private port (never in tools/list): a directory result of a few hundred bytes.
    groupPreviews: { authority, createService: () => ({ async prepareGroupDirectory() { return Object.freeze({}); },
      async finalizeGroupDirectory() { return { groups: ['1', '2', '3', '4'].map(n => ({ conversationId: fullGrantId(n), name: `Nhóm ${n}` })) }; } }) } });
  return { broker, token: `hc_${'A'.repeat(43)}`, seen };
}
