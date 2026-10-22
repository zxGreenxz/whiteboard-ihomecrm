import { useEffect, useState } from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import NotificationBell from './NotificationBell';
import RealtimeSyncBanner from '@/components/layout/RealtimeSyncBanner';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { SIDEBAR_EASING, useSidebarState } from './useSidebarState';
import { LucideIcon } from 'lucide-react';

/** Mốc lg của Tailwind: từ đây sidebar thay header mobile. */
const LG_QUERY = '(min-width: 1024px)';

/**
 * Bố cục desktop (≥ lg) hay mobile — khởi tạo ĐỒNG BỘ từ matchMedia để khung
 * đầu không dựng cả hai chuông rồi gỡ một. Không có matchMedia (test cũ) ⇒ coi
 * như desktop, đúng như trình duyệt rộng mặc định.
 */
function useLayoutDesktop(): boolean {
  const doc = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(LG_QUERY).matches;
  const [desktop, setDesktop] = useState(doc);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(LG_QUERY);
    const onChange = () => setDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

interface MainLayoutProps {
  /** Personal mobile surface supplies its own bottom navigation. */
  hideMobileHeader?: boolean;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  /**
   * Khi có: biến ô icon tiêu đề thành nút bấm được (dùng cho "easter egg" mở
   * tab ẩn — vd nhấp 3 lần vào icon để hiện các tab nhạy cảm). Không truyền thì
   * icon chỉ là trang trí như cũ.
   */
  onIconClick?: () => void;
  /**
   * Trang chiếm trọn chiều cao (vd Chat Zalo): bỏ thanh breadcrumbs + bỏ padding,
   * cố định vùng nội dung = chiều cao viewport (desktop) hoặc viewport trừ thanh
   * header mobile (h-16 = 4rem), và không cho cuộn trang — để bên trong tự quản
   * lý cuộn từng cột.
   */
  fullBleed?: boolean;
}

/**
 * MainLayout Component
 *
 * Bố cục chính của app:
 * - Desktop (≥ lg): KHÔNG có thanh header trên cùng. Logo, tài khoản và nút
 *   đăng xuất nằm trong sidebar; sidebar mặc định là rail 72px chỉ-icon, rê
 *   chuột vào là bung 264px NỔI ĐÈ lên nội dung (bảng không bị xô lệch), nút
 *   ghim / Ctrl+⌘B khoá trạng thái mở và khi đó sidebar đẩy nội dung.
 *   Xem `useSidebarState` cho ngưỡng tự-thu-theo-màn-hình và cách lưu trạng thái.
 * - Mobile (< lg): sidebar luôn là drawer (rail 72px quá hẹp cho ngón tay), mở
 *   bằng nút ☰ trên thanh header mobile.
 */
const MainLayout = ({ children, title, subtitle, icon: Icon, onIconClick, fullBleed = false, hideMobileHeader = false }: MainLayoutProps) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { data: user } = useAuth();
  const sidebar = useSidebarState(user?.id);
  // CHỈ MỘT chuông mỗi trang. Trước đây header mobile (ẩn bằng CSS trên desktop) và
  // sidebar desktop (ẩn bằng CSS trên mobile) đều dựng NotificationBell: gấp đôi
  // observer + DropdownMenu, và mỗi sự kiện realtime render hai lần.
  const desktop = useLayoutDesktop();

  const toggleMobileMenu = () => setMobileMenuOpen((prev) => !prev);

  return (
    <div className="min-h-screen bg-background">
      {/* Header — chỉ còn trên mobile (desktop đã dồn hết vào sidebar) */}
      <div className={hideMobileHeader ? 'hidden' : 'lg:hidden'}>
        <Header onMenuClick={toggleMobileMenu} showNotifications={!desktop} />
      </div>

      <div className="flex">
        {/*
          Ô giữ chỗ trong luồng bố cục: rộng đúng bằng phần sidebar CHIẾM CHỖ.
          Khi chỉ mở tạm bằng chuột, ô này vẫn là 72px nên bảng phía sau đứng yên
          tuyệt đối — panel nổi đè lên trên.
        */}
        <div
          className="hidden flex-none lg:block"
          style={{
            width: sidebar.flowWidth,
            transition: `width ${sidebar.durationMs}ms ${SIDEBAR_EASING}`,
          }}
        >
          <Sidebar
            className="fixed left-0 top-0 z-40 h-screen"
            collapsed={!sidebar.panelExpanded}
            floating={sidebar.floating}
            pinned={sidebar.pinned}
            durationMs={sidebar.durationMs}
            onToggle={sidebar.toggle}
            onPointerEnter={sidebar.onPointerEnter}
            onPointerLeave={sidebar.onPointerLeave}
            notificationSlot={desktop ? <NotificationBell /> : undefined}
          />
        </div>

        {/* Mobile Sidebar - Sheet/Drawer */}
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetContent side="left" className="w-[264px] p-0">
            {/* Radix Dialog đòi title cho screen reader — ẩn khỏi mắt thường. */}
            <SheetTitle className="sr-only">Điều hướng</SheetTitle>
            {/* Chuông đã có sẵn trên thanh header mobile — không lặp lại trong drawer. */}
            <Sidebar className="border-r-0" />
          </SheetContent>
        </Sheet>

        {/* Main Content Area */}
        <main
          className={
            fullBleed
              ? 'flex h-[calc(100vh-4rem)] min-w-0 flex-1 flex-col overflow-x-hidden lg:h-screen'
              : 'min-w-0 flex-1 overflow-x-hidden'
          }
        >
          {/* Dải cảnh báo khi cập nhật tự động gián đoạn (plan mục A6) — hàng trong luồng. */}
          <RealtimeSyncBanner />
          {fullBleed ? (
            /* Full-height: không breadcrumbs/padding. <main> cố định = viewport (desktop)
               hoặc viewport - header mobile; khối này lấy phần còn lại sau dải cảnh báo. */
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          ) : (
            /* Page Content (breadcrumbs removed) */
            <div className={hideMobileHeader ? '' : 'p-4 lg:p-6'}>
              {/* Page Header if title is provided */}
              {title && (
                <div className="flex items-center gap-3 mb-6">
                  {Icon && (
                    onIconClick ? (
                      <button
                        type="button"
                        onClick={onIconClick}
                        aria-label={title}
                        className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center select-none focus:outline-none"
                      >
                        <Icon className="h-6 w-6 text-primary" />
                      </button>
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Icon className="h-6 w-6 text-primary" />
                      </div>
                    )
                  )}
                  <div>
                    <h1 className="text-2xl font-bold text-foreground">{title}</h1>
                    {subtitle && (
                      <p className="text-sm text-muted-foreground">{subtitle}</p>
                    )}
                  </div>
                </div>
              )}
              {children}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
