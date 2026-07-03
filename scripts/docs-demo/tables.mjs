/**
 * NGUỒN CHUNG danh sách bảng demo + predicate — dùng cho: cleanup-demo.mjs,
 * snapshot-capture.mjs, setup-reset-infra.mjs (seed bảng config demo_reset_tables),
 * verify-baseline.mjs. THỨ TỰ = thứ tự DELETE (con FK trước, cha sau);
 * RESTORE chạy NGƯỢC thứ tự này.
 *
 * Predicate tham chiếu 2 temp table do PREP tạo:
 *   _du(id) = auth.users demo (email demo.%@username.ihomecrm.local)
 *   _db(id) = buildings thuộc demo owner ∪ demo_snapshot.buildings (nếu có)
 *
 * restore=false: bảng ephemeral — reset chỉ XOÁ, không khôi phục từ snapshot.
 *
 * LƯU Ý FK vòng (P3+): cash_handovers.transfer_expense_id → income_expenses và
 * income_expenses.handover_transfer_id → cash_handovers. Thứ tự delete (handovers
 * trước IE) ổn; thứ tự RESTORE (IE trước handovers) sẽ vỡ nếu IE trong snapshot có
 * handover_transfer_id NOT NULL — khi P3 seed handover phải restore IE với cột đó
 * NULL rồi UPDATE sau (chưa cần ở P0.5).
 */
// PREP cho các SCRIPT (cleanup/capture/verify): nhận diện demo qua email + code.
// (Riêng function demo_reset() tự build _db union demo_snapshot.buildings bằng
// dynamic SQL có to_regclass guard — plain SQL không guard được bảng chưa tồn tại.)
export const PREP_NO_SNAPSHOT = `
CREATE TEMP TABLE _du ON COMMIT DROP AS
  SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
CREATE TEMP TABLE _db ON COMMIT DROP AS
  SELECT id FROM buildings WHERE user_id IN (SELECT id FROM _du) OR code LIKE 'DEMO%';
`

const DU = `(SELECT id FROM _du)`
const DB = `(SELECT id FROM _db)`
const DEMO_CONTRACTS = `(SELECT id FROM contracts WHERE user_id IN ${DU})`
const DEMO_INVOICES = `(SELECT id FROM invoices WHERE user_id IN ${DU})`

export const RESET_TABLES = [
  // ===== SỔ QUỸ / TIỀN (con trước) =====
  { tbl: 'cashbook_reconciliations', predicate: `proposed_by IN ${DU} OR counterparty_id IN ${DU} OR account_id IN (SELECT id FROM accounts WHERE user_id IN ${DU})`, restore: true },
  { tbl: 'cash_handovers', predicate: `giver_id IN ${DU} OR receiver_id IN ${DU}`, restore: true },
  { tbl: 'income_expense_items', predicate: `income_expense_id IN (SELECT id FROM income_expenses WHERE user_id IN ${DU})`, restore: true },
  { tbl: 'income_expenses', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'payments', predicate: `user_id IN ${DU} OR invoice_id IN ${DEMO_INVOICES}`, restore: true },
  { tbl: 'invoice_items', predicate: `invoice_id IN ${DEMO_INVOICES}`, restore: true },
  { tbl: 'invoices', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'excess_amounts', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'meter_readings', predicate: `user_id IN ${DU} OR building_id IN ${DB}`, restore: true },
  // ===== VÒNG ĐỜI HĐ (con của contracts trước) =====
  { tbl: 'contract_terminations', predicate: `contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contract_extensions', predicate: `contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contract_transfers', predicate: `user_id IN ${DU} OR contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contract_services', predicate: `contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contract_tenants', predicate: `contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contract_customers', predicate: `contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'deposits', predicate: `user_id IN ${DU} OR contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'vehicles', predicate: `user_id IN ${DU} OR contract_id IN ${DEMO_CONTRACTS}`, restore: true },
  { tbl: 'contracts', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'tenants', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'customers', predicate: `user_id IN ${DU}`, restore: true },
  // ===== LEAD / VẬN HÀNH =====
  { tbl: 'lead_activities', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'leads', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'jobs', predicate: `user_id IN ${DU} OR building_id IN ${DB}`, restore: true },
  { tbl: 'notifications', predicate: `user_id IN ${DU}`, restore: false },
  // ===== KHO / TÀI SẢN =====
  { tbl: 'material_purchases', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'material_usages', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'material_adjustments', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'materials', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'asset_movements', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'asset_maintenance', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'asset_handovers', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'assets', predicate: `user_id IN ${DU}`, restore: true },
  // ===== NHÂN SỰ / CẤU TRÚC =====
  { tbl: 'staff_assignments', predicate: `user_id IN ${DU} OR staff_id IN ${DU}`, restore: true },
  { tbl: 'team_members', predicate: `user_id IN ${DU} OR member_id IN ${DU}`, restore: true },
  { tbl: 'teams', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'meters', predicate: `user_id IN ${DU} OR building_id IN ${DB}`, restore: true },
  { tbl: 'building_services', predicate: `building_id IN ${DB}`, restore: true },
  { tbl: 'service_quotas', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'services', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'rooms', predicate: `building_id IN ${DB}`, restore: true },
  { tbl: 'floors', predicate: `user_id IN ${DU} OR building_id IN ${DB}`, restore: true },
  { tbl: 'area_buildings', predicate: `user_id IN ${DU} OR building_id IN ${DB}`, restore: true },
  { tbl: 'buildings', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'areas', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'accounts', predicate: `user_id IN ${DU} OR code LIKE 'DEMO%'`, restore: true },
  { tbl: 'income_expense_types', predicate: `user_id IN ${DU}`, restore: true },
  { tbl: 'roles', predicate: `user_id IN ${DU}`, restore: true },
]

// Chỉ CLEANUP (phá dỡ toàn phần) mới đụng — reset KHÔNG BAO GIỜ xoá auth/profiles
export const CLEANUP_TAIL = [
  { tbl: 'profiles', predicate: `id IN ${DU}` },
  { tbl: 'auth.users', predicate: `id IN ${DU}` },
]
