import { Suspense } from "react";
import { Fingerprint } from "lucide-react";

import { DoorAccessScreen } from "@/components/door-access/DoorAccessScreen";
import MainLayout from "@/components/layout/MainLayout";
import { LoadingState } from "@/components/loading/LoadingState";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

/**
 * Màn điện thoại (< 768px, Bản A — thanh dưới 4 mục, giữ 1 giây để mở) nạp lười ở tầng thứ ba: máy
 * tính không tải mã/CSS của nó. Màn rộng giữ nguyên bố cục tab.
 */
const DoorAccessMobile = lazyWithRetry(() => import("@/components/door-access/mobile/DoorAccessMobile"));

/** Toàn bộ màn /cua-van-tay (nạp ở tầng lazy thứ hai — xem DoorAccessPage.tsx). */
export default function DoorAccessView() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={<LoadingState label="trang Cửa vân tay" variant="detail" rows={3} />}>
        <DoorAccessMobile />
      </Suspense>
    );
  }
  return (
    <MainLayout title="Cửa vân tay" icon={Fingerprint}>
      <DoorAccessScreen />
    </MainLayout>
  );
}
