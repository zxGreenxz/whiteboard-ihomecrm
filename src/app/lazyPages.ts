// Khai báo lazy cho toàn bộ page — tách khỏi App.tsx (Đợt 4).
//
// Vì sao tách: 99 khai báo này chiếm 135/599 dòng của App.tsx và đẩy phần thật sự
// đáng đọc — bảng route — xuống tận cuối file. Chúng cũng gần như không bao giờ
// thay đổi cùng lúc với route, nên để chung chỉ làm mọi diff của App.tsx trông to
// hơn thực tế.
//
// Thuần DI CHUYỂN: không đổi tên, không đổi thứ tự, không đổi module đích. Chỉ
// "./" thành "../" vì file này nằm sâu hơn App.tsx một cấp.
//
// Vẫn dùng lazyWithRetry: import động thất bại khi user đang mở tab cũ sau một
// lần deploy (chunk cũ đã bị xoá khỏi CDN); lazyWithRetry thử lại và reload thay
// vì hiện màn trắng.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";

// ===== Lazy imports — code-split theo route =====
// Bundle chính từng là 3.8 MB (1.05 MB gzip) vì ~80 page import tĩnh kéo theo
// xlsx/docxtemplater/recharts. Mỗi page lazy thành chunk riêng; <Suspense>
// bọc chung quanh <Routes> (riêng /r/:token và /thu-tien giữ Suspense cục bộ
// vì có CSS toàn cục cần cô lập).
export const BuildingMapPage = lazy(() => import("../pages/building-map/BuildingMapPage"));
export const NetworkCenterApp = lazy(() => import("../pages/network-center/NetworkCenterApp"));
// AI Copilot — nút nổi + panel chat (gate session/entitlement/quyền bên trong)
export const CopilotLauncher = lazy(() => import("../copilot/CopilotLauncher"));
// AI Copilot — trang quản trị (super admin: full; user thường: tab Sử dụng)
export const AiCopilotAdminPage = lazy(() => import("../copilot/admin/AiCopilotAdminPage"));
export const NotificationsPage = lazy(() => import("../pages/NotificationsPage"));
export const ChatZaloPage = lazy(() => import("../pages/chat-zalo/ChatZaloPage"));
export const OpenClawZaloPage = lazy(() => import("../pages/openclaw-zalo/OpenClawZaloPage"));
export const OpenClawRouteGuard = lazy(() => import("../components/openclaw-zalo/OpenClawRouteGuard"));

// Danh mục dữ liệu
export const BuildingsPage = lazy(() => import("../pages/buildings/BuildingsPage"));
export const BuildingDetailPage = lazy(() => import("../pages/buildings/BuildingDetailPage"));
export const RoomsPage = lazy(() => import("../pages/rooms/RoomsPage"));
export const RoomDetailPage = lazy(() => import("../pages/rooms/RoomDetailPage"));
export const ServicesPage = lazy(() => import("../pages/services/ServicesPage"));
export const SalePhongPage = lazy(() => import("../pages/sale-phong/SalePhongPage"));

// Khách hàng
export const LeadsPage = lazy(() => import("../pages/leads/LeadsPage"));
export const DepositsPage = lazy(() => import("../pages/deposits/DepositsPage"));
export const ContractsPage = lazy(() => import("../pages/contracts/ContractsPage"));
export const ContractDetailPage = lazy(() => import("../pages/contracts/ContractDetailPage"));
export const VehiclesPage = lazy(() => import("../pages/vehicles/VehiclesPage"));
export const CustomersPage = lazy(() => import("../pages/customers/CustomersPage"));
export const CustomerFormPage = lazy(() => import("../pages/customers/CustomerFormPage"));
export const CustomerDetailPage = lazy(() => import("../pages/customers/CustomerDetailPage"));
export const CT01FormPage = lazy(() => import("../pages/customers/CT01FormPage"));

// Tài chính
export const MeterReadingsPage = lazy(() => import("../pages/meter-readings/MeterReadingsPage"));
export const InvoicesPage = lazy(() => import("../pages/invoices/InvoicesPage"));
export const InvoiceDetailPage = lazy(() => import("../pages/invoices/InvoiceDetailPage"));
export const InvoicePrintPage = lazy(() => import("../pages/invoices/InvoicePrintPage"));
export const IncomeExpensePage = lazy(() => import("../pages/payments/IncomeExpensePage"));
export const IncomeExpensePrintPage = lazy(() => import("../pages/payments/IncomeExpensePrintPage"));
export const VoucherDetailPage = lazy(() => import("../pages/payments/VoucherDetailPage"));
export const RefundLogPage = lazy(() => import("../pages/payments/RefundLogPage"));
export const ApprovalsPage = lazy(() => import("../pages/approvals/ApprovalsPage"));

// Tài sản & vật tư
export const AssetsPage = lazy(() => import("../pages/assets/AssetsPage"));
export const MaterialsPage = lazy(() => import("../pages/materials/MaterialsPage"));

// Báo cáo
export const RealEstateReportsPage = lazy(() => import("../pages/reports/RealEstateReportsPage"));
export const FinanceReportsPage = lazy(() => import("../pages/reports/FinanceReportsPage"));
export const VacantRoomsReport = lazy(() => import("../pages/reports/real-estate/VacantRoomsReport"));
export const ExpiringContractsReport = lazy(() => import("../pages/reports/real-estate/ExpiringContractsReport"));
export const OccupancyReport = lazy(() => import("../pages/reports/real-estate/OccupancyReport"));
export const RenewalsTransfersReport = lazy(() => import("../pages/reports/real-estate/RenewalsTransfersReport"));
export const PromotionsReport = lazy(() => import("../pages/reports/real-estate/PromotionsReport"));
export const NewLeasesReport = lazy(() => import("../pages/reports/real-estate/NewLeasesReport"));
export const TerminationsReport = lazy(() => import("../pages/reports/real-estate/TerminationsReport"));
export const ExpenseRatioReport = lazy(() => import("../pages/reports/real-estate/ExpenseRatioReport"));
export const DailyCashbookReport = lazy(() => import("../pages/reports/finance/DailyCashbookReport"));
export const CashFlowReport = lazy(() => import("../pages/reports/finance/CashFlowReport"));
export const CashbookClosureRecord = lazy(() => import("../pages/reports/finance/CashbookClosureRecord"));
export const PaymentScheduleReport = lazy(() => import("../pages/reports/finance/PaymentScheduleReport"));
export const OverpaymentReport = lazy(() => import("../pages/reports/finance/OverpaymentReport"));
export const DepositsReport = lazy(() => import("../pages/reports/finance/DepositsReport"));
export const ProfitHubPage = lazy(() => import("../pages/reports/finance/ProfitHubPage"));
export const BusinessPerformanceReportPage = lazy(() => import("../pages/reports/finance/BusinessPerformanceReportPage"));
export const FinancialAnalysisReport = lazy(() => import("../pages/reports/finance/FinancialAnalysisReport"));
export const BanGiaoReport = lazy(() => import("../pages/reports/finance/BanGiaoReport"));
export const BanGiaoCycleReport = lazy(() => import("../pages/reports/finance/BanGiaoCycleReport"));

// Cài đặt
export const GeneralSettingsPage = lazy(() => import("../pages/settings/GeneralSettingsPage"));
export const CategoriesPage = lazy(() => import("../pages/settings/CategoriesPage"));
export const TemplatesPage = lazy(() => import("../pages/settings/TemplatesPage"));
export const SignaturesPage = lazy(() => import("../pages/settings/SignaturesPage"));
export const OrganizationPage = lazy(() => import("../pages/settings/OrganizationPage"));
export const MembersPage = lazy(() => import("../pages/settings/MembersPage"));
export const RolesPage = lazy(() => import("../pages/settings/RolesPage"));
export const AcceptInvitation = lazy(() => import("../pages/auth/AcceptInvitation"));
export const AdminUsersPage = lazy(() => import("../pages/admin/UsersPage"));
export const BankAccountsPage = lazy(() => import("../pages/settings/categories/BankAccountsPage"));
export const AutoDebtPage = lazy(() => import("../pages/settings/categories/AutoDebtPage"));
export const ServiceQuotasPage = lazy(() => import("../pages/settings/categories/ServiceQuotasPage"));
export const MetersPage = lazy(() => import("../pages/settings/MetersPage"));
export const IncomeExpenseTypesNewPage = lazy(() => import("../pages/settings/IncomeExpenseTypesPage"));
export const IncomeExpenseTemplatesPage = lazy(() => import("../pages/settings/IncomeExpenseTemplatesPage"));
export const CashbooksPage = lazy(() => import("../pages/settings/finance/CashbooksPage"));
export const FixedFeesPage = lazy(() => import("../pages/settings/finance/FixedFeesPage"));
export const PersonalWalletPage = lazy(() => import("../pages/finance/PersonalWalletPage"));
export const ManagerSalaryPage = lazy(() => import("../pages/finance/ManagerSalaryPage"));
export const MySalaryPage = lazy(() => import("../pages/finance/MySalaryPage"));
export const SuppliersPage = lazy(() => import("../pages/settings/categories/SuppliersPage"));
export const WarehousesPage = lazy(() => import("../pages/settings/categories/WarehousesPage"));
export const AssetTypesPage = lazy(() => import("../pages/settings/categories/AssetTypesPage"));
export const AssetMovementsPage = lazy(() => import("../pages/settings/categories/AssetMovementsPage"));
export const AssetMaintenancePage = lazy(() => import("../pages/settings/categories/AssetMaintenancePage"));
export const HotlinesPage = lazy(() => import("../pages/settings/categories/HotlinesPage"));
export const GeneralCategoriesPage = lazy(() => import("../pages/settings/categories/GeneralCategoriesPage"));
export const FloorsPage = lazy(() => import("../pages/settings/categories/FloorsPage"));
export const TaskTypesPage = lazy(() => import("../pages/settings/categories/TaskTypesPage"));
export const TaskManagementPage = lazy(() => import("../pages/TaskManagementPage"));
export const MyDayPage = lazy(() => import("../pages/my-day/MyDayPage"));
export const OwnerDashboardV5 = lazy(() => import("../pages/reports/OwnerDashboardV5"));

// Tài khoản + Info + Public
export const ProfilePage = lazy(() => import("../pages/account/ProfilePage"));
export const SubscriptionPage = lazy(() => import("../pages/account/SubscriptionPage"));
export const PublicContractInvoicePage = lazy(() => import("../pages/public/PublicContractInvoicePage"));
export const FaqPage = lazy(() => import("../pages/FaqPage"));
export const ChangelogPage = lazy(() => import("../pages/ChangelogPage"));
export const AppGuidePage = lazy(() => import("../pages/AppGuidePage"));

// Trang công khai "Phòng trống" (share link) — lazy để CSS toàn cục của nó
// (phongTrong.css đặt style body ngoài @layer) chỉ nạp khi mở /r/:token,
// không rò font/nền sang phần còn lại của CRM.
export const PhongTrongPage = lazy(() => import("../pages/phong-trong/PhongTrongPage"));

// Sự kiện trao thưởng + vòng xoay may mắn. Trang công khai /quayso có bộ style
// riêng (quayso.css scope dưới .qs-page) nên lazy để không rò sang CRM; trang
// quản trị /quayso/admin nằm trong app đã đăng nhập.
export const QuaySoPage = lazy(() => import("../pages/quayso/QuaySoPage"));
export const QuaySoScreenPage = lazy(() => import("../pages/quayso/QuaySoScreenPage"));
export const LuckyDrawAdminPage = lazy(() => import("../pages/quayso/LuckyDrawAdminPage"));

// Trang "Thu tiền" (mobile, đi thu tiền mặt) — page phụ độc lập có bộ style
// riêng (thu-tien.css scope dưới .tt-page). Lazy để CSS + font Be Vietnam Pro /
// Space Mono chỉ nạp khi mở /thu-tien, không kế thừa/đụng theme site.
export const ThuTien = lazy(() => import("../pages/ThuTien"));

// Trang "Thanh toán" (Đóng tiền Tập trung theo Kỳ) — tách khỏi overlay của
// /thu-tien. Dùng CHUNG thu-tien.css nên cũng cần Suspense cục bộ như trên.
export const ThanhToan = lazy(() => import("../pages/ThanhToan"));
