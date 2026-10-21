import { Fingerprint } from "lucide-react";

import { DoorAccessScreen } from "@/components/door-access/DoorAccessScreen";
import MainLayout from "@/components/layout/MainLayout";

/** Toàn bộ màn /cua-van-tay (nạp ở tầng lazy thứ hai — xem DoorAccessPage.tsx). */
export default function DoorAccessView() {
  return (
    <MainLayout title="Cửa vân tay" icon={Fingerprint}>
      <DoorAccessScreen />
    </MainLayout>
  );
}
