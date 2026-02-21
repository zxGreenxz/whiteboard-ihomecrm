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
  MapPin,
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
  BookOpen,
  Package,
  AlertCircle,
  BarChart3,
  Settings,
  FileSignature,
  UserCog,
  ChevronDown,
  Map,
  Bot,
  ClipboardCheck,
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

// Navigation configuration
const navigationSections: (NavItem | NavSection)[] = [
  {
    title: 'Tổng quan',
    href: '/',
    icon: LayoutDashboard,
  },
  {
    title: 'Sơ đồ Tòa nhà',
    href: '/building-map',
    icon: Map,
  },
  {
    title: 'Danh mục dữ liệu',
    icon: Building2,
    items: [
      { title: 'Khu vực', href: '/areas', icon: MapPin },
      { title: 'Tòa nhà', href: '/buildings', icon: Building2 },
      { title: 'Phòng', href: '/rooms', icon: Home },
      { title: 'Giường', href: '/beds', icon: Bed },
      { title: 'Dịch vụ', href: '/services', icon: Wrench },
    ],
  },
  {
    title: 'Khách hàng',
    icon: Users,
    items: [
      { title: 'Khách hẹn', href: '/leads', icon: UserPlus },
      { title: 'Đặt cọc', href: '/deposits', icon: DollarSign },
      { title: 'Hợp đồng', href: '/contracts', icon: FileText },
      { title: 'Duyệt thanh lý', href: '/contracts/termination-approvals', icon: ClipboardCheck },
      { title: 'Khách thuê', href: '/tenants', icon: User },
      { title: 'Phương tiện', href: '/vehicles', icon: Car },
    ],
  },
  {
    title: 'Tài chính',
    icon: CreditCard,
    items: [
      { title: 'Ghi chỉ số', href: '/meter-readings', icon: Gauge },
      { title: 'Hóa đơn', href: '/invoices', icon: Receipt },
      { title: 'Thu chi', href: '/payments', icon: CreditCard },
      { title: 'Sổ quỹ', href: '/cash-book', icon: BookOpen },
    ],
  },
  {
    title: 'Tài sản & Sự cố',
    icon: Package,
    items: [
      { title: 'Tài sản', href: '/assets', icon: Package },
      { title: 'Sự cố', href: '/issues', icon: AlertCircle },
    ],
  },
  {
    title: 'Báo cáo',
    icon: BarChart3,
    items: [
      { title: 'Báo cáo BĐS', href: '/reports/real-estate', icon: Building2 },
      { title: 'Báo cáo tài chính', href: '/reports/finance', icon: CreditCard },
      { title: 'Báo cáo công việc', href: '/reports/tasks', icon: AlertCircle },
    ],
  },
  {
    title: 'Cài đặt',
    icon: Settings,
    items: [
      { title: 'Cài đặt chung', href: '/settings/general', icon: Settings },
      { title: 'Mẫu biểu', href: '/settings/templates', icon: FileText },
      { title: 'Mẫu chữ ký', href: '/settings/signatures', icon: FileSignature },
      { title: 'Nhân viên', href: '/settings/staff', icon: UserCog },
      { title: 'Trợ lý AI', href: '/settings/ai-assistant', icon: Bot },
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
    navigationSections.forEach((section) => {
      if ('items' in section) {
        const hasActiveItem = section.items.some(
          (item) => location.pathname === item.href || location.pathname.startsWith(item.href + '/')
        );
        if (hasActiveItem) {
          active.push(section.title);
        }
      }
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
        <nav className="space-y-1">
          {navigationSections.map((section) =>
            'items' in section ? renderSection(section) : renderNavItem(section)
          )}
        </nav>
      </ScrollArea>

      {/* Footer info */}
      <div className="border-t border-sidebar-border p-3">
        <div className="text-xs text-sidebar-foreground/70">
          <p className="font-medium text-sidebar-foreground">iHomeCRM v1.0.0</p>
          <p>Quản lý bất động sản</p>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;