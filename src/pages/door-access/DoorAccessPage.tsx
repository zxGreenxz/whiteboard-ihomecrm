import { lazyWithRetry } from "@/lib/lazyWithRetry";

/**
 * /cua-van-tay — máy vân tay ở cửa các tòa (SmartLife/Tuya). Tài liệu: docs/he-thong/26-cua-van-tay.md.
 *
 * HAI TẦNG LAZY, CÓ CHỦ Ý: chunk entry khai mọi trang lazy kèm danh sách file cần preload của
 * từng trang, và chunk entry đang sát ngưỡng ratchet (tooling/bundle-baseline.json). Trang này chỉ
 * import tĩnh `lazyWithRetry` (đã có sẵn trong entry) nên danh sách preload của nó trong entry gần
 * như rỗng; MainLayout + cả màn nằm ở chunk tầng hai, tải khi trang mở. Chờ chunk tầng hai thì
 * Suspense chung quanh <Routes> hiện khung chờ như mọi trang khác.
 */
const DoorAccessView = lazyWithRetry(() => import("./DoorAccessView"));

export default function DoorAccessPage() {
  return <DoorAccessView />;
}
