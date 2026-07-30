// =============================================================================
// Trang "Thanh toán" (/thanh-toan) — Đóng tiền Tập trung theo Kỳ.
//
// Trước đây UI này chỉ sống dạng OVERLAY trong /thu-tien (state `utility`):
// desktop thay chỗ ManagePanel, mobile là sheet trượt lên đè khung điện thoại.
// Tách ra page riêng vì nghiệp vụ khác hẳn Thu tiền: Thu tiền = THU của khách
// theo từng phòng; Thanh toán = CHI cho nhà cung cấp theo từng hạng mục/tòa.
//
// Layout dùng lại nguyên bộ style của thu-tien.css (scope .tt-stage):
//   ≥1024px  → grid 2 cột: PeriodFeePanel (.tt-udesk) | khung điện thoại
//   <1024px  → .tt-udesk display:none, chỉ còn khung điện thoại + PeriodFeeSheet
//
// ⚠ HAI BỀ MẶT CÙNG MOUNT LÀ CHỦ Ý — ĐỪNG "sửa" bằng cách unmount theo breakpoint.
// `.e2e-fleet/specs/thanh-toan-page.spec.ts:27/:32` assert cả panel desktop lẫn
// sheet cùng render ở 1280px, và `:143` dùng `toBeHidden()` (chứ không phải
// `toHaveCount(0)`) ở 390px — tức panel chỉ bị CSS ẩn, vẫn nằm trong DOM. Spec
// `utility-paste-receipt.spec.ts` còn dán ảnh lần lượt vào bảng desktop rồi vào
// thẻ trong khung điện thoại trong CÙNG một lần tải trang.
// Rủi ro thật của thiết kế này là hai bề mặt ghi hai phiếu cho cùng một ô. Chỗ
// chữa KHÔNG nằm ở đây mà ở `usePeriodFeeState` (kho state dùng chung khoá theo
// hạng mục × kỳ + chốt in-flight) và `useUtilityPayState` (chốt in-flight cấp
// module cho Điện & Nước), cộng với khoá slot phía server.
//
// ⚠ ĐÍNH CHÍNH (đo lại prod 30/07): cặp PC2606046/PC2606047 — 'tiền nhà' 102LVT,
// 66.000.000đ ×2, created_at cách nhau 460ms — mang `system_source = NULL`, tức
// KHÔNG do `pay_period_fee` và KHÔNG do lưới phí cố định của trang này sinh ra.
// Toàn bộ 23 slot phí cố định trùng trên prod: 20 slot system_source NULL (đường
// tạo phiếu chung bên Thu chi) + 3 slot 'utility.bill'; 0 slot 'fixed_fee'. Nó
// vẫn là minh hoạ đúng cho LỚP lỗi (hai đường ghi cùng một slot, không ai khoá),
// nhưng đừng dùng nó để kết luận trang này đã bịt xong lỗ đó.
// =============================================================================

import { useLocation, useNavigate } from 'react-router-dom';
import './thu-tien.css';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PeriodFeePanel } from '@/components/thu-tien/PeriodFeePanel';
import { PeriodFeeSheet } from '@/components/thu-tien/PeriodFeeSheet';

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const ThanhToan = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: perms } = useMyPermissions();
  // Cùng quyền với nút Plug cũ bên /thu-tien (thu_tien.collect) — route guard ở
  // App.tsx đã chặn trước, cờ này chỉ để disable nút khi quyền bị rút giữa chừng.
  const canRecordPayment = canUse(perms, 'thu_tien', 'collect');
  // canUse xét TỪNG feature độc lập: `collect` KHÔNG kéo theo `view`. Role chỉ
  // có collect mà quay về /thu-tien sẽ bị RequirePermission đá về "/" — nên
  // phải hỏi quyền trước khi chọn điểm rơi.
  const canViewThuTien = canUse(perms, 'thu_tien', 'view');

  // Dùng CHUNG key kỳ với /thu-tien: đi qua lại 2 trang giữ nguyên tháng đang xem.
  const [billingMonth, setBillingMonth] = usePersistedState('flt:thu-tien:month', currentMonth);

  // Nút back/X. Vào từ trong app (nút Plug bên Thu tiền, ô Thanh toán ở Home)
  // thì lui đúng 1 bước cho tự nhiên. Vào THẲNG bằng deep-link/F5 thì history
  // rỗng — react-router đánh dấu entry đầu bằng key 'default' — nên rơi về
  // /thu-tien, hoặc "/" nếu không có quyền vào Thu tiền.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(canViewThuTien ? '/thu-tien' : '/');
  };

  return (
    <div className="tt-stage">
      <PeriodFeePanel
        billingMonth={billingMonth}
        onBillingMonthChange={setBillingMonth}
        onClose={goBack}
        canRecordPayment={canRecordPayment}
      />
      <div className="tt-phone-col">
        <div className="tt-page">
          {/* show cố định: đây là NỘI DUNG của page chứ không phải sheet bật/tắt.
              .sheet.full phủ kín .tt-page nên không cần header riêng phía sau. */}
          <PeriodFeeSheet
            show
            standalone
            onClose={goBack}
            billingMonth={billingMonth}
            onBillingMonthChange={setBillingMonth}
            canRecordPayment={canRecordPayment}
          />
        </div>
      </div>
    </div>
  );
};

export default ThanhToan;
