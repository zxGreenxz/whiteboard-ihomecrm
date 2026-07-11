/* =============================================================
   Catalog các ô (tile) cho Home launcher (mobile web-app).
   4 phân mục đúng theo handoff Claude Design (ui_kits/mobile-app/data.js):
   Vận hành · Khách hàng & Hợp đồng · Tài chính · Hệ thống.

   `href` + (`module`,`action`) sao y navigationGroups của Sidebar.tsx để
   gating khớp 100% RequirePermission ở App.tsx (thiếu quyền → ẩn ô, ẩn luôn
   section rỗng). `icon` dùng đúng glyph Lucide Sidebar đang dùng. `accent` là
   màu nền ô icon (theo data.js của design).
   ============================================================= */
import {
  LayoutDashboard,
  Sun,
  Map,
  Building2,
  Home,
  DoorOpen,
  UserPlus,
  User,
  FileText,
  HandCoins,
  Receipt,
  Gauge,
  CreditCard,
  BarChart3,
  PieChart,
  Settings,
  UserCircle,
  ClipboardList,
  Car,
  Wallet,
  Coins,
} from 'lucide-react';
import type { ActionKey } from '@/lib/permissions';

/** Nguồn số badge — chỉ những count "rẻ" đã có sẵn ở Home (không over-fetch). */
export type BadgeSource = 'totalRooms';

export interface LauncherTile {
  id: string;
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Màu nền ô icon. */
  accent: string;
  /** Quyền cần để THẤY ô — khớp đúng (module, action) route guard kiểm. Bỏ trống = luôn hiện. */
  module?: string;
  action?: ActionKey;
  /** Ô "nổi bật" (Thu tiền) — nhãn tô màu brand. */
  hot?: boolean;
  /** Nguồn số badge (tuỳ chọn). */
  badge?: BadgeSource;
}

export interface LauncherSection {
  label: string;
  items: LauncherTile[];
}

export const LAUNCHER_SECTIONS: LauncherSection[] = [
  {
    label: 'Vận hành',
    items: [
      { id: 'my-day', title: 'Hôm nay', href: '/my-day', icon: Sun, accent: '#f59e0b', hot: true },
      { id: 'dashboard', title: 'Bảng tin', href: '/dashboard', icon: LayoutDashboard, accent: '#1f7a52' },
      { id: 'map', title: 'Sơ đồ toà nhà', href: '/building-map', icon: Map, accent: '#2563eb', module: 'buildings' },
      { id: 'buildings', title: 'Toà nhà', href: '/buildings', icon: Building2, accent: '#6366f1', module: 'buildings' },
      { id: 'rooms', title: 'Căn hộ', href: '/apartments', icon: Home, accent: '#0d9488', module: 'rooms', badge: 'totalRooms' },
      { id: 'leads', title: 'Khách hẹn', href: '/leads', icon: UserPlus, accent: '#d97706', module: 'leads' },
      { id: 'tasks', title: 'Công việc', href: '/tasks', icon: ClipboardList, accent: '#0ea5e9', module: 'tasks' },
      { id: 'sale-phong', title: 'Phòng trống', href: '/sale-phong', icon: DoorOpen, accent: '#16a34a', module: 'sale_phong', action: 'view' },
    ],
  },
  {
    label: 'Khách hàng & Hợp đồng',
    items: [
      { id: 'customers', title: 'Khách hàng', href: '/customers', icon: User, accent: '#7c3aed', module: 'customers' },
      { id: 'contracts', title: 'Hợp đồng', href: '/contracts', icon: FileText, accent: '#4f46e5', module: 'contracts' },
      { id: 'vehicles', title: 'Phương tiện', href: '/vehicles', icon: Car, accent: '#ea580c', module: 'vehicles' },
    ],
  },
  {
    label: 'Tài chính',
    items: [
      { id: 'thu-tien', title: 'Thu tiền', href: '/thu-tien', icon: HandCoins, accent: '#1f9d57', module: 'thu_tien', hot: true },
      { id: 'invoices', title: 'Hoá đơn', href: '/invoices', icon: Receipt, accent: '#d6453f', module: 'invoices' },
      { id: 'meters', title: 'Ghi chỉ số', href: '/meter-readings', icon: Gauge, accent: '#0891b2', module: 'meter_readings' },
      { id: 'cashbook', title: 'Thu chi', href: '/income-expense', icon: CreditCard, accent: '#7c3aed', module: 'income_expenses' },
      { id: 'funds', title: 'Sổ quỹ', href: '/finance/cashbooks', icon: Wallet, accent: '#ca8a04', module: 'cashbooks' },
      { id: 'salary', title: 'Bảng lương', href: '/finance/salary', icon: Coins, accent: '#eab308', module: 'salary' },
      { id: 'reports', title: 'Báo cáo', href: '/reports/real-estate', icon: BarChart3, accent: '#475569', module: 'reports_real_estate' },
      // Gating khớp Sidebar.tsx "Báo cáo Lợi Nhuận" (reports_finance.profit_distribution).
      { id: 'profit-report', title: 'BC Lợi Nhuận', href: '/reports/finance/profit-distribution', icon: PieChart, accent: '#4f46e5', module: 'reports_finance', action: 'profit_distribution' },
    ],
  },
  {
    label: 'Hệ thống',
    items: [
      { id: 'settings', title: 'Cài đặt', href: '/settings/general', icon: Settings, accent: '#6b7280', module: 'settings' },
      { id: 'account', title: 'Tài khoản', href: '/account/profile', icon: UserCircle, accent: '#6b7280' },
    ],
  },
];
