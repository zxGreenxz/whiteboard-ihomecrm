import { Link, useLocation } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Home } from 'lucide-react';

// Route to label mapping - covers all routes in App.tsx
const routeLabels: Record<string, string> = {
  // Theo dõi nhanh
  '/': 'Bảng tin',
  '/building-map': 'Sơ đồ toà nhà',

  // Kênh chat
  '/chat-zalo': 'Chat Zalo',
  '/openclaw-zalo': 'OpenClaw Zalo',

  // Danh mục dữ liệu
  '/buildings': 'Toà nhà',
  '/apartments': 'Căn hộ',
  '/rooms': 'Căn hộ',
  '/services': 'Dịch vụ',
  '/assets': 'Tài sản',

  // Khách hàng
  '/leads': 'Khách hẹn',
  '/deposits': 'Đặt cọc',
  '/contracts': 'Hợp đồng',
  '/customers': 'Khách hàng',
  '/tenants': 'Khách hàng',
  '/vehicles': 'Phương tiện',

  // Tài chính
  '/meter-readings': 'Ghi chỉ số',
  '/invoices': 'Hoá đơn',
  '/income-expense': 'Thu chi',
  '/payments': 'Thu chi',

  // Công việc
  '/tasks': 'Công việc',

  // Thông báo
  '/notifications': 'Thông báo',

  // Báo cáo
  '/reports': 'Báo cáo',
  '/reports/real-estate': 'Báo cáo BĐS',
  '/reports/real-estate/vacant': 'Căn hộ trống',
  '/reports/real-estate/vacant-rooms': 'Căn hộ trống',
  '/reports/real-estate/expiring': 'Căn hộ sắp trống',
  '/reports/real-estate/expiring-contracts': 'Căn hộ sắp trống',
  '/reports/real-estate/renewals-transfers': 'Gia hạn, chuyển nhượng',
  '/reports/real-estate/occupancy': 'Tỉ lệ lấp đầy',
  '/reports/real-estate/promotions': 'Báo cáo khuyến mại',
  '/reports/real-estate/new-leases': 'Báo cáo cho thuê',
  '/reports/real-estate/terminations': 'Báo cáo bỏ trả',
  '/reports/finance': 'Báo cáo Tài chính',
  '/reports/finance/daily-cashbook': 'Sổ quỹ theo ngày',
  '/reports/finance/cash-book': 'Sổ quỹ theo ngày',
  '/reports/finance/cash-flow': 'Dòng tiền',
  '/reports/finance/profit-distribution': 'Báo cáo Lợi Nhuận',
  '/reports/finance/payment-schedule': 'Lịch thanh toán',
  '/reports/finance/overpayment': 'Tiền thừa',
  '/reports/finance/deposits': 'Danh sách tiền cọc',
  '/reports/finance/business-performance': 'Trung tâm Tài chính & Hiệu quả',
  '/reports/finance/analysis': 'Phân tích tài chính',
  '/reports/finance/ban-giao': 'Bàn giao tiền & Đối soát sổ',
  '/reports/finance/thu-ban-giao': 'Chu kỳ Thu — Bàn giao',

  // Cài đặt hệ thống
  '/settings': 'Cài đặt hệ thống',
  '/settings/general': 'Cài đặt chung',
  '/settings/categories': 'Danh mục khác',
  '/settings/categories/bank-accounts': 'Tài khoản ngân hàng',
  '/settings/categories/auto-debt': 'Gạch nợ tự động',
  '/settings/categories/income-expense-types': 'Loại thu chi',
  '/settings/categories/service-quotas': 'Định mức dịch vụ',
  '/settings/meters': 'Đồng hồ công tơ',
  '/quayso/admin': 'Quay số may mắn',
  '/settings/categories/suppliers': 'Nhà cung cấp',
  '/settings/categories/warehouses': 'Kho tài sản',
  '/settings/categories/asset-types': 'Loại tài sản',
  '/settings/categories/asset-movements': 'Lịch sử di chuyển',
  '/settings/categories/asset-maintenance': 'Lịch sử sửa chữa',
  '/settings/categories/hotlines': 'Quản lý Hotline',
  '/settings/categories/general': 'Danh mục chung',
  '/settings/categories/floors': 'Danh sách tầng',
  '/settings/categories/task-types': 'Loại công việc',
  '/settings/templates': 'Mẫu biểu',
  '/settings/signatures': 'Mẫu chữ ký',
  '/settings/organization': 'Tổ chức',
  '/settings/members': 'Thành viên',
  '/settings/roles': 'Mẫu vai trò',
  '/settings/ai-copilot': 'Trợ lý AI',

  // Tài khoản
  '/account': 'Tài khoản',
  '/account/profile': 'Thông tin cá nhân',
  '/account/subscription': 'Gói cước',

  // Thông tin khác
  '/faq': 'Câu hỏi thường gặp',
  '/changelog': 'Lịch sử cập nhật',
  '/app-guide': 'Hướng dẫn sử dụng App',
};

// Parent group mapping - maps routes to their logical parent group per SUMMARY.md
const routeParentGroups: Record<string, { label: string; path?: string }[]> = {
  // Danh mục dữ liệu
  '/buildings': [{ label: 'Danh mục dữ liệu' }],
  '/apartments': [{ label: 'Danh mục dữ liệu' }],
  '/rooms': [{ label: 'Danh mục dữ liệu' }],
  '/services': [{ label: 'Danh mục dữ liệu' }],
  '/assets': [{ label: 'Danh mục dữ liệu' }],

  // Khách hàng
  '/leads': [{ label: 'Khách hàng' }],
  '/deposits': [{ label: 'Khách hàng' }],
  '/contracts': [{ label: 'Khách hàng' }],
  '/customers': [{ label: 'Khách hàng' }],
  '/tenants': [{ label: 'Khách hàng' }],
  '/vehicles': [{ label: 'Khách hàng' }],

  // Tài chính
  '/meter-readings': [{ label: 'Tài chính' }],
  '/invoices': [{ label: 'Tài chính' }],
  '/income-expense': [{ label: 'Tài chính' }],
  '/payments': [{ label: 'Tài chính' }],
};

/**
 * Checks if a path segment looks like a UUID (detail page).
 */
function isUuidSegment(segment: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
}

const Breadcrumbs = () => {
  const location = useLocation();
  const pathnames = location.pathname.split('/').filter((x) => x);

  // If on home page, don't show breadcrumbs
  if (pathnames.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage className="flex items-center gap-1">
              <Home className="h-4 w-4" />
              <span>Bảng tin</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  // Build breadcrumb items from path segments
  const breadcrumbItems: { path: string; label: string; isLast: boolean }[] = [];

  // Check for parent group context on top-level pages
  const fullPath = location.pathname;
  const topLevelPath = `/${pathnames[0]}`;
  const parentGroups = routeParentGroups[topLevelPath];

  if (parentGroups) {
    parentGroups.forEach((group) => {
      breadcrumbItems.push({
        path: group.path || '#',
        label: group.label,
        isLast: false,
      });
    });
  }

  // Add path segments
  pathnames.forEach((segment, index) => {
    const path = `/${pathnames.slice(0, index + 1).join('/')}`;
    const isLast = index === pathnames.length - 1;

    // Skip UUID segments but show "Chi tiết" label
    if (isUuidSegment(segment)) {
      breadcrumbItems.push({ path, label: 'Chi tiết', isLast });
      return;
    }

    const label = routeLabels[path] || segment;
    breadcrumbItems.push({ path, label, isLast });
  });

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {/* Home */}
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/" className="flex items-center gap-1">
              <Home className="h-4 w-4" />
              <span className="hidden sm:inline">Bảng tin</span>
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Breadcrumb items */}
        {breadcrumbItems.map((item) => (
          <div key={item.path + item.label} className="flex items-center gap-2">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {item.isLast ? (
                <BreadcrumbPage className="font-medium">
                  {item.label}
                </BreadcrumbPage>
              ) : item.path === '#' ? (
                <span className="text-muted-foreground text-sm">{item.label}</span>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={item.path}>{item.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </div>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};

export default Breadcrumbs;
