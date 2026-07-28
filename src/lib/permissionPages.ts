// Catalog phân quyền THEO TRANG — nguồn sự thật cho UI bảng phân quyền mới
// (PermissionPicker). Mỗi PAGE = 1 nhóm gập, liệt kê TỪNG CHỨC NĂNG trên
// trang đó; mỗi chức năng map về 1 key lưu trữ `module.action` trong JSONB
// permissions (registry: src/lib/permissions.ts).
//
// - KHÔNG còn cơ chế suy diễn quyền (gỡ 2026-07-26, cutover phân quyền V3).
//   Trước đây một key chi tiết chưa có trong JSONB sẽ rơi về quyền gốc (vd
//   sale_phong.manage_tokens rơi về sale_phong.edit). Nay get_my_permissions()
//   trả ĐÚNG tập khoá mà mô hình tổ chức cho phép, nên không còn "chưa có key"
//   — giữ cơ chế đó lại chỉ tạo đường cấp quyền ngầm mà máy chủ đã từ chối.
// - `tier`: "view" (chỉ đọc) / "manage" (thao tác thường ngày) / "elevated"
//   (nhạy cảm — duyệt, thanh lý, chốt LN, phân quyền…). Preset & nút nhanh
//   per-page dựa vào tier.
//
// LƯU Ý: catalog phải phủ ĐỦ mọi (module × action) trong registry — module
// nào không có trang riêng thì gắn vào trang gần nghĩa nhất.

import {
  actionsForModule,
  ALL_MODULES,
  canFeature,
  isSuperAdminPerms,
  type ActionKey,
  type PermissionsMap,
} from "@/lib/permissions";

export type FeatureTier = "view" | "manage" | "elevated";

export interface PageFeature {
  module: string;
  action: ActionKey;
  label: string;
  /** Mô tả ngắn hiển thị dưới label (tuỳ chọn). */
  desc?: string;
  tier: FeatureTier;
  /** Nhóm hiển thị trong trang (tuỳ chọn — vd tách "Khu vực" khỏi "Toà nhà"). */
  section?: string;
}

export interface PermissionPage {
  key: string;
  label: string;
  route: string;
  /** Mô tả ngắn về trang. */
  desc?: string;
  features: PageFeature[];
}

export interface PageGroup {
  key: string;
  label: string;
  pages: PermissionPage[];
}

// Helper rút gọn khai báo
const f = (
  module: string,
  action: ActionKey,
  label: string,
  tier: FeatureTier,
  opts?: { desc?: string; section?: string },
): PageFeature => ({ module, action, label, tier, ...opts });

const crud = (module: string, noun: string, section?: string): PageFeature[] => [
  f(module, "view",   `Xem ${noun}`,  "view",   { section }),
  f(module, "create", `Tạo ${noun}`,  "manage", { section }),
  f(module, "edit",   `Sửa ${noun}`,  "manage", { section }),
  f(module, "delete", `Xoá ${noun}`,  "manage", { section }),
];

export const PAGE_GROUPS: PageGroup[] = [
  {
    key: "core",
    label: "Tổng quan",
    pages: [
      {
        key: "dashboard",
        label: "Bảng tin",
        route: "/",
        desc: "Trang chủ: KPI, biểu đồ, cảnh báo, hoạt động gần đây.",
        features: [
          f("dashboard", "view", "Xem bảng tin", "view"),
          f("dashboard", "view_finance", "Xem số liệu tài chính (doanh thu, công nợ)", "view", {
            desc: "Ẩn/hiện các thẻ KPI doanh thu, công nợ và biểu đồ tài chính.",
          }),
        ],
      },
      {
        key: "ai-copilot",
        label: "AI Copilot",
        route: "/",
        desc: "Trợ lý AI: chat hỏi đáp dữ liệu + điều khiển UI (experimental). Kill switch thật nằm server-side (entitlements + settings).",
        features: [
          f("ai_copilot", "view", "Dùng chat Trợ lý AI", "view"),
          f("ai_copilot", "ui_control", "Cho phép AI điều khiển trang (experimental)", "elevated", {
            desc: "Agent thao tác trực tiếp trên UI thay người dùng — chỉ bật cho pilot.",
          }),
        ],
      },
      {
        key: "notifications",
        label: "Thông báo",
        route: "/notifications",
        features: [
          f("notifications", "view", "Xem thông báo", "view"),
          f("notifications", "create", "Tạo thông báo gửi người khác", "manage"),
          f("notifications", "edit", "Sửa thông báo đã gửi", "manage"),
          f("notifications", "delete", "Xoá thông báo", "manage"),
        ],
      },
      {
        key: "building_map",
        label: "Sơ đồ toà nhà",
        route: "/building-map",
        desc: "Bản đồ trạng thái phòng theo tầng (chỉ xem). Sửa sơ đồ toạ độ nằm ở trang Sale Phòng.",
        features: [
          f("buildings", "view", "Xem sơ đồ toà nhà", "view", {
            desc: "Dùng chung quyền Xem toà nhà.",
          }),
        ],
      },
    ],
  },
  {
    key: "chat",
    label: "Kênh chat",
    pages: [
      {
        key: "chat_zalo",
        label: "Chat Zalo",
        route: "/chat-zalo",
        desc: "Nhắn tin Zalo với khách trọ, lead, môi giới; mẫu tin & tự động hoá.",
        features: [
          f("chat_zalo", "view", "Vào trang Chat Zalo", "view"),
          f("chat_zalo", "send", "Gửi / soạn tin nhắn", "manage"),
          f("chat_zalo", "manage_automation", "Bật/tắt luồng tự động hoá", "manage"),
          f("chat_zalo", "manage_templates", "Quản lý mẫu tin / ZNS", "manage"),
        ],
      },
    ],
  },
  {
    key: "real_estate",
    label: "Bất động sản",
    pages: [
      {
        key: "buildings",
        label: "Toà nhà & Khu vực",
        route: "/buildings",
        features: [
          ...crud("buildings", "toà nhà", "Toà nhà"),
          ...crud("areas", "khu vực", "Khu vực"),
        ],
      },
      {
        key: "rooms",
        label: "Căn hộ / Phòng",
        route: "/apartments",
        features: crud("rooms", "phòng"),
      },
      {
        key: "services",
        label: "Dịch vụ",
        route: "/services",
        features: crud("services", "dịch vụ"),
      },
      {
        key: "sale_phong",
        label: "Sale Phòng",
        route: "/sale-phong",
        desc: "Quản trị kênh công khai Phòng trống (/r/:token).",
        features: [
          f("sale_phong", "view", "Vào trang quản trị Sale Phòng", "view"),
          f("sale_phong", "edit", "Sửa thông tin phòng đăng bán", "manage"),
          f("sale_phong", "manage_tokens", "Quản lý link chia sẻ (tạo/thu hồi/xoá)", "manage"),
          f("sale_phong", "manage_settings", "Cài đặt hiển thị (soon days, hotline…)", "manage"),
          f("sale_phong", "manage_images", "Quản lý hình ảnh sale", "manage"),
          f("sale_phong", "edit_floor_plan", "Sửa sơ đồ toạ độ phòng", "manage"),
          f("sale_phong", "manage_pass_listings", "Quản lý phòng khách nhờ sale (pass)", "manage", {
            desc: "Đăng phòng đang có khách lên trang công khai với SĐT khách + chính sách sale riêng.",
          }),
          f("sale_phong", "create_deposit", "Tạo cọc nhanh trên trang công khai", "elevated", {
            desc: "Nút 'Tạo cọc giữ phòng' trên /r/:token khi đăng nhập — phòng tự chuyển ĐÃ CỌC.",
          }),
          f("sale_phong", "view_analytics", "Xem tab Thống kê truy cập", "view", {
            desc: "Tab 'Thống kê' — đo đếm lượt xem, thời gian, phòng được xem nhiều, lỗi của trang /r/:token.",
          }),
        ],
      },
    ],
  },
  {
    key: "customers",
    label: "Khách hàng",
    pages: [
      {
        key: "leads",
        label: "Khách hẹn",
        route: "/leads",
        features: [
          ...crud("leads", "khách hẹn"),
          f("leads", "convert", "Chuyển đổi lead → cọc / khách", "manage"),
          f("leads", "export", "Xuất danh sách khách hẹn", "manage"),
        ],
      },
      {
        key: "deposits",
        label: "Đặt cọc",
        route: "/deposits",
        desc: "Gồm cả nhật ký hoàn/bỏ cọc (/finance/refund-log).",
        features: [
          ...crud("deposits", "phiếu cọc"),
          f("deposits", "convert", "Chuyển cọc thành hợp đồng", "manage"),
          f("deposits", "refund", "Hoàn cọc / bỏ cọc", "manage"),
          f("deposits", "print", "In phiếu cọc", "manage"),
        ],
      },
      {
        key: "contracts",
        label: "Hợp đồng",
        route: "/contracts",
        desc: "Danh sách + trang chi tiết hợp đồng, vòng đời HĐ.",
        features: [
          ...crud("contracts", "hợp đồng"),
          f("contracts", "approve", "Duyệt hợp đồng", "elevated"),
          f("contracts", "renew", "Gia hạn hợp đồng", "manage"),
          f("contracts", "transfer", "Chuyển nhượng / chuyển phòng", "manage"),
          f("contracts", "terminate", "Thanh lý / trả phòng", "elevated"),
          f("contracts", "handover", "Biên bản bàn giao tài sản", "manage"),
          f("contracts", "print", "In hợp đồng", "manage"),
          f("contracts", "export", "Xuất danh sách hợp đồng", "manage"),
        ],
      },
      {
        key: "customers",
        label: "Cư dân",
        route: "/customers",
        desc: "Gồm trang chi tiết, form tạo/sửa và hồ sơ CT01.",
        features: [
          ...crud("customers", "cư dân"),
          f("customers", "import", "Nhập cư dân từ file CSV", "manage"),
          f("customers", "print", "In hồ sơ / CT01", "manage"),
          f("customers", "export", "Xuất danh sách cư dân", "manage"),
        ],
      },
      {
        key: "vehicles",
        label: "Phương tiện",
        route: "/vehicles",
        features: crud("vehicles", "phương tiện"),
      },
    ],
  },
  {
    key: "finance",
    label: "Tài chính",
    pages: [
      {
        key: "cashbooks",
        label: "Sổ quỹ",
        route: "/finance/cashbooks",
        features: [
          ...crud("cashbooks", "sổ quỹ"),
          f("cashbooks", "share", "Chia sẻ sổ quỹ cho người khác", "manage"),
          f("cashbooks", "manage_custody", "Giao / nhận quyền giữ sổ quỹ", "elevated", {
            desc: "Bàn giao sổ quỹ giữa hai người. Việc bàn giao vẫn cần CẢ HAI bên xác nhận — quyền này chỉ mở được nút khởi tạo.",
          }),
          f("cashbooks", "post", "Ghi sổ (hạch toán vào sổ quỹ)", "elevated", {
            desc: "Đẩy phiếu đã duyệt vào số dư sổ quỹ. Chỉ người đang GIỮ sổ mới ghi được, kể cả khi có quyền này.",
          }),
        ],
      },
      {
        key: "meter_readings",
        label: "Ghi chỉ số",
        route: "/meter-readings",
        features: [
          ...crud("meter_readings", "chỉ số"),
          f("meter_readings", "export", "Xuất bảng chỉ số", "manage"),
        ],
      },
      {
        key: "invoices",
        label: "Hoá đơn",
        route: "/invoices",
        desc: "Danh sách + chi tiết + in hoá đơn.",
        features: [
          ...crud("invoices", "hoá đơn"),
          f("invoices", "approve", "Duyệt hoá đơn", "elevated"),
          f("invoices", "cancel", "Huỷ hoá đơn", "manage", {
            // Legacy: nút huỷ hoá đơn trước đây gate bằng invoices.delete.
          }),
          f("invoices", "record_payment", "Thu tiền (ghi nhận thanh toán)", "manage"),
          f("invoices", "print", "In hoá đơn", "manage"),
          f("invoices", "export", "Xuất danh sách hoá đơn", "manage"),
        ],
      },
      {
        key: "thu_tien",
        label: "Thu tiền (mobile)",
        route: "/thu-tien",
        desc: "Lưới ô phòng thu tiền nhanh theo kỳ & toà.",
        features: [
          f("thu_tien", "view", "Vào trang Thu tiền", "view"),
          f("thu_tien", "collect", "Thu đủ / thu một phần", "manage"),
          f("thu_tien", "undo", "Hoàn tác phiếu thu", "manage"),
          f("thu_tien", "report", "Xem báo cáo thu tiền", "view"),
        ],
      },
      {
        key: "income_expenses",
        label: "Thu chi",
        route: "/income-expense",
        features: [
          ...crud("income_expenses", "phiếu thu chi"),
          f("income_expenses", "approve", "Duyệt phiếu thu chi", "elevated"),
          f("income_expenses", "cancel", "Huỷ phiếu thu chi", "manage"),
          f("income_expenses", "print", "In phiếu thu chi", "manage"),
          f("income_expenses", "export", "Xuất danh sách thu chi", "manage"),
          f("income_expenses", "all_buildings", "Ghi thu chi cho MỌI toà nhà", "elevated", {
            desc: "Vượt phạm vi toà được giao — chỉ trong form thu chi (vd kế toán).",
          }),
          f("income_expenses", "restricted_create", "Tạo phiếu với hạng mục HẠN CHẾ", "elevated", {
            desc: "Thấy & chọn hạng mục đánh dấu 'hạn chế' (vd Quản Lý) trong picker khi tạo phiếu. Mặc định ẩn.",
          }),
          f("approvals", "emergency_override", "Duyệt khẩn cấp (cửa thoát chủ sở hữu)", "elevated", {
            desc: "Gỡ kẹt phiếu do HỆ THỐNG sinh ở hạng mục đặc biệt (cọc / hoa hồng / thưởng) — nhóm này không ai tự duyệt được. Mọi lần dùng đều ghi nhật ký kèm lý do. Trang /approvals không cần quyền vì đã lọc theo người đăng nhập.",
          }),
          f("income_expenses", "reverse", "Đảo bút toán phiếu đã ghi sổ", "elevated", {
            desc: "Sinh phiếu ngược để huỷ tác động của phiếu đã hạch toán. Không xoá phiếu gốc — dấu vết được giữ nguyên.",
          }),
          f("income_expenses", "self_approve_within_limit", "Tự duyệt phiếu chi dưới ngưỡng", "elevated", {
            desc: "Người lập được tự duyệt phiếu chi khi số tiền dưới ngưỡng cấu hình. Trên ngưỡng vẫn phải người có quyền Duyệt.",
          }),
          f("income_expenses", "restricted_view", "Xem & sửa phiếu hạng mục HẠN CHẾ", "elevated", {
            desc: "Thấy & sửa các phiếu thuộc hạng mục 'hạn chế' trong bảng + cộng vào tổng. Người khác bị ẩn hoàn toàn (kể cả truy vấn trực tiếp).",
          }),
        ],
      },
      {
        key: "excess_amounts",
        label: "Tiền thừa",
        route: "/reports/finance/overpayment",
        desc: "Tiền khách nộp thừa / điều chỉnh gạch nợ.",
        features: crud("excess_amounts", "tiền thừa"),
      },
    ],
  },
  {
    key: "shareholder",
    label: "Cổ đông & Cá nhân",
    pages: [
      {
        key: "shareholder_profit",
        label: "Lợi nhuận cổ đông",
        route: "/finance/shareholder-profit",
        features: [
          f("shareholder_profit", "view", "Xem trang lợi nhuận cổ đông", "view"),
          f("shareholder_profit", "lock", "Chốt lợi nhuận tháng", "elevated"),
          f("shareholder_profit", "unlock", "Mở khoá tháng đã chốt", "elevated"),
          f("shareholder_profit", "distribute", "Chi lợi nhuận cho cổ đông", "elevated"),
          f("shareholder_profit", "manage_shareholders", "Quản lý cổ đông & tỷ lệ", "elevated"),
          f("shareholder_profit", "pay_manager", "Chi lương quản lý từ lợi nhuận", "elevated", {
            desc: "Sinh phiếu chi lương quản lý trong kỳ đã chốt.",
          }),
          f("shareholder_profit", "export", "Xuất dữ liệu lợi nhuận", "manage"),
        ],
      },
      {
        key: "salary",
        label: "Bảng lương quản lý",
        route: "/finance/salary",
        desc: "Tính lương quản lý từ việc thật + đầu tư + HH Sale; chốt tháng; quản lý tự xem.",
        features: [
          f("salary", "view", "Xem bảng lương quản lý", "view"),
          f("salary", "lock", "Chốt lương tháng", "elevated"),
          f("salary", "unlock", "Mở khoá tháng lương", "elevated"),
          f("salary", "distribute", "Trả lương (ghi phiếu chi)", "elevated"),
          f("salary", "manage_salary", "Cấu hình lương, quy tắc thưởng, quản lý", "elevated"),
          f("salary", "export", "Xuất bảng lương", "manage"),
        ],
      },
      {
        key: "personal_finance",
        label: "Ví thu chi cá nhân",
        route: "/finance/personal-wallet",
        features: crud("personal_finance", "giao dịch cá nhân"),
      },
    ],
  },
  {
    key: "assets",
    label: "Tài sản & Kho",
    pages: [
      {
        key: "assets",
        label: "Tài sản",
        route: "/assets",
        features: [
          ...crud("assets", "tài sản"),
          f("assets", "move", "Di chuyển tài sản", "manage"),
          f("assets", "maintain", "Tạo phiếu bảo trì / sửa chữa", "manage"),
        ],
      },
      {
        key: "materials",
        label: "Vật tư",
        route: "/materials",
        desc: "Tồn kho vật tư, phiếu nhập/xuất/điều chỉnh.",
        features: crud("materials", "vật tư"),
      },
      {
        key: "asset_types",
        label: "Loại tài sản",
        route: "/settings/categories/asset-types",
        features: crud("asset_types", "loại tài sản"),
      },
      {
        key: "warehouses",
        label: "Kho",
        route: "/settings/categories/warehouses",
        features: crud("warehouses", "kho"),
      },
      {
        key: "suppliers",
        label: "Nhà cung cấp",
        route: "/settings/categories/suppliers",
        features: crud("suppliers", "nhà cung cấp"),
      },
    ],
  },
  {
    key: "ops",
    label: "Vận hành",
    pages: [
      {
        key: "network_center",
        label: "Trung tâm mạng",
        route: "/network-center",
        desc: "Theo dõi mạng theo toà và chạy các thao tác MikroTik an toàn đã được định kiểu.",
        features: [
          f("network_center", "view", "Xem Trung tâm mạng", "view"),
          f("network_center", "execute", "Thực thi thao tác mạng", "elevated"),
        ],
      },
      {
        key: "tasks",
        label: "Công việc",
        route: "/tasks",
        features: [
          ...crud("tasks", "công việc"),
          f("tasks", "complete", "Hoàn thành công việc", "manage"),
          f("tasks", "approve", "Duyệt / nghiệm thu công việc", "elevated"),
        ],
      },
      {
        key: "task_types",
        label: "Loại công việc",
        route: "/settings/categories/task-types",
        features: crud("task_types", "loại công việc"),
      },
    ],
  },
  {
    key: "reports",
    label: "Báo cáo",
    pages: [
      {
        key: "reports_real_estate",
        label: "Báo cáo BĐS",
        route: "/reports/real-estate",
        desc: "Bật/tắt từng báo cáo bất động sản.",
        features: [
          f("reports_real_estate", "view", "Vào trang báo cáo BĐS", "view"),
          f("reports_real_estate", "vacant_rooms", "Báo cáo Phòng trống", "view"),
          f("reports_real_estate", "expiring", "Báo cáo HĐ sắp hết hạn", "view"),
          f("reports_real_estate", "renewals_transfers", "Báo cáo Gia hạn & chuyển nhượng", "view"),
          f("reports_real_estate", "occupancy", "Báo cáo Lấp đầy", "view"),
          f("reports_real_estate", "promotions", "Báo cáo Khuyến mãi", "view"),
          f("reports_real_estate", "new_leases", "Báo cáo Cho thuê mới", "view"),
          f("reports_real_estate", "terminations", "Báo cáo Bỏ trả / thanh lý", "view"),
          f("reports_real_estate", "expense_ratio", "Báo cáo Tỉ lệ chi phí", "view"),
          f("reports_real_estate", "export", "Xuất báo cáo BĐS", "manage"),
        ],
      },
      {
        key: "reports_finance",
        label: "Báo cáo tài chính",
        route: "/reports/finance",
        desc: "Bật/tắt từng báo cáo tài chính.",
        features: [
          f("reports_finance", "view", "Vào trang báo cáo tài chính", "view"),
          f("reports_finance", "analysis", "Báo cáo Phân tích tài chính", "view"),
          f("reports_finance", "daily_cashbook", "Báo cáo Sổ quỹ ngày", "view"),
          f("reports_finance", "cash_flow", "Báo cáo Dòng tiền", "view"),
          f("reports_finance", "profit_distribution", "Báo cáo Phân bổ lợi nhuận (KQKD)", "view"),
          // debt/customer_debt: 2 BC công nợ đã xoá (Phase 7) — không hiển thị
          // trong UI cấu hình mới; key legacy trong JSON role cũ được bỏ qua.
          f("reports_finance", "payment_schedule", "Báo cáo Lịch thanh toán", "view"),
          f("reports_finance", "overpayment", "Báo cáo Tiền thừa", "view"),
          f("reports_finance", "deposits_report", "Báo cáo Danh sách cọc", "view"),
          f("reports_finance", "handover_report", "Báo cáo Bàn giao tiền & Đối soát sổ", "view"),
          f("reports_finance", "reconcile", "Chốt số / đối soát sổ quỹ", "manage"),
          // Self-view cho người thu tiền.
          // (đúng quyền cho vào /thu-tien) → quản lý xem chu kỳ của MÌNH được, mà
          // KHÔNG mở các báo cáo tài chính khác (vẫn theo reports_finance.view).
          f("reports_finance", "collection_cycle", "Báo cáo Chu kỳ Thu — Bàn giao (theo tòa QL)", "view"),
          f("reports_finance", "export", "Xuất báo cáo tài chính", "manage"),
        ],
      },
    ],
  },
  {
    key: "settings",
    label: "Cấu hình hệ thống",
    pages: [
      {
        key: "meters",
        label: "Đồng hồ / Công tơ",
        route: "/settings/meters",
        features: crud("meters", "công tơ"),
      },
      {
        key: "service_quotas",
        label: "Định mức dịch vụ",
        route: "/settings/categories/service-quotas",
        features: crud("service_quotas", "định mức"),
      },
      {
        key: "auto_debt",
        label: "Gạch nợ tự động",
        route: "/settings/categories/auto-debt",
        features: crud("auto_debt", "cấu hình gạch nợ"),
      },
      {
        key: "hotline",
        label: "Hotline",
        route: "/settings/categories/hotlines",
        features: crud("hotline", "hotline"),
      },
      {
        key: "categories",
        label: "Danh mục khác",
        route: "/settings/categories",
        desc: "Tài khoản ngân hàng, tầng, loại thu chi, mẫu phiếu, danh mục chung.",
        features: crud("categories", "danh mục"),
      },
      {
        key: "templates",
        label: "Biểu mẫu / Chữ ký",
        route: "/settings/templates",
        features: crud("templates", "biểu mẫu"),
      },
      {
        key: "settings",
        label: "Cài đặt chung",
        route: "/settings/general",
        features: [
          f("settings", "view", "Xem cài đặt chung", "view"),
          f("settings", "create", "Thêm mục cấu hình mới", "manage"),
          f("settings", "edit", "Sửa cài đặt chung", "manage"),
          f("settings", "delete", "Xoá mục cấu hình", "elevated"),
        ],
      },
      {
        key: "users",
        label: "Phân quyền nhân viên",
        route: "/settings/staff",
        desc: "Quyền nhạy cảm — chỉ cấp cho người quản lý nhân sự.",
        features: [
          f("users", "view", "Vào trang phân quyền", "elevated"),
          f("users", "create", "Thêm nhân viên mới", "elevated"),
          f("users", "edit", "Sửa thông tin / quyền nhân viên", "elevated"),
          f("users", "delete", "Xoá nhân viên", "elevated"),
          f("users", "manage_templates", "Quản lý mẫu phân quyền", "elevated"),
        ],
      },
    ],
  },
];

/** Flat list mọi page. */
export const ALL_PAGES: PermissionPage[] = PAGE_GROUPS.flatMap((g) => g.pages);

/** Flat list mọi feature trong catalog. */
export const ALL_PAGE_FEATURES: PageFeature[] = ALL_PAGES.flatMap((p) => p.features);

/** Key lưu trữ của 1 feature. */
export const featureKey = (ft: PageFeature) => `${ft.module}.${ft.action}`;

/**
 * Kiểu permissions "lỏng" — chấp nhận cả PermissionsMap (lib/permissions) lẫn
 * shape của hook useMyPermissions (Record<string, Record<string, boolean>> &
 * { __superadmin?: boolean }) để gọi thẳng không cần cast.
 */
export type PermsLike =
  | PermissionsMap
  | (Record<string, Record<string, boolean>> & { __superadmin?: boolean })
  | null
  | undefined;

const asPerms = (p: PermsLike): PermissionsMap | null =>
  (p ?? null) as PermissionsMap | null;

/** Tra feature theo (module, action) — dùng cho gate runtime. */
const FEATURE_BY_KEY: Record<string, PageFeature> = Object.fromEntries(
  ALL_PAGE_FEATURES.map((ft) => [featureKey(ft), ft]),
);

export function findFeature(module: string, action: ActionKey): PageFeature | undefined {
  return FEATURE_BY_KEY[`${module}.${action}`];
}

/**
 * Giá trị HIỆU LỰC của 1 feature: khoá có trong map thì bật, không có thì tắt.
 */
export function featureValue(perms: PermsLike, ft: PageFeature): boolean {
  const p = asPerms(perms);
  if (isSuperAdminPerms(p)) return true;
  return canFeature(p, ft.module, ft.action);
}

/**
 * Gate runtime chuẩn cho FE.
 */
export function canUse(
  perms: PermsLike,
  module: string,
  action: ActionKey,
): boolean {
  const p = asPerms(perms);
  if (!p) return false;
  if (isSuperAdminPerms(p)) return true;
  return canFeature(p, module, action);
}

/**
 * Diff 2 permission maps theo từng feature trong catalog.
 */
export function diffFeatures(a: PermsLike, b: PermsLike): PageFeature[] {
  // featureValue đã xử lý sentinel __superadmin (mọi feature = true) nên so
  // hiệu lực trực tiếp là đủ cho cả trường hợp lệch sentinel.
  return ALL_PAGE_FEATURES.filter((ft) => featureValue(a, ft) !== featureValue(b, ft));
}

/** Thống kê 1 trang: số feature đang bật (theo giá trị hiệu lực) / tổng. */
export function pageStats(perms: PermsLike, page: PermissionPage) {
  let granted = 0;
  for (const ft of page.features) if (featureValue(perms, ft)) granted++;
  return { granted, total: page.features.length };
}

/** Set toàn bộ feature của 1 trang. */
export function setPageAll(perms: PermissionsMap, page: PermissionPage, value: boolean): PermissionsMap {
  const next: PermissionsMap = { ...perms };
  for (const ft of page.features) {
    next[ft.module] = { ...(next[ft.module] || {}), [ft.action]: value };
  }
  return next;
}

/** Set trang về "chỉ xem": feature tier view = true, còn lại = false. */
export function setPageViewOnly(perms: PermissionsMap, page: PermissionPage): PermissionsMap {
  const next: PermissionsMap = { ...perms };
  for (const ft of page.features) {
    next[ft.module] = { ...(next[ft.module] || {}), [ft.action]: ft.tier === "view" };
  }
  return next;
}

/** Set 1 feature (ghi tường minh). */
export function setFeature(
  perms: PermissionsMap,
  ft: PageFeature,
  value: boolean,
): PermissionsMap {
  return { ...perms, [ft.module]: { ...(perms[ft.module] || {}), [ft.action]: value } };
}

/**
 * Sanity check (dev): mọi (module × action) trong registry phải xuất hiện
 * trong catalog ít nhất 1 lần — tránh quyền "mồ côi" không chỉnh được từ UI.
 * Trả về danh sách key thiếu (rỗng = ổn).
 */
export function findOrphanRegistryKeys(): string[] {
  const covered = new Set(ALL_PAGE_FEATURES.map(featureKey));
  const missing: string[] = [];
  for (const m of ALL_MODULES) {
    for (const a of actionsForModule(m.key)) {
      const k = `${m.key}.${a}`;
      if (!covered.has(k)) missing.push(k);
    }
  }
  return missing;
}
