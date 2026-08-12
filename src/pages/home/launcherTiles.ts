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
  Bot,
  Network,
  Banknote,
} from 'lucide-react';
import type { ActionKey } from '@/lib/permissions';
import { launcherFieldsFor } from '@/app/capabilities/surfaceAdapters';

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
      ...launcherFieldsFor('map').map((x) => ({ ...x, icon: Map, accent: '#2563eb' }) satisfies LauncherTile),
      ...launcherFieldsFor('buildings').map((x) => ({ ...x, icon: Building2, accent: '#6366f1' }) satisfies LauncherTile),
      ...launcherFieldsFor('rooms').map((x) => ({ ...x, icon: Home, accent: '#0d9488', badge: 'totalRooms' }) satisfies LauncherTile),
      ...launcherFieldsFor('leads').map((x) => ({ ...x, icon: UserPlus, accent: '#d97706' }) satisfies LauncherTile),
      ...launcherFieldsFor('tasks').map((x) => ({ ...x, icon: ClipboardList, accent: '#0ea5e9' }) satisfies LauncherTile),
      // Sinh từ capability registry (Đợt 4 lát 3) — chỉ `icon`/`accent` là của
      // riêng launcher, phần còn lại registry sở hữu.
      ...launcherFieldsFor('network-center').map((f) => ({ ...f, icon: Network, accent: '#111111' }) satisfies LauncherTile),
      ...launcherFieldsFor('sale-phong').map((x) => ({ ...x, icon: DoorOpen, accent: '#16a34a' }) satisfies LauncherTile),
      ...launcherFieldsFor('openclaw-zalo').map((f) => ({ ...f, icon: Bot, accent: '#0f766e' }) satisfies LauncherTile),
    ],
  },
  {
    label: 'Khách hàng & Hợp đồng',
    items: [
      ...launcherFieldsFor('customers').map((x) => ({ ...x, icon: User, accent: '#7c3aed' }) satisfies LauncherTile),
      ...launcherFieldsFor('contracts').map((x) => ({ ...x, icon: FileText, accent: '#4f46e5' }) satisfies LauncherTile),
      ...launcherFieldsFor('vehicles').map((x) => ({ ...x, icon: Car, accent: '#ea580c' }) satisfies LauncherTile),
    ],
  },
  {
    label: 'Tài chính',
    items: [
      ...launcherFieldsFor('thu-tien').map((x) => ({ ...x, icon: HandCoins, accent: '#1f9d57', hot: true }) satisfies LauncherTile),
      // Đóng tiền Tập trung theo Kỳ — gate `thu_tien.collect` khớp đúng route
      // guard /thanh-toan (người chỉ có quyền xem không thấy ô này).
      { id: 'thanh-toan', title: 'Thanh toán', href: '/thanh-toan', icon: Banknote, accent: '#ea580c', module: 'thu_tien', action: 'collect' },
      ...launcherFieldsFor('invoices').map((x) => ({ ...x, icon: Receipt, accent: '#d6453f' }) satisfies LauncherTile),
      ...launcherFieldsFor('meters').map((x) => ({ ...x, icon: Gauge, accent: '#0891b2' }) satisfies LauncherTile),
      ...launcherFieldsFor('cashbook').map((x) => ({ ...x, icon: CreditCard, accent: '#7c3aed' }) satisfies LauncherTile),
      ...launcherFieldsFor('funds').map((x) => ({ ...x, icon: Wallet, accent: '#ca8a04' }) satisfies LauncherTile),
      ...launcherFieldsFor('salary').map((x) => ({ ...x, icon: Coins, accent: '#eab308' }) satisfies LauncherTile),
      ...launcherFieldsFor('reports').map((x) => ({ ...x, icon: BarChart3, accent: '#475569' }) satisfies LauncherTile),
      // Gating khớp Sidebar.tsx "Báo cáo Lợi Nhuận" (reports_finance.profit_distribution).
      { id: 'profit-report', title: 'BC Lợi Nhuận', href: '/reports/finance/profit-distribution', icon: PieChart, accent: '#4f46e5', module: 'reports_finance', action: 'profit_distribution' },
    ],
  },
  {
    label: 'Hệ thống',
    items: [
      ...launcherFieldsFor('settings').map((x) => ({ ...x, icon: Settings, accent: '#6b7280' }) satisfies LauncherTile),
      { id: 'account', title: 'Tài khoản', href: '/account/profile', icon: UserCircle, accent: '#6b7280' },
    ],
  },
];
