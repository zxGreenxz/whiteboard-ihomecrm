import type { Request, Response } from '@playwright/test';

// Một nguồn duy nhất cho các RPC ĐỌC mà spec fleet chỉ-đọc cho qua, và cho cách nhận
// diện lượt đọc danh sách của các màn đã/sắp chuyển sang hàm SQL dùng chung.
//
// Vì sao file này nằm NGOÀI specs/: sửa `.e2e-fleet/specs/**/*.spec.ts` tạo nghĩa vụ
// "Live browser evidence" (scripts/lib/gate-plan.mjs) mà gate-aggregate chưa nhận, nên
// chặn promote. Khi web chuyển một màn sang hàm dùng chung mới, chỉ sửa file này; spec
// chỉ import. Mỗi spec vẫn giữ luật riêng của nó (org DEMO, host TEST, phản hồi giả).
//
// Chỉ thêm hàm KHÔNG ghi: STABLE/IMMUTABLE trong migration, hoặc hàm đọc đã có trong
// danh sách cũ của spec. Hàm ghi (kể cả set_my_ui_preference) để spec tự chặn/trả giả.

/** Mọi route sau đăng nhập: phiên, quyền, công ty, thông báo, sidebar. */
const SHELL = [
  'get_my_context', 'get_my_assignments', 'is_admin', 'is_super_admin', 'get_my_permissions', 'get_my_permissions_v2',
  'my_org_ids', 'can_access_building', 'accessible_building_ids', 'list_my_copilot_organizations_v1',
  'business_performance_organizations_v1', 'is_company_owner_self_v1', 'is_org_owner_self_v1',
  'get_notification_org_config_v1', 'get_my_notification_preferences_v1', 'list_cashbook_visibility_v2',
] as const;

/**
 * Hàm đọc dùng chung (SQL) mà web, Hermes và báo cáo cùng gọi. Luôn được cho qua vì
 * prefetch (src/lib/prefetchPages.ts) có thể đọc Hợp đồng/Hoá đơn từ bất kỳ màn nào.
 */
const SHARED = [
  // 20261017115708_customer_list_v1 — /customers và picker khách của form hợp đồng.
  'customer_list_v1', 'customer_location_ids_v1', 'customer_search_patterns_v1',
  // 20261017115636_contract_list_v1 — danh sách và thẻ thống kê /contracts.
  'contract_list_v1', 'contract_stats_v2',
  // 20261017115809_invoice_read_shared_v1 — danh sách và thẻ thống kê /invoices.
  'invoice_list_v1', 'invoice_statistics_v3',
] as const;

const PAGES = {
  /** Màn chủ `/` mà login() đáp xuống. */
  dashboard: [
    'get_dashboard_summary', 'revenue_by_month', 'get_contract_stats', 'get_income_expense_layer_stats',
    'get_invoice_statistics_v2', 'invoice_active_payment_methods',
  ],
  /** /contracts, /contracts/:id và form tạo/nháp hợp đồng. */
  contracts: [
    'get_contract_stats', 'list_due_contract_move_out_notices_v1', 'list_contract_exit_cases_v1',
    'list_contract_meter_followups_v1', 'get_contract_move_out_notice_v1', 'read_contract_meter_boundary_set_v1',
    'read_contract_transfer_links_v1', 'list_contract_drafts', 'list_room_reservations_v1',
    'read_contract_draft_signing_v1', 'read_contract_meter_interval_v1',
  ],
  /** /invoices và /invoices/:id. */
  invoices: [
    'get_invoice_statistics_v2', 'invoice_active_payment_methods', 'invoice_payment_method_drilldown',
    'get_customer_credit_balance_v1',
  ],
  /** /income-expense và form phiếu thu/chi. */
  incomeExpense: [
    'read_income_expense_details_v1', 'ie_form_buildings', 'ie_form_rooms', 'get_finance_v2_client_flags_v1',
    'get_finance_v2_routes_v1', 'list_my_cashbook_access_v2', 'get_my_cashbook_access_v2', 'get_receiving_cashbooks_v1',
    'list_cashbooks_for_expense_v2', 'get_income_expense_layer_stats', 'get_income_expense_stats',
    'get_pending_approvals_count', 'list_active_memberships_v1', 'list_organization_members_v2',
    'read_authorization_catalog_v1', 'can_flex_cancel_v1',
  ],
  /** /deposits. */
  deposits: [
    'get_held_deposit_summary', 'get_refund_forfeit_summary', 'get_reservation_deposit_summary',
    'get_reservation_settlement_summary_v1', 'get_reservation_settlements_v1', 'list_room_reservations_v1',
  ],
  /** Hỗ trợ tiền thuê, chi hợp đồng, hoa hồng (rent-support-browser.ts). */
  rentSupport: [
    'read_contract_rent_support_v1', 'quote_contract_rent_support_v1', 'quote_invoice_rent_support_v1',
    'list_rent_support_parties_v1', 'read_contract_payout_operation_v1', 'read_contract_payout_request_v1',
    'list_contract_commission_followups_v2', 'get_commission_voucher_facts_v1', 'sale_bonus_status_v1',
    'read_contract_rent_support_lifecycle_v1', 'read_rent_support_deposit_candidate_v1',
    'read_rent_support_salary_parts_v1', 'get_room_cash_lifecycle_v1', 'get_room_residence_segments_v1',
  ],
  /** /finance/salary và quyết toán lương. Hàm ghi tiền (lock/pay/approve) không thuộc đây. */
  salary: [
    'salary_work_ledger', 'salary_commission_meta_v1', 'salary_staff_months', 'get_salary_v5_config', 'v5_month_money_bulk',
    'salary_recurring_list_v1', 'salary_line_override_list_v1', 'salary_can_edit_amounts_v1',
    'rent_support_salary_bridge_required_v1', 'get_special_fee_prices_v1', 'get_period_fee_status', 'get_period_commissions',
  ],
  /** /finance/personal-wallet. */
  personalFinance: ['personal_finance_bootstrap', 'personal_finance_snapshot'],
} as const satisfies Record<string, readonly string[]>;

export type ReadRpcPage = keyof typeof PAGES;

// Chặn sớm khi ai đó lỡ thêm hàm ghi vào danh sách đọc: spec dùng chung danh sách này
// sẽ cho nó qua mà không ai thấy.
const WRITER_NAME = /^(?:create|save|set|update|upsert|insert|delete|remove|record|submit|confirm|approve|reject|cancel|pay|post|reverse|settle|sign|execute|mark|register|prepare|verify|lock|unlock|adjust|review|apply|transfer|close|reopen|send|ack|request|grant|revoke)_/;
for (const name of [...SHELL, ...SHARED, ...Object.values(PAGES).flat()]) {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || WRITER_NAME.test(name)) throw new Error(`read-rpc-allowlist: "${name}" không phải tên hàm đọc`);
}

/** Danh sách RPC đọc cho các màn spec mở; luôn gồm SHELL và hàm dùng chung. */
export function readRpcAllowlist(...pages: ReadRpcPage[]): ReadonlySet<string> {
  return new Set<string>([...SHELL, ...SHARED, ...pages.flatMap(page => PAGES[page])]);
}

type ReadRequest = Pick<Request, 'url' | 'method' | 'postDataJSON'>;

const rpcName = (url: URL) => url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
function rpcArgs(request: ReadRequest): Record<string, unknown> {
  try {
    const body: unknown = request.postDataJSON();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch { return {}; }
}

// Các hàm dưới nhận CẢ dạng cũ (GET bảng PostgREST) lẫn hàm dùng chung (POST rpc), để
// spec giữ nguyên khi web chuyển màn đó sang hàm SQL.

/** Thẻ thống kê /contracts: get_contract_stats (cũ) hoặc contract_stats_v2. */
export function isContractStatsRead(request: ReadRequest) {
  const name = rpcName(new URL(request.url()));
  return request.method() === 'POST' && (name === 'get_contract_stats' || name === 'contract_stats_v2');
}

/** Danh sách /contracts theo thẻ thống kê (`stat`, vd. TERMINATED). */
export function isContractListRead(request: ReadRequest, { stat }: { stat: string }) {
  const url = new URL(request.url());
  if (request.method() === 'GET' && url.pathname === '/rest/v1/contracts') return !!url.searchParams.get('status')?.includes(stat);
  return request.method() === 'POST' && rpcName(url) === 'contract_list_v1' && rpcArgs(request).p_stat === stat;
}

/** Danh sách /invoices lọc theo trạng thái kiểm tra điều chỉnh (giá trị bộ lọc của màn). */
export function isInvoiceListRead(request: ReadRequest, { adjustmentReviewStatus }: { adjustmentReviewStatus: 'pending' | 'checked' }) {
  const url = new URL(request.url());
  if (request.method() === 'GET' && url.pathname === '/rest/v1/invoices') {
    return url.searchParams.get('adjustment_review_status') === `eq.${adjustmentReviewStatus.toUpperCase()}`;
  }
  return request.method() === 'POST' && rpcName(url) === 'invoice_list_v1'
    && rpcArgs(request).p_adjustment_review_status === adjustmentReviewStatus;
}

/** Danh sách khách (/customers, picker khách của form hợp đồng). */
export function isCustomerListRead(request: ReadRequest) {
  const url = new URL(request.url());
  return (request.method() === 'GET' && url.pathname === '/rest/v1/customers')
    || (request.method() === 'POST' && rpcName(url) === 'customer_list_v1');
}

/** Hàng của một lượt đọc danh sách: mảng PostgREST (cũ) hoặc `{ rows }` của hàm dùng chung. */
export async function listReadRows<T = Record<string, unknown>>(response: Response): Promise<T[]> {
  const body: unknown = await response.json();
  const rows = Array.isArray(body) ? body : (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error(`Lượt đọc danh sách ${new URL(response.url()).pathname} không trả hàng`);
  return rows as T[];
}

/**
 * Thân phản hồi giả cho lượt đọc danh sách khách, đúng dạng mà lượt đó chờ
 * (src/lib/customerList.ts kiểm `{ total, stats, rows }` của customer_list_v1).
 */
export function customerListReadBody(request: ReadRequest, customers: readonly Record<string, unknown>[]) {
  if (request.method() === 'GET') {
    const offset = Number(new URL(request.url()).searchParams.get('offset') ?? 0);
    return JSON.stringify(offset > 0 ? [] : customers);
  }
  const args = rpcArgs(request);
  const offset = Number(args.p_offset ?? 0);
  const limit = typeof args.p_limit === 'number' ? args.p_limit : customers.length;
  const rows = customers.slice(offset, offset + limit).map(customer => ({
    created_at: '2026-01-01T00:00:00.000Z',
    ...(args.p_include_location === false ? {} : { current_building_id: null }),
    ...customer,
  }));
  return JSON.stringify({
    total: customers.length,
    stats: { total: customers.length, individual: customers.length, organization: 0, foreign: 0 },
    rows,
  });
}
