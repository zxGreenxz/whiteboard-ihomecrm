import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useEffectivePermissions, can } from '@/hooks/usePermissions';
import {
  LayoutDashboard,
  Building2,
  Home,
  Bed,
  Wrench,
  Users,
  UserPlus,
  DollarSign,
  FileText,
  User,
  Car,
  Gauge,
  Receipt,
  CreditCard,
  Package,
  BarChart3,
  Settings,
  UserCog,
  ChevronDown,
  Map,
  MapPin,
  Bell,
  List,
  ClipboardList,
  UserCircle,
  HelpCircle,
  History,
  Smartphone,
  Wallet,
  Book,
  TrendingUp,
  PieChart,
  Calendar,
  Coins,
} from 'lucide-react';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  // Optional: nếu set, item bị ẩn khi user không có quyền. Bỏ qua = mọi user
  // đã đăng nhập đều thấy (vd Tài khoản, FAQ).
  permission?: { resource: string; action?: string };
}

interface NavSection {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

interface NavGroup {
  label: string;
  items: (NavItem | NavSection)[];
}

// Navigation configuration - khớp 100% SUMMARY.md
const navigationGroups: NavGroup[] = [
  {
    label: 'THEO DÕI NHANH',
    items: [
      { title: 'Bảng tin', href: '/', icon: LayoutDashboard, permission: { resource: 'dashboard' } },
      { title: 'Sơ đồ toà nhà', href: '/building-map', icon: Map, permission: { resource: 'building_layout' } },
    ],
  },
  {
    label: 'QUẢN LÝ & VẬN HÀNH',
    items: [
      {
        title: 'Danh mục dữ liệu',
        icon: Building2,
        items: [
          { title: 'Khu vực', href: '/areas', icon: MapPin, permission: { resource: 'areas' } },
          { title: 'Toà nhà', href: '/buildings', icon: Building2, permission: { resource: 'buildings' } },
          { title: 'Căn hộ', href: '/apartments', icon: Home, permission: { resource: 'rooms' } },
          { title: 'Giường', href: '/beds', icon: Bed, permission: { resource: 'beds' } },
          { title: 'Dịch vụ', href: '/services', icon: Wrench, permission: { resource: 'services' } },
          { title: 'Tài sản', href: '/assets', icon: Package, permission: { resource: 'assets' } },
        ],
      },
      {
        title: 'Khách hàng',
        icon: Users,
        items: [
          { title: 'Khách hẹn', href: '/leads', icon: UserPlus, permission: { resource: 'leads' } },
          { title: 'Đặt cọc', href: '/deposits', icon: DollarSign, permission: { resource: 'deposits' } },
          { title: 'Hợp đồng', href: '/contracts', icon: FileText, permission: { resource: 'contracts' } },
          { title: 'Khách hàng', href: '/customers', icon: User, permission: { resource: 'customers' } },
          { title: 'Phương tiện', href: '/vehicles', icon: Car, permission: { resource: 'vehicles' } },
        ],
      },
      {
        title: 'Tài chính',
        icon: CreditCard,
        items: [
          { title: 'Ghi chỉ số', href: '/meter-readings', icon: Gauge, permission: { resource: 'meter_readings' } },
          { title: 'Hoá đơn', href: '/invoices', icon: Receipt, permission: { resource: 'invoices' } },
          { title: 'Thu chi', href: '/income-expense', icon: CreditCard, permission: { resource: 'income_expenses' } },
          { title: 'Sổ quỹ', href: '/finance/cashbooks', icon: Wallet, permission: { resource: 'cashbooks' } },
        ],
      },
      { title: 'Công việc', href: '/tasks', icon: ClipboardList, permission: { resource: 'tasks' } },
      { title: 'Thông báo', href: '/notifications', icon: Bell, permission: { resource: 'notifications' } },
    ],
  },
  {
    label: 'BÁO CÁO',
    items: [
      { title: 'Báo cáo bất động sản', href: '/reports/real-estate', icon: BarChart3, permission: { resource: 'reports_real_estate' } },
      {
        title: 'Báo cáo tài chính',
        icon: CreditCard,
        items: [
          { title: 'Tài khoản theo ngày', href: '/report/finance/cashbook', icon: Book, permission: { resource: 'reports_finance' } },
          { title: 'Dòng tiền', href: '/report/finance/cash-flow', icon: TrendingUp, permission: { resource: 'reports_finance' } },
          { title: 'Phân bổ lợi nhuận', href: '/report/finance-by-month', icon: PieChart, permission: { resource: 'reports_finance' } },
          { title: 'Công nợ hợp đồng mới', href: '/reports/finance/new-contract-debt', icon: FileText, permission: { resource: 'reports_finance' } },
          { title: 'Khách nợ tiền', href: '/report/finance/debt', icon: Users, permission: { resource: 'reports_finance' } },
          { title: 'Lịch thanh toán', href: '/report/finance/billing-calendar', icon: Calendar, permission: { resource: 'reports_finance' } },
          { title: 'Tiền thừa', href: '/report/finance/prepaid', icon: Coins, permission: { resource: 'reports_finance' } },
          { title: 'Danh sách tiền cọc', href: '/report/finance/deposit', icon: Wallet, permission: { resource: 'reports_finance' } },
        ],
      },
    ],
  },
  {
    label: 'CÀI ĐẶT HỆ THỐNG',
    items: [
      {
        title: 'Cài đặt hệ thống',
        icon: Settings,
        items: [
          { title: 'Cài đặt chung', href: '/settings/general', icon: Settings, permission: { resource: 'settings' } },
          { title: 'Danh mục khác', href: '/settings/categories', icon: List, permission: { resource: 'categories' } },
          { title: 'Mẫu biểu', href: '/settings/templates', icon: FileText, permission: { resource: 'templates' } },
          { title: 'Nhân viên', href: '/settings/staff', icon: UserCog, permission: { resource: 'users' } },
        ],
      },
    ],
  },
  {
    label: 'TÀI KHOẢN',
    items: [
      {
        title: 'Tài khoản',
        icon: UserCircle,
        items: [
          // Không gắn permission — mọi user đã login đều thấy.
          { title: 'Thông tin cá nhân', href: '/account/profile', icon: User },
          { title: 'Gói cước', href: '/account/subscription', icon: CreditCard },
        ],
      },
    ],
  },
];

interface SidebarProps {
  className?: string;
}

const Sidebar = ({ className }: SidebarProps) => {
  const location = useLocation();
  const { data: perms } = useEffectivePermissions();

  // Item không có `permission` luôn pass. Có permission thì check via can().
  const allowedItem = (item: NavItem): boolean => {
    if (!item.permission) return true;
    return can(perms, item.permission.resource, item.permission.action ?? 'view');
  };

  // Lọc cấu hình theo quyền. Section trống → bỏ. Group trống → bỏ.
  const filteredGroups = navigationGroups
    .map((group) => {
      const items = group.items
        .map((entry) => {
          if ('items' in entry) {
            const subItems = entry.items.filter(allowedItem);
            return subItems.length > 0 ? { ...entry, items: subItems } : null;
          }
          return allowedItem(entry) ? entry : null;
        })
        .filter((x): x is NavItem | NavSection => x !== null);
      return items.length > 0 ? { ...group, items } : null;
    })
    .filter((g): g is NavGroup => g !== null);

  const [openSections, setOpenSections] = useState<string[]>(() => {
    // Auto-open sections that contain the current active route
    const active: string[] = [];
    navigationGroups.forEach((group) => {
      group.items.forEach((section) => {
        if ('items' in section) {
          const hasActiveItem = section.items.some(
            (item) => location.pathname === item.href || location.pathname.startsWith(item.href + '/')
          );
          if (hasActiveItem) {
            active.push(section.title);
          }
        }
      });
    });
    return active;
  });

  const toggleSection = (title: string) => {
    setOpenSections((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
    );
  };

  const isActive = (href: string) => {
    if (href === '/') {
      return location.pathname === '/';
    }
    return location.pathname === href || location.pathname.startsWith(href + '/');
  };

  const renderNavItem = (item: NavItem) => {
    const active = isActive(item.href);
    const Icon = item.icon;

    return (
      <Link key={item.href} to={item.href}>
        <Button
          variant="ghost"
          className={cn(
            'w-full justify-start gap-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            active && 'bg-sidebar-accent text-sidebar-primary font-medium'
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="text-sm">{item.title}</span>
        </Button>
      </Link>
    );
  };

  const renderSection = (section: NavSection) => {
    const isOpen = openSections.includes(section.title);
    const Icon = section.icon;
    const hasActiveItem = section.items.some((item) => isActive(item.href));

    return (
      <Collapsible
        key={section.title}
        open={isOpen}
        onOpenChange={() => toggleSection(section.title)}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              'w-full justify-between gap-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              hasActiveItem && 'text-sidebar-primary'
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              <span className="text-sm font-medium">{section.title}</span>
            </div>
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform',
                isOpen && 'rotate-180'
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 pl-4 pt-1">
          {section.items.map((item) => renderNavItem(item))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <aside
      className={cn(
        'flex flex-col w-64 h-[calc(100vh-4rem)] bg-sidebar text-sidebar-foreground',
        className
      )}
    >
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-4">
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((section) =>
                  'items' in section ? renderSection(section) : renderNavItem(section)
                )}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* Footer info */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 mb-2">
          <Link to="/faq" className="text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground flex items-center gap-1">
            <HelpCircle className="h-3 w-3" />
            FAQ
          </Link>
          <Link to="/changelog" className="text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground flex items-center gap-1">
            <History className="h-3 w-3" />
            Lịch sử cập nhật
          </Link>
          <Link to="/app-guide" className="text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground flex items-center gap-1">
            <Smartphone className="h-3 w-3" />
            Hướng dẫn App
          </Link>
        </div>
        <div className="text-xs text-sidebar-foreground/70">
          <p className="font-medium text-sidebar-foreground">CRM v1.0.0</p>
          <p>Quản lý bất động sản</p>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
