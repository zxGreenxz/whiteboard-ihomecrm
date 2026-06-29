import { useState } from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { LucideIcon } from 'lucide-react';

interface MainLayoutProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  /**
   * Trang chiếm trọn chiều cao (vd Chat Zalo): bỏ thanh breadcrumbs + bỏ padding,
   * cố định vùng nội dung = chiều cao viewport trừ header (h-16 = 4rem) và không
   * cho cuộn trang — để bên trong tự quản lý cuộn từng cột.
   */
  fullBleed?: boolean;
}

/**
 * MainLayout Component
 *
 * Main application layout with:
 * - Header (sticky at top)
 * - Sidebar (desktop: always visible, mobile: drawer)
 * - Content area with breadcrumbs
 * - Responsive design
 * - Optional page title with icon
 * - fullBleed: bố cục full-height không padding/breadcrumbs (chat…)
 */
const MainLayout = ({ children, title, subtitle, icon: Icon, fullBleed = false }: MainLayoutProps) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const closeMobileMenu = () => setMobileMenuOpen(false);
  const toggleMobileMenu = () => setMobileMenuOpen((prev) => !prev);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <Header onMenuClick={toggleMobileMenu} />

      <div className="flex">
        {/* Desktop Sidebar - Always visible on large screens */}
        <div className="hidden lg:block">
          <Sidebar />
        </div>

        {/* Mobile Sidebar - Sheet/Drawer */}
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetContent side="left" className="p-0 w-64">
            <div className="pt-4">
              <Sidebar />
            </div>
          </SheetContent>
        </Sheet>

        {/* Main Content Area */}
        <main className="flex-1 overflow-x-hidden">
          {fullBleed ? (
            /* Full-height: không breadcrumbs/padding; cố định = viewport - header */
            <div className="h-[calc(100vh-4rem)] overflow-hidden">{children}</div>
          ) : (
            /* Page Content (breadcrumbs removed) */
            <div className="p-4 lg:p-6">
              {/* Page Header if title is provided */}
              {title && (
                <div className="flex items-center gap-3 mb-6">
                  {Icon && (
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>
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
