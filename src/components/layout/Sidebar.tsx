import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { prefetchOnIntent } from '@/lib/prefetchIntent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth, useLogout } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import {
  SIDEBAR_EASING,
  SIDEBAR_FULL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_TRANSITION_MS,
} from './useSidebarState';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useBusinessPerformanceOrganizations } from '@/hooks/reports/useBusinessPerformance';
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
  Banknote,
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
  Sparkles,
  Gift,
  Landmark,
  ShieldCheck,
  PanelLeft,
  Pin,
  PinOff,
  LogOut,
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
  /** Business Performance chỉ hiện sau khi roster tổ chức tải thành công và không rỗng. */
  requiresBusinessPerformanceOrganization?: boolean;
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
          // Đóng tiền Tập trung theo Kỳ (tách khỏi overlay của /thu-tien).
          { title: 'Thanh toán', href: '/thanh-toan', icon: Banknote, module: 'thu_tien', action: 'collect' },
          { title: 'Thu chi', href: '/income-expense', icon: CreditCard, module: 'income_expenses' },
          // Hộp thư duyệt: không khai `module` → luôn hiện, khớp route /approvals
          // (không bọc RequirePermission). RPC lọc theo auth.uid() nên người không
          // phải bước duyệt nào chỉ thấy danh sách rỗng.
          { title: 'Chờ duyệt', href: '/approvals', icon: ClipboardList },
          { title: 'Sổ quỹ', href: '/finance/cashbooks', icon: Wallet, module: 'cashbooks' },
          // Cấu hình giá phí cố định theo toà — nguồn gợi ý số tiền cho /thanh-toan.
          { title: 'Phí cố định', href: '/settings/finance/fixed-fees', icon: Settings, module: 'thu_tien', action: 'collect' },
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
          { title: 'Trung tâm tài chính', href: '/reports/finance/business-performance', icon: BarChart3, requiresBusinessPerformanceOrganization: true },
          { title: 'Phân tích tài chính', href: '/reports/finance/analysis', icon: BarChart3, module: 'reports_finance', action: 'analysis' },
          { title: 'Tài khoản theo ngày', href: '/reports/finance/daily-cashbook', icon: Book, module: 'reports_finance', action: 'daily_cashbook' },
          { title: 'Dòng tiền', href: '/reports/finance/cash-flow', icon: TrendingUp, module: 'reports_finance', action: 'cash_flow' },
          { title: 'Báo cáo Lợi Nhuận', href: '/reports/finance/profit-distribution', icon: PieChart, module: 'reports_finance', action: 'profit_distribution' },
          { title: 'Lịch thanh toán', href: '/reports/finance/payment-schedule', icon: Calendar, module: 'reports_finance', action: 'payment_schedule' },
          { title: 'Tiền thừa', href: '/reports/finance/overpayment', icon: Coins, module: 'reports_finance', action: 'overpayment' },
          { title: 'Danh sách tiền cọc', href: '/reports/finance/deposits', icon: Wallet, module: 'reports_finance', action: 'deposits_report' },
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
          { title: 'Tổ chức', href: '/settings/organization', icon: Landmark, module: 'users' },
          { title: 'Thành viên', href: '/settings/members', icon: UserCog, module: 'users' },
          { title: 'Mẫu vai trò', href: '/settings/roles', icon: ShieldCheck, module: 'users' },
          // Quản trị AI Copilot: super admin = full (kill switch/entitlements/
          // providers/chi phí); owner/user thường = tab Sử dụng (gate trong page)
          { title: 'Trợ lý AI', href: '/settings/ai-copilot', icon: Sparkles, module: 'ai_copilot' },
          // Sự kiện quay số may mắn: không gắn `module` vì tính năng nằm ngoài
          // ma trận phân quyền theo sổ/toà — RPC tự chặn OWNER/STAFF (42501).
          { title: 'Quay số may mắn', href: '/quayso/admin', icon: Gift },
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
  /**
   * Thu về RAIL 72px chỉ-icon. Mặc định false = panel 264px đầy đủ (drawer
   * mobile và mọi chỗ render sidebar không có chrome thu gọn).
   */
  collapsed?: boolean;
  /** Panel đang NỔI ĐÈ lên nội dung (mở tạm bằng chuột, chưa ghim) → đổ bóng. */
  floating?: boolean;
  /** Đã ghim mở — đổi icon nút ghim + aria-pressed. */
  pinned?: boolean;
  /** Thời lượng chuyển động; 0 khi user bật prefers-reduced-motion. */
  durationMs?: number;
  onToggle?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  /**
   * Chuông thông báo. Truyền từ MainLayout để Sidebar không kéo theo hook
   * notifications (và supabase client) vào những nơi chỉ render cây điều hướng.
   */
  notificationSlot?: React.ReactNode;
}

const Sidebar = ({
  className,
  collapsed = false,
  floating = false,
  pinned = false,
  durationMs = SIDEBAR_TRANSITION_MS,
  onToggle,
  onPointerEnter,
  onPointerLeave,
  notificationSlot,
}: SidebarProps) => {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data: perms, isLoading: permsLoading } = useMyPermissions();
  const { data: user } = useAuth();
  const { data: profile } = useProfile();
  const logoutMutation = useLogout();

  // Chữ mờ nhanh hơn width một nhịp để không thấy chữ "bò" theo mép panel.
  const fadeMs = durationMs === 0 ? 0 : 140;
  const fadeLabel = cn(
    'transition-opacity [transition-duration:var(--sb-fade)]',
    collapsed && 'pointer-events-none opacity-0'
  );

  const getUserInitials = () => {
    if (profile?.full_name) {
      const names = profile.full_name.trim().split(/\s+/);
      if (names.length >= 2) {
        return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
      }
      return profile.full_name.substring(0, 2).toUpperCase();
    }
    return user?.email?.substring(0, 2).toUpperCase() || 'U';
  };

  const businessPerformanceOrganizations = useBusinessPerformanceOrganizations();
  const canShowBusinessPerformance =
    businessPerformanceOrganizations.isSuccess &&
    (businessPerformanceOrganizations.data?.length ?? 0) > 0;

  // Admin Bảng lương = có quyền chốt/quản lý/chi lương (hoặc superadmin). Nhân viên
  // thường (self-view) sẽ mở "Lương của tôi" ở tab mới thay vì vào trang quản lý.
  const salaryAdmin =
    !!perms?.__superadmin ||
    canUse(perms, 'salary', 'lock') ||
    canUse(perms, 'salary', 'manage_salary') ||
    canUse(perms, 'salary', 'distribute');

  // Mục chỉ hiện khi có quyền XEM tương ứng (đúng quyền route guard kiểm).
  // Mục không khai báo `module` (Bảng tin, trang cá nhân) luôn hiện.
  const canShow = (item: NavItem) => {
    if (item.requiresBusinessPerformanceOrganization) {
      return canShowBusinessPerformance;
    }
    return !item.module || canUse(perms, item.module, item.action ?? 'view');
  };

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
        // Ở rail chỉ còn icon: nhãn phải có title để vẫn đọc được khi hover.
        title={collapsed ? item.title : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className={cn('truncate text-sm', fadeLabel)}>{item.title}</span>
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
        // Ở rail, menu con XỔ DỌC không dùng được (icon con thụt lề sẽ lệch trục
        // icon cha). Thu hết về một hàng icon; rê chuột bung panel là mở lại.
        open={isOpen && !collapsed}
        onOpenChange={() => toggleSection(section.title)}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              'w-full justify-between gap-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              hasActiveItem && 'text-sidebar-primary'
            )}
            title={collapsed ? section.title : undefined}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0" />
              <span className={cn('truncate text-sm font-medium', fadeLabel)}>
                {section.title}
              </span>
            </div>
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 transition-transform',
                isOpen && !collapsed && 'rotate-180',
                fadeLabel
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

  const toggleLabel = pinned ? 'Thu gọn sidebar (Ctrl/⌘ + B)' : 'Ghim sidebar mở (Ctrl/⌘ + B)';

  return (
    <aside
      className={cn(
        'flex h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        className
      )}
      style={{
        width: collapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_FULL_WIDTH,
        // Chỉ animate width/box-shadow/opacity — không đụng tới nội dung bên trong.
        transitionProperty: 'width, box-shadow',
        transitionDuration: `${durationMs}ms`,
        transitionTimingFunction: SIDEBAR_EASING,
        boxShadow: floating ? '0 20px 44px -18px rgba(6, 40, 28, 0.42)' : undefined,
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/*
        Bọc trong khối RỘNG CỐ ĐỊNH 264px: khi aside co về rail, mọi thứ bên
        trong bị xén chứ KHÔNG bố trí lại → icon giữ nguyên toạ độ X tuyệt đối,
        chỉ phần chữ mờ dần. Đây là chi tiết quyết định cảm giác "mượt".
      */}
      <div
        className="flex h-full flex-col"
        style={{ width: SIDEBAR_FULL_WIDTH, ['--sb-fade' as string]: `${fadeMs}ms` }}
      >
        {/*
          Logo + nút ghim (thay cho thanh header trên cùng đã bỏ ở desktop).
          Không có `onToggle` (drawer mobile) thì cả ô logo là link về trang chủ
          và bỏ hẳn nút ghim — chỗ đó dành cho nút đóng của Sheet.
        */}
        <div className="flex h-[60px] flex-none items-center gap-2 border-b border-sidebar-border pl-5 pr-3">
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              title={toggleLabel}
              className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-primary text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <PanelLeft className="h-[18px] w-[18px]" />
            </button>
          ) : (
            <Link
              to="/"
              aria-label="Về trang chủ"
              className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-primary text-white shadow-sm"
            >
              <PanelLeft className="h-[18px] w-[18px]" />
            </Link>
          )}
          <Link
            to="/"
            aria-label="Về trang chủ"
            className={cn('flex min-w-0 flex-1 flex-col leading-tight', fadeLabel)}
            tabIndex={collapsed ? -1 : undefined}
          >
            <span className="truncate text-[15px] font-bold text-primary">CRM</span>
            <span className="-mt-0.5 truncate text-[10px] text-muted-foreground">
              Quản lý bất động sản
            </span>
          </Link>
          {onToggle && (
            <button
              type="button"
              onClick={onToggle}
              aria-pressed={pinned}
              aria-label={toggleLabel}
              title={toggleLabel}
              tabIndex={collapsed ? -1 : undefined}
              className={cn(
                'grid h-[30px] w-[30px] flex-none place-items-center rounded-md border border-sidebar-border transition-colors hover:bg-sidebar-accent hover:text-sidebar-primary',
                pinned ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
                fadeLabel
              )}
            >
              {pinned ? (
                <PinOff className="h-[15px] w-[15px]" />
              ) : (
                <Pin className="h-[15px] w-[15px]" />
              )}
            </button>
          )}
        </div>

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
                  <p
                    className={cn(
                      'px-3 mb-1 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider truncate',
                      fadeLabel
                    )}
                  >
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

        {/* Footer: liên kết phụ + chuông + tài khoản */}
        <div className="flex-none border-t border-sidebar-border py-2">
          <div className={cn('flex items-center gap-3 px-4 pb-1', fadeLabel)}>
            <Link
              to="/faq"
              tabIndex={collapsed ? -1 : undefined}
              className="flex items-center gap-1 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <HelpCircle className="h-3 w-3" />
              FAQ
            </Link>
            <Link
              to="/changelog"
              tabIndex={collapsed ? -1 : undefined}
              className="flex items-center gap-1 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <History className="h-3 w-3" />
              Lịch sử
            </Link>
            <Link
              to="/app-guide"
              tabIndex={collapsed ? -1 : undefined}
              className="flex items-center gap-1 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground"
            >
              <Smartphone className="h-3 w-3" />
              Hướng dẫn App
            </Link>
          </div>

          {/*
            Chuông nằm ở x=36 (trùng trục icon điều hướng) nên huy hiệu chưa đọc
            VẪN THẤY ĐƯỢC khi sidebar đang ở rail.
          */}
          {notificationSlot && <div className="px-4 pt-1.5">{notificationSlot}</div>}

          <div className="flex items-center gap-1 px-3">
            <Link
              to="/account/profile"
              tabIndex={collapsed ? -1 : undefined}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
              title={profile?.email || user?.email || 'Tài khoản của bạn'}
            >
              <Avatar className="h-8 w-8 flex-none ring-2 ring-primary/20">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback className="bg-primary text-xs font-semibold text-white">
                  {getUserInitials()}
                </AvatarFallback>
              </Avatar>
              <span className={cn('flex min-w-0 flex-col leading-tight', fadeLabel)}>
                <span className="truncate text-[13px] font-semibold">
                  {profile?.full_name || 'User'}
                </span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {profile?.email || user?.email}
                </span>
              </span>
            </Link>
            <button
              type="button"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              tabIndex={collapsed ? -1 : undefined}
              aria-label="Đăng xuất"
              title="Đăng xuất"
              className={cn(
                'grid h-8 w-8 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50',
                fadeLabel
              )}
            >
              <LogOut className="h-[17px] w-[17px]" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
