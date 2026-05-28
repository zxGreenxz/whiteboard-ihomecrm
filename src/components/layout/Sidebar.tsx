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
import {
  LayoutDashboard,
  Building2,
  Home,
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
      { title: 'Bảng tin', href: '/', icon: LayoutDashboard },
      { title: 'Sơ đồ toà nhà', href: '/building-map', icon: Map },
    ],
  },
  {
    label: 'QUẢN LÝ & VẬN HÀNH',
    items: [
      {
        title: 'Danh mục dữ liệu',
        icon: Building2,
        items: [
          { title: 'Khu vực', href: '/areas', icon: MapPin },
          { title: 'Toà nhà', href: '/buildings', icon: Building2 },
          { title: 'Căn hộ', href: '/apartments', icon: Home },
          { title: 'Dịch vụ', href: '/services', icon: Wrench },
          { title: 'Tài sản', href: '/assets', icon: Package },
          { title: 'Kho vật tư', href: '/materials', icon: Package },
          { title: 'Phiếu nhập kho', href: '/materials/purchases', icon: Receipt },
        ],
      },
      {
        title: 'Khách hàng',
        icon: Users,
        items: [
          { title: 'Khách hẹn', href: '/leads', icon: UserPlus },
          { title: 'Đặt cọc', href: '/deposits', icon: DollarSign },
          { title: 'Hợp đồng', href: '/contracts', icon: FileText },
          { title: 'Khách hàng', href: '/customers', icon: User },
          { title: 'Phương tiện', href: '/vehicles', icon: Car },
        ],
      },
      {
        title: 'Tài chính',
        icon: CreditCard,
        items: [
          { title: 'Ghi chỉ số', href: '/meter-readings', icon: Gauge },
          { title: 'Hoá đơn', href: '/invoices', icon: Receipt },
          { title: 'Thu chi', href: '/income-expense', icon: CreditCard },
          { title: 'Sổ quỹ', href: '/finance/cashbooks', icon: Wallet },
        ],
      },
      { title: 'Công việc', href: '/tasks', icon: ClipboardList },
      { title: 'Thông báo', href: '/notifications', icon: Bell },
    ],
  },
  {
    label: 'BÁO CÁO',
    items: [
      { title: 'Báo cáo bất động sản', href: '/reports/real-estate', icon: BarChart3 },
      {
        title: 'Báo cáo tài chính',
        icon: CreditCard,
        items: [
          { title: 'Tài khoản theo ngày', href: '/report/finance/cashbook', icon: Book },
          { title: 'Dòng tiền', href: '/report/finance/cash-flow', icon: TrendingUp },
          { title: 'Phân bổ lợi nhuận', href: '/report/finance-by-month', icon: PieChart },
          { title: 'Công nợ hợp đồng mới', href: '/reports/finance/new-contract-debt', icon: FileText },
          { title: 'Khách nợ tiền', href: '/report/finance/debt', icon: Users },
          { title: 'Lịch thanh toán', href: '/report/finance/billing-calendar', icon: Calendar },
          { title: 'Tiền thừa', href: '/report/finance/prepaid', icon: Coins },
          { title: 'Danh sách tiền cọc', href: '/report/finance/deposit', icon: Wallet },
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
          { title: 'Cài đặt chung', href: '/settings/general', icon: Settings },
          { title: 'Danh mục khác', href: '/settings/categories', icon: List },
          { title: 'Mẫu biểu', href: '/settings/templates', icon: FileText },
          { title: 'Nhân viên', href: '/settings/staff', icon: UserCog },
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
          {navigationGroups.map((group) => (
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
