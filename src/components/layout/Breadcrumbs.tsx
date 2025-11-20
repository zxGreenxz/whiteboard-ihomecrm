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

// Route to label mapping
const routeLabels: Record<string, string> = {
  '/': 'Tổng quan',
  '/areas': 'Khu vực',
  '/buildings': 'Tòa nhà',
  '/rooms': 'Phòng',
  '/beds': 'Giường',
  '/services': 'Dịch vụ',
  '/leads': 'Khách hẹn',
  '/deposits': 'Đặt cọc',
  '/contracts': 'Hợp đồng',
  '/tenants': 'Khách thuê',
  '/vehicles': 'Phương tiện',
  '/meter-readings': 'Ghi chỉ số',
  '/invoices': 'Hóa đơn',
  '/payments': 'Thu chi',
  '/cash-book': 'Sổ quỹ',
  '/assets': 'Tài sản',
  '/issues': 'Sự cố',
  '/reports': 'Báo cáo',
  '/reports/real-estate': 'Báo cáo BĐS',
  '/reports/real-estate/vacant-rooms': 'Phòng trống',
  '/reports/real-estate/expiring-contracts': 'Hợp đồng sắp hết hạn',
  '/reports/real-estate/occupancy': 'Tỷ lệ lấp đầy',
  '/reports/real-estate/promotions': 'Khuyến mại',
  '/reports/real-estate/new-leases': 'Cho thuê mới',
  '/reports/real-estate/terminations': 'Hợp đồng kết thúc',
  '/reports/real-estate/price-history': 'Lịch sử giá',
  '/reports/real-estate/contract-changes': 'Thay đổi hợp đồng',
  '/reports/finance': 'Báo cáo tài chính',
  '/reports/finance/cash-book': 'Sổ quỹ',
  '/reports/finance/cash-flow': 'Dòng tiền',
  '/reports/finance/debt': 'Công nợ',
  '/reports/finance/customer-debt': 'Công nợ khách hàng',
  '/reports/finance/payment-schedule': 'Lịch thanh toán',
  '/reports/finance/overpayment': 'Thanh toán thừa',
  '/reports/finance/deposits': 'Tiền đặt cọc',
  '/reports/finance/profit-distribution': 'Phân bổ lợi nhuận',
  '/reports/tasks': 'Báo cáo công việc',
  '/reports/tasks/overview': 'Tổng quan công việc',
  '/reports/tasks/by-staff': 'Công việc theo nhân viên',
  '/reports/tasks/by-room': 'Công việc theo phòng',
  '/settings': 'Cài đặt',
  '/settings/general': 'Cài đặt chung',
  '/settings/templates': 'Mẫu biểu',
  '/settings/signatures': 'Mẫu chữ ký',
  '/settings/staff': 'Nhân viên',
};

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
              <span>Tổng quan</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const breadcrumbItems = pathnames.map((_, index) => {
    const path = `/${pathnames.slice(0, index + 1).join('/')}`;
    const label = routeLabels[path] || pathnames[index];
    const isLast = index === pathnames.length - 1;

    return { path, label, isLast };
  });

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {/* Home */}
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/" className="flex items-center gap-1">
              <Home className="h-4 w-4" />
              <span className="hidden sm:inline">Tổng quan</span>
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Breadcrumb items */}
        {breadcrumbItems.map((item, index) => (
          <div key={item.path} className="flex items-center gap-2">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {item.isLast ? (
                <BreadcrumbPage className="font-medium">
                  {item.label}
                </BreadcrumbPage>
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
