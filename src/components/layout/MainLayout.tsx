import { useState } from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import Breadcrumbs from './Breadcrumbs';
import { Sheet, SheetContent } from '@/components/ui/sheet';

interface MainLayoutProps {
  children: React.ReactNode;
}

/**
 * MainLayout Component
 *
 * Main application layout with:
 * - Header (sticky at top)
 * - Sidebar (desktop: always visible, mobile: drawer)
 * - Content area with breadcrumbs
 * - Responsive design
 */
const MainLayout = ({ children }: MainLayoutProps) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const closeMobileMenu = () => setMobileMenuOpen(false);
  const toggleMobileMenu = () => setMobileMenuOpen((prev) => !prev);

  return (
    <div className="min-h-screen bg-gray-50">
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
          {/* Breadcrumbs */}
          <div className="border-b bg-white">
            <div className="px-4 py-3">
              <Breadcrumbs />
            </div>
          </div>

          {/* Page Content */}
          <div className="p-4 lg:p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
