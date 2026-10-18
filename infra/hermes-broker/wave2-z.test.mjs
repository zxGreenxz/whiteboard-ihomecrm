// Imported before broker-dependent modules on purpose (external-group-mount imports broker.mjs back).
import { EXTERNAL_GROUP_TOOLS, externalGroupInput } from './external-group-mount.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL, groupPreviewIntent } from './group-preview-mount.mjs';
import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS } from './task-input-contract.mjs';
import { ROOM_PASS_TOOLS } from './room-pass-contract.mjs';
import { DOMAIN_TOOLS } from './domain-contract.mjs';
import { SCHEDULE_TOOLS } from './schedule-contract.mjs';
import { WORK_MEMORY_TOOLS } from './work-memory-contract.mjs';
import { CUSTOMER_ACTION_TOOLS } from './customer-action-contract.mjs';
import { EXPENSE_ACTION_TOOLS } from './expense-action-contract.mjs';
import { NEW_REQUEST_ID_TOOL } from './request-id-contract.mjs';
import { ZALO_BROADCAST_TOOLS, zaloBroadcastInput } from './zalo-broadcast-contract.mjs';
import { W2, W2_READ_KEY_LIST, W2_ENABLED_KEYS, W2_DISABLED_KEYS, W2_TOOL_NAMES } from './wave2-registry.mjs';
import { W2_RANGES, w2MigrationPaths, w2FenceViolations, w2AllMigrations } from './wave2-sql-paths.mjs';

// Gói Z (tích hợp đợt 2, 18/10/2026) — phép kiểm TĨNH, không PGlite: công tắc khoá, khuôn các file sửa tích hợp, hàng
// rào gói sau khi gộp bốn gói, và rào cấu trúc "báo cáo riêng tư không đi vào tin nhóm". Hành vi SQL của từng bản sửa
// Z đo ở wave2-z-{a,b,c,d}.test.mjs (một PGlite mỗi file).
const DIR = 'supabase/migrations';
const ENABLE = '20261018090000_hermes_w2_enable_v1.sql';
const Z_FIXES = Object.freeze({
  '20261018080000_hermes_w2z_receivables_pii_v1.sql': ['public.thu_tien_collection_v1', 'app_private.hermes_w2a_read_v1'],
  '20261018080100_hermes_w2z_finance_fail_closed_v1.sql': ['app_private.hermes_w2b_read_v1'],
  '20261018080200_hermes_w2z_notifications_org_v1.sql': ['public.notifications_inbox_v1'],
  '20261018080300_hermes_w2z_catalog_fixes_v1.sql': ['public.income_expense_types_list_v1', 'app_private.hermes_w2d_read_v1'],
  '20261018080400_hermes_w2z_report_text_v1.sql': ['public.report_text_v1'],
});
// Bản trước (của gói) mà mỗi hàm Z thay: chữ ký, kiểu trả về, LANGUAGE/volatility/INVOKER/search_path phải giữ nguyên.
const PREVIOUS = Object.freeze({
  'public.thu_tien_collection_v1': '20261018010000_hermes_w2a_receivables_read_v1.sql',
  'app_private.hermes_w2a_read_v1': '20261018010100_hermes_w2a_review_fixes_v1.sql',
  'app_private.hermes_w2b_read_v1': '20261018020300_hermes_w2b_finance_read_fixes_v1.sql',
  'public.notifications_inbox_v1': '20261018030100_hermes_w2c_shared_v1.sql',
  'public.income_expense_types_list_v1': '20261018040000_hermes_w2d_catalog_read_v1.sql',
  'app_private.hermes_w2d_read_v1': '20261018040300_hermes_w2d_reader_fixes_v1.sql',
  'public.report_text_v1': '20261018040200_hermes_w2d_shared_fixes_v1.sql',
});
const sql = name => readFileSync(`${DIR}/${name}`, 'utf8');
const stripComments = text => text.replace(/--[^\n]*/g, '');
const head = (text, fn) => {
  const start = text.lastIndexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  assert.ok(start >= 0, fn);
  return text.slice(start, text.indexOf('AS $fn$', start)).replace(/\s+/g, ' ');
};
const created = text => [...stripComments(text).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi)].map(match => match[1]);

test('công tắc Z: bật đúng khoá đợt 2 có báo cáo (hoặc là khoá phụ của báo cáo); giữ tắt khoá chưa có báo cáo; chỉ UPDATE registry', () => {
  const text = sql(ENABLE), body = stripComments(text);
  const wanted = [...body.match(/wanted constant text\[\] := ARRAY\[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...wanted].sort(), [...W2_ENABLED_KEYS].sort(), 'SQL = W2_ENABLED_KEYS');
  assert.equal(new Set(wanted).size, wanted.length);
  assert.equal(W2_ENABLED_KEYS.length, 32);
  assert.deepEqual([...W2_DISABLED_KEYS].sort(), ['reports_finance.collection_cycle', 'reports_finance.deposits_report', 'reports_finance.handover_report']);
  assert.deepEqual([...W2_ENABLED_KEYS, ...W2_DISABLED_KEYS].sort(), [...W2_READ_KEY_LIST].sort(), 'mọi khoá seed được phân loại');
  const specs = Object.values(W2.reports);
  for (const key of W2_ENABLED_KEYS) assert.ok(specs.some(spec => spec.permission === key || spec.scopeKeys.includes(key)), key);
  assert.deepEqual(W2_ENABLED_KEYS.filter(key => !specs.some(spec => spec.permission === key)), ['income_expenses.restricted_view'],
    'chỉ một khoá bật vì là khoá phụ');
  for (const key of W2_DISABLED_KEYS) assert.ok(!specs.some(spec => spec.permission === key || spec.scopeKeys.includes(key)), key);
  // Chỉ bật cờ: không tạo/đổi hàm, không DROP/GRANT, không chèn dòng; thiếu dòng hoặc thiếu bản sửa Z ⇒ RAISE.
  assert.doesNotMatch(body, /CREATE\s|DROP\s|GRANT\s|REVOKE\s|INSERT\s|DELETE\s|ALTER\s/i);
  assert.match(body, /UPDATE app_private\.hermes_capabilities c SET enabled=true\s+WHERE c\.capability=ANY\(wanted\) AND c\.mode='read' AND NOT c\.enabled;/);
  assert.match(body, /RAISE EXCEPTION 'hermes_w2_enable_missing/);
  for (const marker of ["strpos(p.prosrc,'v_inv_text')>0", "strpos(p.prosrc,'v_ok:=COALESCE(')>0", "strpos(p.prosrc,'n.organization_id IS NULL')=0",
    "strpos(p.prosrc,'nv.ok')>0"]) assert.ok(body.includes(marker), marker);
  // Dấu mà công tắc đòi phải có trong đúng bản sửa Z (bật trên hàm chưa sửa là không được).
  for (const [file, marker] of [['20261018080000_hermes_w2z_receivables_pii_v1.sql', 'v_inv_text'],
    ['20261018080100_hermes_w2z_finance_fail_closed_v1.sql', 'v_ok:=COALESCE('], ['20261018080300_hermes_w2z_catalog_fixes_v1.sql', 'nv.ok']])
    assert.ok(stripComments(sql(file)).includes(marker), `${file}: ${marker}`);
  assert.ok(!stripComments(sql('20261018080200_hermes_w2z_notifications_org_v1.sql')).includes('n.organization_id IS NULL'));
  // Thứ tự áp: bản sửa Z (08xxxx) sau mọi gói, công tắc (09xxxx) cuối cùng.
  const order = w2MigrationPaths().map(path => path.split('/').pop());
  assert.equal(order.at(-1), ENABLE);
  assert.deepEqual(order.slice(-6, -1), Object.keys(Z_FIXES));
  assert.ok(order.indexOf('20261018040300_hermes_w2d_reader_fixes_v1.sql') < order.indexOf(Object.keys(Z_FIXES)[0]));
});

test('bản sửa Z: mỗi file chỉ thay đúng hàm đã nêu; chữ ký, kiểu trả về, INVOKER/search_path giữ như bản trước của gói; không DROP/GRANT/REVOKE', () => {
  for (const [file, fns] of Object.entries(Z_FIXES)) {
    assert.ok(W2_RANGES.z.test(file), file);
    const text = sql(file), body = stripComments(text);
    assert.deepEqual(created(text), fns, file);
    assert.doesNotMatch(body, /\bDROP\b|\bGRANT\b|\bREVOKE\b|SECURITY DEFINER|copilot|\bINSERT\b|\bDELETE\b|UPDATE\s+public\./i, file);
    assert.match(body, /^\s*BEGIN;/m);
    assert.match(body, /^COMMIT;/m);
    for (const fn of fns) {
      assert.equal(head(text, fn), head(sql(PREVIOUS[fn]), fn), `${fn}: dòng đầu như bản trước`);
      assert.match(head(text, fn), /SECURITY INVOKER/);
      assert.ok(body.includes(`ALTER FUNCTION ${fn}(`), `${fn}: chủ hàm postgres`);
    }
  }
});

test('hàng rào gói sau tích hợp: repo sạch; hai gói cùng định nghĩa một hàm dùng chung chỉ qua khi bản cuối ở dải Z', () => {
  assert.deepEqual(w2FenceViolations(w2AllMigrations()), [], 'repo hiện tại (B và D cùng tạo public.report_text_v1, Z chốt bản cuối)');
  const base = w2AllMigrations().filter(({ name }) => name < '20261018010000');
  const fn = name => `CREATE OR REPLACE FUNCTION ${name}(p jsonb) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT p $fn$;`;
  const B = { name: '20261018020000_hermes_w2b_x_v1.sql', sql: fn('public.shared_v1') }, D = { name: '20261018040000_hermes_w2d_x_v1.sql', sql: fn('public.shared_v1') };
  assert.ok(w2FenceViolations([...base, B, D]).length > 0, 'hai gói, chưa chốt');
  assert.deepEqual(w2FenceViolations([...base, B, D, { name: '20261018080400_hermes_w2z_x_v1.sql', sql: fn('public.shared_v1') }]), [], 'Z chốt bản cuối');
  assert.ok(w2FenceViolations([...base, B, { name: '20261018080400_hermes_w2z_x_v1.sql', sql: fn('public.shared_v1') }, D]).length > 0,
    'gói định nghĩa lại SAU bản của Z ⇒ chưa chốt');
  assert.deepEqual(w2FenceViolations([...base, { name: '20261018080000_hermes_w2z_x_v1.sql', sql: fn('app_private.hermes_w2a_read_v1') + fn('public.receivable_aging_v1') }]),
    [], 'Z được thay hàm của gói');
  for (const name of ['20261018080000_hermes_w2z_a_v1.sql', '20261018090000_hermes_w2_enable_v1.sql']) assert.ok(W2_RANGES.z.test(name), name);
  for (const name of ['20261018080000_hermes_w2_a_v1.sql', '20261018090000_hermes_w2z_a_v1.sql', '20261018070000_hermes_w2z_a_v1.sql'])
    assert.ok(!W2_RANGES.z.test(name), name);
});

// Rào "báo cáo riêng tư không vào tin nhóm" (soát lại Gói B/C, 18/10). Đợt 1 KHÔNG có rào runtime đọc cờ private:
// rào là CẤU TRÚC — (1) kênh Zalo cá nhân của Hermes chỉ nhận/gửi DM với đúng người đã ghép (worker/lib/hermes-native-bridge.js,
// infra/hermes-zalo-native/adapter.py); (2) mọi tool đưa tin tới hội thoại/nhóm chỉ nhận ID + tuỳ chọn có khuôn, thân tin do
// broker/SQL dựng từ dữ liệu phòng công khai (group-room-preview.mjs publicFacts, bản tin "Gửi ảnh phòng trống"). Kết quả
// crm_read_report đi cùng đường MCP nên thừa hưởng đúng rào đó. Test này khoá rào: tool mới có đích hội thoại mà nhận chữ tự
// do (đường để mô hình chép kết quả báo cáo vào tin nhóm) sẽ làm đỏ.
const ALL = [...TASK_TOOLS, ...TASK_INPUT_TOOLS, ...ROOM_PASS_TOOLS, ...DOMAIN_TOOLS, ...SCHEDULE_TOOLS, ...WORK_MEMORY_TOOLS, ...CUSTOMER_ACTION_TOOLS,
  ...EXPENSE_ACTION_TOOLS, ...EXTERNAL_GROUP_TOOLS, ...ZALO_BROADCAST_TOOLS, NEW_REQUEST_ID_TOOL, GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL,
  GROUP_SEND_STATUS_TOOL];
const properties = (schema, path = '') => Object.entries(schema?.properties ?? {}).flatMap(([key, value]) => [[`${path}${key}`, value],
  ...properties(value, `${path}${key}.`), ...(value?.items ? [[`${path}${key}[]`, value.items], ...properties(value.items, `${path}${key}[].`)] : [])]);
const TARGET = /(^|\.)(conversationIds?|addConversationIds|removeConversationIds|setConversationIds|threadIds?|groupIds?)(\[\])?$/;
const freeText = value => [].concat(value?.type ?? []).includes('string') && !value.enum && !value.pattern && !value.format && value.const === undefined;
// Ngoại lệ có lý do: múi giờ IANA (schedule-contract kiểm bằng Intl và phải bằng múi giờ công ty), không phải thân tin.
const ALLOWED_TEXT = Object.freeze({ crm_room_schedule_create: ['settings.timeZone'], crm_room_schedule_update: ['settings.timeZone'] });
const U = '11111111-1111-4111-8111-111111111111', V = '22222222-2222-4222-8222-222222222222';

test('rào tin nhóm: tool có đích hội thoại/nhóm không nhận chữ tự do; hai tool báo cáo đợt 2 chỉ đọc, mọi báo cáo riêng tư', () => {
  const delivery = [...new Set(ALL.filter(tool => properties(tool.inputSchema).some(([key]) => TARGET.test(key))).map(tool => tool.name))].sort();
  assert.deepEqual(delivery, ['crm_group_room_preview', 'crm_group_room_send', 'crm_room_schedule_create', 'crm_room_schedule_update',
    'crm_zalo_broadcast_send', 'crm_zalo_broadcast_update'], 'tool có đích hội thoại (thêm tool mới ⇒ xem lại rào này)');
  for (const tool of ALL.filter(value => delivery.includes(value.name))) {
    const loose = properties(tool.inputSchema).filter(([key, value]) => freeText(value) && !(ALLOWED_TEXT[tool.name] ?? []).includes(key)).map(([key]) => key);
    assert.deepEqual(loose, [], `${tool.name}: chỉ ID/enum/mẫu/ngày giờ`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: không nhận trường lạ`);
  }
  for (const name of W2_TOOL_NAMES) {
    const tool = DOMAIN_TOOLS.find(value => value.name === name);
    assert.ok(tool, name);
    assert.ok(!delivery.includes(name));
    assert.ok(!properties(tool.inputSchema).some(([key]) => TARGET.test(key)), `${name}: không có đích hội thoại`);
  }
  assert.ok(Object.values(W2.reports).every(spec => spec.private === true), 'mọi báo cáo đợt 2 riêng tư (PRIVATE_HINT)');
  assert.match(DOMAIN_TOOLS.find(value => value.name === 'crm_read_report').description, /private=true: .*không đăng vào nhóm/);
  // Lúc chạy: bộ kiểm đầu vào của tool gửi nhóm từ chối mọi trường chữ chen thêm (body/message/text).
  assert.deepEqual(externalGroupInput('send', { roomIds: [U], conversationIds: [V], requestId: U }), { roomIds: [U], conversationIds: [V], requestId: U });
  for (const extra of ['body', 'message', 'text', 'caption']) {
    assert.throws(() => externalGroupInput('send', { roomIds: [U], conversationIds: [V], requestId: U, [extra]: 'Doanh thu tháng 10: 1.000.000.000' }), extra);
    assert.throws(() => externalGroupInput('preview', { roomIds: [U], conversationIds: [V], [extra]: 'x' }), extra);
    assert.throws(() => groupPreviewIntent({ roomIds: [U], conversationIds: [V], [extra]: 'x' }), extra);
    assert.throws(() => zaloBroadcastInput('send', { requestId: U, conversationIds: [V], mode: 'full', [extra]: 'x' }), extra);
  }
  assert.deepEqual(zaloBroadcastInput('send', { requestId: U, conversationIds: [V], mode: 'compact' }), { requestId: U, conversationIds: [V], mode: 'compact', runAt: null });
});
