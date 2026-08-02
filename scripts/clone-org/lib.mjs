/**
 * Hằng số + helper dùng chung cho bộ nhân bản công ty TEST.
 *
 * Bản sao là ORG THỨ 3 trong cùng project Supabase: mọi dòng đều mang
 * organization_id = TEST_ORG nên xoá sạch được bằng một predicate duy nhất.
 *
 * ĐỌC KỸ TRƯỚC KHI SỬA:
 *  - Tiền tố tài khoản KHÔNG được là 'demo.' — public.demo_reset() xoá dữ liệu của
 *    MỌI user khớp 'demo.%@username.ihomecrm.local'. Đặt tên demo. = công ty test
 *    bị xoá trắng ở lần bấm "reset demo" kế tiếp.
 *  - Không bao giờ đưa user test vào super_admins (policy admin xuyên tenant).
 */
import { runSql as rawRunSql, gotrueAdmin, getServiceKey, sqlLit, REF, REPO } from '../docs-demo/lib.mjs'

export { gotrueAdmin, getServiceKey, sqlLit, REF, REPO }

/**
 * Management API /database/query bị throttle (~60 req/phút). Bộ nhân bản bắn
 * hàng trăm câu nên phải tự ga: giãn tối thiểu 1,1s/request + lùi dần khi dính 429.
 * Đừng gọi thẳng rawRunSql trong thư mục này.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastCall = 0
export async function runSql(sql, { tries = 8 } = {}) {
  for (let i = 0; ; i++) {
    const wait = 1100 - (Date.now() - lastCall)
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    try {
      return await rawRunSql(sql)
    } catch (e) {
      const throttled = /HTTP 429|ThrottlerException/.test(String(e.message))
      if (!throttled || i >= tries) throw e
      const backoff = 5000 * (i + 1)
      console.error(`  … 429, chờ ${backoff / 1000}s rồi thử lại (${i + 1}/${tries})`)
      await sleep(backoff)
    }
  }
}

export const REAL_ORG = 'aaaa0000-0000-4000-8000-000000000001'
export const TEST_ORG = 'cccc0000-0000-4000-8000-000000000001'
export const TEST_ORG_SLUG = 'ihome-test'
export const TEST_ORG_NAME = 'iHome CRM (Test)'

export const PREFIX = 'test.'
const LOCAL_DOMAIN = '@username.ihomecrm.local'

/** 4 tài khoản của org thật → 4 tài khoản test tương ứng (giữ nguyên member_type). */
export const USERS = [
  { realEmail: 'nguyentamca165@gmail.com', username: `${PREFIX}nguyentamca165`, fullName: 'TEST Nguyễn Tâm' },
  { realEmail: `nathan${LOCAL_DOMAIN}`, username: `${PREFIX}nathan`, fullName: 'TEST Nathan' },
  { realEmail: `joey${LOCAL_DOMAIN}`, username: `${PREFIX}joey`, fullName: 'TEST Joey' },
  { realEmail: `bosshuy${LOCAL_DOMAIN}`, username: `${PREFIX}bosshuy`, fullName: 'TEST Boss Huy' },
]
export const testEmail = (u) => `${u.username}${LOCAL_DOMAIN}`

/** Cột mã có UNIQUE INDEX TOÀN CỤC (không kèm organization_id) → phải thêm hậu tố. */
export const CODE_SUFFIX = '-T'
export const GLOBAL_UNIQUE_CODE_COLS = {
  accounts: ['code'],
  cash_handovers: ['code'],
  contracts: ['public_code'],
  deposits: ['code'],
  document_templates: ['code'],
  invoices: ['invoice_number'],
  jobs: ['code'],
  material_adjustments: ['code'],
  material_purchases: ['code'],
  material_usages: ['code'],
  meter_readings: ['reading_code'],
}

/**
 * Cột uuid trỏ auth.users có UNIQUE TOÀN CỤC: nếu user gốc không nằm trong bộ 4
 * tài khoản được nhân bản thì phải để NULL, giữ nguyên là đụng unique ngay.
 */
export const STRICT_USER_COLS = {
  shareholders: ['auth_user_id'],
  profit_managers: ['auth_user_id'],
}

/** Bảng KHÔNG chép. Lý do ghi cạnh từng nhóm — đừng bỏ lý do khi thêm bảng mới. */
export const SKIP_TABLES = new Set([
  // Kênh gửi ra ngoài — worker/index.js quét zalo_send_queue KHÔNG lọc org ⇒ chép là nhắn khách thật
  'zalo_accounts', 'zalo_automations', 'zalo_conversations', 'zalo_labels',
  'zalo_message_templates', 'zalo_messages', 'zalo_send_queue',
  'notifications', 'notification_logs', 'notification_preferences', 'notification_templates',
  'push_subscriptions', 'push_send_log',
  // Nhật ký / audit — vô nghĩa khi nhân bản, chiếm 2/3 số dòng
  'invoice_audit_log', 'income_expense_audit_log', 'authorization_audit_events',
  'accounting_repair_audit', 'income_expense_type_merge_audit', 'accounting_integrity_exceptions',
  'income_expense_type_reference_repair_audit', 'authorization_migration_exceptions',
  'ai_write_audit', 'cron_runs', 'salary_award_errors',
  // Trang công khai — chép là sinh link công khai cho dữ liệu test
  'public_room_events', 'public_room_settings', 'public_room_share_tokens',
  'room_pass_listings', 'lucky_events', 'lucky_event_teams',
  // AI (tốn quota thật, cấu hình theo user)
  'ai_chat_messages', 'ai_chat_threads', 'ai_providers', 'ai_usage_logs',
  'ai_copilot_settings', 'ai_copilot_entitlements',
  // Hạ tầng demo / bootstrap — tuyệt đối không đụng
  'demo_reset_tables', 'demo_reset_log', 'super_admins', 'legacy_owner_organization_map',
  'legacy_owner_allowlist', 'permission_definitions', 'organizations', 'organization_invitations',
  // profiles do create-users.mjs dựng riêng (id = auth user id, không sinh ngẫu nhiên được)
  'profiles',
])

/** Bảng có dòng organization_id IS NULL: nhận thêm dòng theo cha đã vào idmap. */
export const NULL_ORG_PARENTS = {
  inspection_photos: ['session_id'],
  inspection_sessions: ['user_id', 'building_id', 'job_id'],
  building_fee_accounts: ['building_id', 'user_id'],
  material_usages: ['user_id', 'job_id'],
  material_usage_items: ['usage_id'],
  cash_handovers: ['giver_id', 'receiver_id'],
  cash_handover_items: ['handover_id'],
  salary_attendance_day: ['user_id'],
  settings: ['user_id'],
  profit_managers: ['user_id', 'auth_user_id'],
  profit_manager_salaries: ['user_id', 'manager_id'],
  profit_manager_salary_buildings: ['user_id', 'salary_id'],
}

export const isSkipped = (t) => SKIP_TABLES.has(t) || t.startsWith('network_')

/**
 * 2 trigger được khai ENABLE ALWAYS ⇒ VẪN CHẠY trong session_replication_role
 * ='replica' (replica chỉ tắt trigger 'O'). Chúng cấm INSERT/DELETE trên rule set
 * đã publish, nên chặn cả chép lẫn dọn.
 *
 * Tắt/bật NGAY TRONG CÙNG TRANSACTION: guard không bao giờ hở ra ngoài giao dịch
 * này, và transaction hỏng thì trạng thái trigger tự quay về. Bật lại phải là
 * ENABLE ALWAYS — ENABLE thường sẽ hạ tgenabled về 'O' và làm hỏng guard.
 */
const ALWAYS_TRIGGERS = [
  { tbl: 'approval_rule_sets', tg: 'a00_rule_set_immutable' },
  { tbl: 'approval_rules', tg: 'a00_rules_immutable' },
]

/** Bọc các câu lệnh trong 1 transaction replica-mode, tự xử 2 trigger ALWAYS. */
export function txWrap(stmts) {
  const body = Array.isArray(stmts) ? stmts.join('\n') : stmts
  const touched = ALWAYS_TRIGGERS.filter((t) => new RegExp(`public\\.${t.tbl}\\b`).test(body))
  const off = touched.map((t) => `ALTER TABLE public.${t.tbl} DISABLE TRIGGER ${t.tg};`).join('\n')
  const on = touched.map((t) => `ALTER TABLE public.${t.tbl} ENABLE ALWAYS TRIGGER ${t.tg};`).join('\n')
  return [
    'BEGIN;',
    "SET LOCAL session_replication_role = 'replica';",
    off,
    body,
    on,
    'COMMIT;',
  ].filter(Boolean).join('\n')
}

/** Danh sách bảng nghiệp vụ sẽ chép — sinh từ catalog, KHÔNG hardcode. */
export async function cloneTables() {
  const rows = await runSql(`
    SELECT c.table_name AS tbl,
           bool_or(c.column_name = 'id' AND c.data_type = 'uuid') AS has_uuid_id
    FROM information_schema.columns c
    JOIN pg_class t ON t.relname = c.table_name
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    WHERE c.table_schema = 'public' AND t.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM information_schema.columns o
                  WHERE o.table_schema = 'public' AND o.table_name = c.table_name
                    AND o.column_name = 'organization_id')
    GROUP BY c.table_name
    ORDER BY c.table_name;
  `)
  return rows.filter((r) => !isSkipped(r.tbl)).map((r) => ({ tbl: r.tbl, hasUuidId: r.has_uuid_id }))
}

/** Cột thật của một bảng (bỏ generated column — khuôn của public.demo_reset()). */
export async function tableColumns(tables) {
  const list = tables.map((t) => `'${t}'`).join(',')
  const rows = await runSql(`
    SELECT table_name AS tbl, column_name AS col, data_type AS typ, udt_name AS udt
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (${list}) AND is_generated = 'NEVER'
      AND is_identity = 'NO'
    ORDER BY table_name, ordinal_position;
  `)
  const out = {}
  for (const r of rows) (out[r.tbl] ??= []).push({ col: r.col, typ: r.typ, udt: r.udt })
  return out
}

export const log = (...a) => console.log(...a)
export const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }
