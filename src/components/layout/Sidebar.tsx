import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { prefetchOnIntent } from '@/lib/prefetchIntent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';
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
  HandCoins,
  CreditCard,
  Package,
  BarChart3,
  Settings,
  UserCog,
  ChevronDown,
  Map,
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
  Share2,
  MessageSquare,
} from 'lucide-react';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Quyền cần để THẤY mục này trên sidebar — phải khớp đúng (module, action)
   * mà route guard <RequirePermission> dùng trong App.tsx. Thiếu quyền → ẩn
   * khỏi sidebar (không hiện rồi bấm-bị-đá-về-trang-chủ). Bỏ trống `module` =
   * luôn hiện (vd Bảng tin, trang tài khoản cá nhân).
   */
  module?: string;
  /** Action cần — mặc định "view". */
  action?: ActionKey;
  /**
   * Với NHÂN VIÊN (không phải admin của module): mở `selfHref` ở TAB MỚI thay vì
   * điều hướng in-app. Dùng cho "Bảng lương" → trang "Lương của tôi" trọn-màn QUEST.
   * Admin (lock/manage_salary/distribute) vẫn vào trang quản lý in-app như cũ.
   */
  selfHref?: string;
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
//
// Mỗi mục khai báo (module, action) ĐÚNG bằng quyền route guard
// <RequirePermission> trong App.tsx kiểm — sidebar tự ẩn mục thiếu quyền (xem
// useMyPermissions + canUse bên dưới). Mục KHÔNG có guard ở route (Bảng tin,
// trang tài khoản cá nhân, FAQ…) thì bỏ `module` để luôn hiện.
const navigationGroups: NavGroup[] = [
  {
    label: 'THEO DÕI NHANH',
    items: [
      // Bảng tin = trang chủ kiêm fallback của RequirePermission → luôn hiện.
      { title: 'Bảng tin', href: '/', icon: LayoutDashboard },
      { title: 'Sơ đồ toà nhà', href: '/building-map', icon: Map, module: 'buildings' },
    ],
  },
  {
    label: 'KÊNH CHAT',
    items: [
      { title: 'Chat Zalo', href: '/chat-zalo', icon: MessageSquare, module: 'chat_zalo' },
    ],
  },
  {
    label: 'QUẢN LÝ & VẬN HÀNH',
    items: [
      {
        title: 'Danh mục dữ liệu',
        icon: Building2,
        items: [
          // "Khu vực" không còn trang riêng — chỉ là nhãn nhóm toà nhà, quản lý
          // bằng dialog trong trang Toà nhà; mọi ô lọc chọn theo khu vực qua
          // BuildingMultiSelect (click tên khu = chọn cả nhóm toà).
          { title: 'Toà nhà', href: '/buildings', icon: Building2, module: 'buildings' },
          { title: 'Căn hộ', href: '/apartments', icon: Home, module: 'rooms' },
          { title: 'Dịch vụ', href: '/services', icon: Wrench, module: 'services' },
          { title: 'Sale Phòng', href: '/sale-phong', icon: Share2, module: 'sale_phong' },
          { title: 'Tài sản', href: '/assets', icon: Package, module: 'assets' },
          { title: 'Kho vật tư', href: '/materials', icon: Package, module: 'materials' },
        ],
      },
      {
        title: 'Khách hàng',
        icon: Users,
        items: [
          { title: 'Khách hẹn', href: '/leads', icon: UserPlus, module: 'leads' },
          { title: 'Đặt cọc', href: '/deposits', icon: DollarSign, module: 'deposits' },
          { title: 'Hợp đồng', href: '/contracts', icon: FileText, module: 'contracts' },
          { title: 'Khách hàng', href: '/customers', icon: User, module: 'customers' },
          { title: 'Phương tiện', href: '/vehicles', icon: Car, module: 'vehicles' },
        ],
      },
      {
        title: 'Tài chính',
        icon: CreditCard,
        items: [
          { title: 'Ghi chỉ số', href: '/meter-readings', icon: Gauge, module: 'meter_readings' },
          { title: 'Hoá đơn', href: '/invoices', icon: Receipt, module: 'invoices' },
          { title: 'Thu tiền', href: '/thu-tien', icon: HandCoins, module: 'thu_tien' },
          { title: 'Thu chi', href: '/income-expense', icon: CreditCard, module: 'income_expenses' },
          { title: 'Sổ quỹ', href: '/finance/cashbooks', icon: Wallet, module: 'cashbooks' },
          { title: 'Chia lợi nhuận', href: '/reports/finance/profit-distribution', icon: PieChart, module: 'shareholder_profit' },
          { title: 'Bảng lương', href: '/finance/salary', icon: HandCoins, module: 'salary', selfHref: '/finance/my-salary' },
          { title: 'Ví cá nhân', href: '/finance/personal-wallet', icon: Coins, module: 'personal_finance' },
        ],
      },
      { title: 'Công việc', href: '/tasks', icon: ClipboardList, module: 'tasks' },
      { title: 'Thông báo', href: '/notifications', icon: Bell, module: 'notifications' },
    ],
  },
  {
    label: 'BÁO CÁO',
    items: [
      { title: 'Báo cáo bất động sản', href: '/reports/real-estate', icon: BarChart3, module: 'reports_real_estate' },
      {
        title: 'Báo cáo tài chính',
        icon: CreditCard,
        items: [
          // Mỗi báo cáo gate theo action riêng của module reports_finance —
          // khớp đúng RequirePermission của route tương ứng trong App.tsx.
          { title: 'Phân tích tài chính', href: '/report/finance/analysis', icon: BarChart3, module: 'reports_finance', action: 'analysis' },
          { title: 'Tài khoản theo ngày', href: '/report/finance/cashbook', icon: Book, module: 'reports_finance', action: 'daily_cashbook' },
          { title: 'Dòng tiền', href: '/report/finance/cash-flow', icon: TrendingUp, module: 'reports_finance', action: 'cash_flow' },
          { title: 'Phân bổ lợi nhuận', href: '/reports/finance/profit-distribution', icon: PieChart, module: 'reports_finance', action: 'profit_distribution' },
          { title: 'Công nợ hợp đồng mới', href: '/reports/finance/new-contract-debt', icon: FileText, module: 'reports_finance', action: 'debt' },
          { title: 'Khách nợ tiền', href: '/report/finance/debt', icon: Users, module: 'reports_finance', action: 'customer_debt' },
          { title: 'Lịch thanh toán', href: '/report/finance/billing-calendar', icon: Calendar, module: 'reports_finance', action: 'payment_schedule' },
          { title: 'Tiền thừa', href: '/report/finance/prepaid', icon: Coins, module: 'reports_finance', action: 'overpayment' },
          { title: 'Danh sách tiền cọc', href: '/report/finance/deposit', icon: Wallet, module: 'reports_finance', action: 'deposits_report' },
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
          { title: 'Cài đặt chung', href: '/settings/general', icon: Settings, module: 'settings' },
          { title: 'Danh mục khác', href: '/settings/categories', icon: List, module: 'categories' },
          { title: 'Mẫu biểu', href: '/settings/templates', icon: FileText, module: 'templates' },
          { title: 'Nhân viên', href: '/settings/staff', icon: UserCog, module: 'users' },
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
          // Trang cá nhân — không gate quyền, luôn hiện.
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
  const queryClient = useQueryClient();
  const { data: perms, isLoading: permsLoading } = useMyPermissions();

  // Admin Bảng lương = có quyền chốt/quản lý/chi lương (hoặc superadmin). Nhân viên
  // thường (self-view) sẽ mở "Lương của tôi" ở tab mới thay vì vào trang quản lý.
  const salaryAdmin =
    !!(perms as any)?.__superadmin ||
    canUse(perms, 'salary', 'lock') ||
    canUse(perms, 'salary', 'manage_salary') ||
    canUse(perms, 'salary', 'distribute');

  // Mục chỉ hiện khi có quyền XEM tương ứng (đúng quyền route guard kiểm).
  // Mục không khai báo `module` (Bảng tin, trang cá nhân) luôn hiện.
  const canShow = (item: NavItem) =>
    !item.module || canUse(perms, item.module, item.action ?? 'view');

  // Lọc cây điều hướng theo quyền: ẩn mục thiếu quyền, ẩn luôn section/nhóm
  // rỗng (không còn mục con nào để hiện).
  const visibleGroups: NavGroup[] = navigationGroups
    .map((group) => {
      const items = group.items.reduce<(NavItem | NavSection)[]>((acc, entry) => {
        if ('items' in entry) {
          const children = entry.items.filter(canShow);
          if (children.length) acc.push({ ...entry, items: children });
        } else if (canShow(entry)) {
          acc.push(entry);
        }
        return acc;
      }, []);
      return { ...group, items };
    })
    .filter((group) => group.items.length > 0);

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

    const inner = (
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
    );

    // Nhân viên (không phải admin module): mở trang self-view ở TAB MỚI.
    if (item.selfHref && !salaryAdmin) {
      return (
        <a key={item.href} href={item.selfHref} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      );
    }

    // Nạp nền theo ý định: rê chuột/focus vào mục → ấm cache trước khi bấm
    // (chỉ 4 trang list nặng được map trong prefetchOnIntent; href khác no-op).
    return (
      <Link
        key={item.href}
        to={item.href}
        onPointerEnter={() => prefetchOnIntent(queryClient, item.href)}
        onFocus={() => prefetchOnIntent(queryClient, item.href)}
      >
        {inner}
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
        {permsLoading ? (
          // Chưa biết quyền — hiện skeleton thay vì nháy toàn bộ menu rồi co lại.
          <div className="space-y-2 px-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <nav className="space-y-4">
            {visibleGroups.map((group) => (
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
        )}
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
