// =============================================================
// Cầu nối service worker ↔ app. (21/10/2026, plan realtime + thông báo, C4/C5/C7.)
//
// Phía phát: public/sw.js (hợp đồng ở đầu file đó). Phía nhận ở đây:
//   push-received             ⇒ làm tươi hộp thư ngay (không chờ realtime).
//   notification-click        ⇒ xác nhận cho SW (để SW thôi tải lại trang), đánh dấu
//                               đã đọc các id, đổi công ty nếu push thuộc công ty khác
//                               mà người dùng là thành viên, rồi điều hướng SPA qua
//                               resolveNotificationUrl (allow-list + kiểm quyền).
//   ?notif=<ids>&org=<id>     ⇒ cùng việc trên khi SW phải mở TAB MỚI; đọc một lần
//                               lúc khởi động rồi gỡ khỏi URL (trang đích đã đúng).
//   push-subscription-changed ⇒ đối chiếu lại đăng ký push với máy chủ.
// Kèm theo, cấp app:
//   - số chưa đọc ⇒ số trên icon PWA; về 0 ⇒ đóng mọi thông báo hộp thư trên màn khoá;
//   - có phiên + đã chốt công ty ⇒ ensurePushSubscription() một lần mỗi tài khoản.
//
// VÌ SAO MOUNT TRONG CÂY ROUTE (src/app/routes/index.tsx) CHỨ KHÔNG Ở AppProviders
//   Cần cả `selectOrganization` (OrganizationProvider, nằm trong AppProviders) lẫn
//   `navigate` (BrowserRouter, nằm NGOÀI AppProviders — xem App.tsx). Chỗ duy nhất
//   có đủ hai là bên trong BrowserRouter, cạnh RouteTreeCommit.
// =============================================================

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { useUnreadNotificationsCount } from "@/hooks/useNotifications";
import { useMarkNotificationsRead } from "@/hooks/useMarkNotificationsRead";
import { resolveNotificationUrl } from "@/lib/notificationRoutes";
import { capNhatSoTrenIcon, dongMoiThongBaoHopThu } from "@/lib/push/osNotifications";
import { docThamSoMoApp, docTinServiceWorker } from "@/lib/push/swMessages";

/** Chờ đổi công ty tối đa chừng này; quá hạn thì vẫn điều hướng (RLS vẫn là hàng rào). */
export const CHO_DOI_CONG_TY_MS = 8_000;

interface ViecBamPush {
  /** null ⇒ đã ở đúng trang (mở từ tab mới), chỉ cần đánh dấu đọc / đổi công ty. */
  url: string | null;
  notificationIds: string[];
  organizationId: string | null;
}

async function doiChieuDangKyPush(organizationId: string | null): Promise<void> {
  try {
    const push = await import("@/lib/push");
    await push.ensurePushSubscription(organizationId);
  } catch (error) {
    console.warn("[push] chưa đối chiếu được đăng ký push của máy này", error);
  }
}

export function ServiceWorkerBridge(): null {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const { selectedOrganizationId, organizations, selectOrganization, isLoading: dangTaiCongTy } = useOrganization();
  const { data: perms, isLoading: dangTaiQuyen } = useMyPermissions();
  const { data: soChuaDoc } = useUnreadNotificationsCount();
  const danhDau = useMarkNotificationsRead();
  const danhDauRef = useRef(danhDau.mutate);
  danhDauRef.current = danhDau.mutate;

  const [viec, setViec] = useState<ViecBamPush | null>(null);
  const daDanhDau = useRef<ViecBamPush | null>(null);
  const yeuCauDoiCongTy = useRef<{ viec: ViecBamPush; luc: number } | null>(null);
  // Nhịp hẹn giờ: tăng khi hết hạn chờ đổi công ty để effect xử lý chạy lại.
  const [nhip, setNhip] = useState(0);
  const congTyRef = useRef(selectedOrganizationId);
  congTyRef.current = selectedOrganizationId;

  // ---- Tin từ service worker ----
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const tin = docTinServiceWorker(event.data);
      if (!tin) return;
      if (tin.type === "push-received") {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        return;
      }
      if (tin.type === "push-subscription-changed") {
        void doiChieuDangKyPush(congTyRef.current);
        return;
      }
      // Báo SW "đã nhận" TRƯỚC mọi việc khác: SW chờ tối đa 1,5 s rồi tự tải lại trang.
      event.ports[0]?.postMessage({ type: "notification-click-ack" });
      setViec({ url: tin.url, notificationIds: tin.notificationIds, organizationId: tin.organizationId });
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [queryClient]);

  // ---- Mở app từ push khi không có tab nào: ?notif=&org= ----
  // Đọc MỖI KHI URL mang tham số, không chỉ lần đầu: chưa đăng nhập thì ProtectedRoute
  // gói cả query vào /login?next=… và tham số chỉ quay lại URL sau khi đăng nhập xong.
  useEffect(() => {
    if (location.pathname === "/login") return;
    const thamSo = docThamSoMoApp(location.search);
    if (!thamSo) return;
    // Gỡ tham số NGAY (replace): F5 hay chia sẻ link không lặp lại việc đánh dấu.
    navigate({ pathname: location.pathname, search: thamSo.conLai, hash: location.hash }, { replace: true });
    setViec({ url: null, notificationIds: thamSo.notificationIds, organizationId: thamSo.organizationId });
  }, [location.hash, location.pathname, location.search, navigate]);

  // ---- Xử lý một lần bấm push ----
  useEffect(() => {
    if (!viec || !userId) return;
    if (daDanhDau.current !== viec) {
      daDanhDau.current = viec;
      if (viec.notificationIds.length > 0) danhDauRef.current(viec.notificationIds);
    }
    if (dangTaiCongTy) return;
    const congTyDich = viec.organizationId;
    // Không thuộc công ty của push (đã bị gỡ khỏi công ty đó) ⇒ không đổi; RLS lo phần dữ liệu.
    if (congTyDich !== null && congTyDich !== selectedOrganizationId && organizations.some((o) => o.id === congTyDich)) {
      const daYeuCau = yeuCauDoiCongTy.current;
      if (daYeuCau?.viec !== viec) {
        yeuCauDoiCongTy.current = { viec, luc: Date.now() };
        selectOrganization(congTyDich);
        const timer = setTimeout(() => setNhip((n) => n + 1), CHO_DOI_CONG_TY_MS);
        return () => clearTimeout(timer);
      }
      if (Date.now() - daYeuCau.luc < CHO_DOI_CONG_TY_MS) {
        const timer = setTimeout(() => setNhip((n) => n + 1), CHO_DOI_CONG_TY_MS - (Date.now() - daYeuCau.luc));
        return () => clearTimeout(timer);
      }
      console.warn("[push] chưa đổi được sang công ty của thông báo — mở trang ở công ty đang chọn");
    }
    if (viec.url === null) {
      setViec(null);
      return;
    }
    // Quyền phải là quyền của công ty ĐÍCH: đợi useMyPermissions nạp xong sau khi đổi.
    if (dangTaiQuyen) return;
    const dich = resolveNotificationUrl(viec.url, perms);
    setViec(null);
    if (dich) navigate(dich);
  }, [viec, userId, dangTaiCongTy, selectedOrganizationId, organizations, selectOrganization, dangTaiQuyen, perms, navigate, nhip]);

  // ---- Số trên icon + dọn màn khoá khi đã đọc hết ----
  useEffect(() => {
    if (!userId || typeof soChuaDoc !== "number") return;
    capNhatSoTrenIcon(soChuaDoc);
    if (soChuaDoc === 0) void dongMoiThongBaoHopThu();
  }, [userId, soChuaDoc]);
  useEffect(() => {
    // Đăng xuất: icon không được giữ số của tài khoản vừa thoát.
    if (!userId) capNhatSoTrenIcon(0);
  }, [userId]);

  // ---- Đối chiếu đăng ký push một lần mỗi tài khoản, khi đã chốt công ty ----
  const daDoiChieu = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !selectedOrganizationId || daDoiChieu.current === userId) return;
    daDoiChieu.current = userId;
    void doiChieuDangKyPush(selectedOrganizationId);
  }, [userId, selectedOrganizationId]);

  return null;
}

export default ServiceWorkerBridge;
