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
  '/reports/finance': 'Báo cáo tài chính',
  '/reports/tasks': 'Báo cáo công việc',
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
