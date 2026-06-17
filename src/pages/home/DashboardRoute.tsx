import { Suspense, lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { usePhoneViewport } from '@/hooks/use-mobile';

// Bảng tin mobile: scope CSS riêng → lazy để chỉ nạp trên điện thoại.
const DashboardMobilePage = lazy(() => import('@/pages/DashboardMobilePage'));

/**
 * "/dashboard" — Bảng tin.
 *  - Mobile  → màn Bảng tin web-app (KPI, lấp đầy, doanh thu, vận hành, cảnh
 *    báo, hoạt động) — mở từ ô "Bảng tin" trên Home launcher.
 *  - Desktop → "/" vốn đã là Dashboard (Bảng tin), nên điều hướng về "/".
 */
const DashboardRoute = () => {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <DashboardMobilePage />
      </Suspense>
    );
  }
  return <Navigate to="/" replace />;
};

export default DashboardRoute;
