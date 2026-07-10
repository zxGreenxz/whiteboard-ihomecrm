import { Suspense, lazy } from 'react';
import { usePhoneViewport } from '@/hooks/use-mobile';

// Cả 2 nhánh đều lazy: Dashboard từng import TĨNH ở đây khiến /login (và mọi
// entry chưa đăng nhập) tải luôn shell Dashboard + MainLayout + data hooks —
// trang eager duy nhất còn sót sau đợt code-split App.tsx.
const Dashboard = lazy(() => import('@/pages/Dashboard'));
// Launcher: scoped CSS + font riêng → lazy để chỉ nạp khi thực sự mở trên mobile.
const HomeLauncher = lazy(() => import('./HomeLauncher'));

/**
 * Trang "/" tách nhánh theo bề ngang màn hình:
 *  - Mobile  → Home launcher (web-app dạng app, shell + CSS độc lập).
 *  - Desktop → Dashboard (Bảng tin) như cũ, KHÔNG đổi.
 *
 * Dùng usePhoneViewport (init ĐỒNG BỘ từ matchMedia ≤767px, không như useIsMobile
 * coerce undefined→false) để tránh nháy Dashboard 1 frame trên điện thoại và
 * không mount các query nặng của Dashboard khi đang ở mobile.
 */
const HomeRoute = () => {
  const isMobile = usePhoneViewport();

  if (isMobile) {
    return (
      <Suspense fallback={null}>
        <HomeLauncher />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
};

export default HomeRoute;
