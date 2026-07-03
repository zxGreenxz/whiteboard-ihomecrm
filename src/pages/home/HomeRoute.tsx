import { Suspense, lazy, useEffect, useState } from 'react';

// Cả 2 nhánh đều lazy: Dashboard từng import TĨNH ở đây khiến /login (và mọi
// entry chưa đăng nhập) tải luôn shell Dashboard + MainLayout + data hooks —
// trang eager duy nhất còn sót sau đợt code-split App.tsx.
const Dashboard = lazy(() => import('@/pages/Dashboard'));
// Launcher: scoped CSS + font riêng → lazy để chỉ nạp khi thực sự mở trên mobile.
const HomeLauncher = lazy(() => import('./HomeLauncher'));

const MOBILE_QUERY = '(max-width: 767px)';

/**
 * Trang "/" tách nhánh theo bề ngang màn hình:
 *  - Mobile  → Home launcher (web-app dạng app, shell + CSS độc lập).
 *  - Desktop → Dashboard (Bảng tin) như cũ, KHÔNG đổi.
 *
 * State khởi tạo ĐỒNG BỘ từ matchMedia (không qua useIsMobile vốn coerce
 * undefined→false ở render đầu) để tránh nháy Dashboard 1 frame trên điện thoại
 * và không mount các query nặng của Dashboard khi đang ở mobile.
 */
const HomeRoute = () => {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);

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
