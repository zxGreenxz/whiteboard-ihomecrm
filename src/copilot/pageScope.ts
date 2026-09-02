// MỘT NGUỒN PHẠM VI cho Copilot: điều hướng, allowlist UI-control và chỉ dẫn
// theo trang đều SINH TỪ `COPILOT_PAGE_CONTRACTS`.
//
// VÌ SAO GỘP BA THỨ NÀY VÀO MỘT MODULE
//   Trước 02/09/2026 chúng là BA danh sách viết tay ở ba file khác nhau —
//   `MO_TRANG_ROUTES` (tools/registry.ts), `PILOT_ROUTE_ALLOWLIST`
//   (safetyGuard.ts) và chuỗi `if (pathname.startsWith(...))` trong
//   pageContext.ts. Cả ba tình cờ dừng ở đúng ba trang giống nhau, nên nhìn qua
//   thì "khớp"; nhưng không có gì BẮT chúng khớp. Đo 13/08/2026 đã bắt được ca
//   lệch thật: whitelist điều hướng có 5 trang còn allowlist có 3, nên
//   `mo_trang` đưa agent tới `/contracts` rồi guard ném lỗi ngay bước sau —
//   người dùng thấy "✅ Đã mở trang" đi kèm một task đứt gánh.
//
//   Chữa bằng gate là chữa triệu chứng: gate chỉ nói "ba bản chép đang lệch".
//   Bỏ hẳn hai bản chép thì không còn gì để lệch, và gate chuyển sang canh thứ
//   CÒN lệch được — có ai thêm route bằng tay ngoài contract không.
//
// BA THỨ NÀY KHÔNG CÙNG PHẠM VI, VÀ ĐÓ LÀ CHỦ Ý
//   - Điều hướng (`ROUTE_DIEU_HUONG`): mở cho MỌI contract có route tĩnh.
//     `mo_trang` chỉ gọi `navigate()` — không đọc, không ghi, không bấm gì.
//   - UI-control (`PILOT_UI_CONTROL_ROUTES`): CHỈ trang nào contract khai
//     `safeControlIds` — tức trang đã có control được duyệt từng cái một.
//     Hôm nay đúng 3 trang. Không nới bằng cách sửa file này: nới bằng cách
//     khai `safeControlIds` trong contract, nơi mỗi control phải có `data-ai-safe`.
//   - Chỉ dẫn (`chiDanTrang`): văn bản gửi cho page-agent trước MỖI step.
import {
  COPILOT_PAGE_CONTRACTS,
  copilotPageByRoute,
} from '@/app/capabilities/registry';
import type { CopilotPageContract } from '@/app/capabilities/types';
import { VISIBLE_PAGE_GROUPS } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';

export interface MucDieuHuong {
  /** Khoá contract (`rooms.list`) — cũng là giá trị enum của tool `mo_trang`. */
  key: string;
  /** Route CANONICAL, luôn tĩnh (không `:param`). */
  route: string;
  /** Nhãn tiếng Việt hiển thị cho người dùng và liệt kê trong description tool. */
  label: string;
  module: string;
  action: ActionKey;
}

/** Route mà contract thực sự trỏ tới khi điều hướng. */
function routeCanonical(page: CopilotPageContract): string {
  return page.canonicalRoute ?? page.route;
}

/**
 * Nhãn tiếng Việt theo route, lấy từ catalog quyền.
 *
 * `VISIBLE_PAGE_GROUPS` chứ không phải bản thô: bản thô còn trang của sản phẩm
 * CHƯA SHIP. Cùng lý do đã ghi ở `banDoHeThong.ts` — Copilot là một bề mặt
 * hiển thị, và chỉ người dùng tới một trang không render là đúng cái hỏng mà
 * cờ đó tồn tại để tránh.
 */
const NHAN_THEO_ROUTE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const nhom of VISIBLE_PAGE_GROUPS) {
    for (const trang of nhom.pages) {
      if (!map.has(trang.route)) map.set(trang.route, trang.label);
    }
  }
  return map;
})();

/**
 * Dựng danh sách đích điều hướng. Tách thành hàm THUẦN để test được LUẬT bằng
 * fixture: một test nạp registry thật chỉ khẳng định lại dữ liệu của hôm nay.
 *
 * FAIL CLOSED — contract có route canonical KHÔNG nằm trong bản đồ nhãn
 * (`VISIBLE_PAGE_GROUPS`) thì BỊ LOẠI, chứ không "lấy tạm khoá làm nhãn". Bản
 * đầu rơi về `?? page.key` và đó là một cửa mở: `VISIBLE_PAGE_GROUPS` chính là
 * bản ĐÃ LỌC trang của sản phẩm CHƯA SHIP, nên vắng mặt ở đó nghĩa là trang
 * chưa render được. Lọc nhãn mà không lọc thành viên chỉ làm câu chữ đẹp lên
 * trong khi `mo_trang` vẫn đưa người dùng tới đúng chỗ không hiện gì.
 *
 * Bỏ route có `:param`: `mo_trang` không biết id nào để điền, và điều hướng tới
 * `/contracts/:id` nguyên văn sẽ ra màn 404 kèm câu "✅ Đã mở trang".
 *
 * Hai lượt để kết quả KHÔNG phụ thuộc thứ tự khai trong contract: lượt đầu lấy
 * trang trỏ thẳng route đó (trang danh sách), lượt sau mới lấp bằng trang chi
 * tiết trỏ về cùng canonical. Một lượt "gặp trước lấy trước" thì đảo hai dòng
 * trong registry là đổi cả khoá enum lẫn cặp quyền của tool.
 */
export function taoRouteDieuHuong(
  hopDong: readonly CopilotPageContract[],
  nhanTheoRoute: ReadonlyMap<string, string>,
): MucDieuHuong[] {
  const theoRoute = new Map<string, MucDieuHuong>();
  const them = (page: CopilotPageContract, route: string): void => {
    const label = nhanTheoRoute.get(route);
    if (label === undefined) return; // fail closed — xem doc comment
    theoRoute.set(route, {
      key: page.key,
      route,
      label,
      module: page.permission.module,
      action: page.permission.action,
    });
  };
  const dungDuoc = hopDong.filter((page) => !routeCanonical(page).includes(':'));
  for (const page of dungDuoc) {
    const route = routeCanonical(page);
    if (route === page.route && !theoRoute.has(route)) them(page, route);
  }
  for (const page of dungDuoc) {
    const route = routeCanonical(page);
    if (!theoRoute.has(route)) them(page, route);
  }
  return [...theoRoute.values()];
}

/** Đích điều hướng của `mo_trang` — sinh từ contract, gộp theo route canonical. */
export const ROUTE_DIEU_HUONG: readonly MucDieuHuong[] = taoRouteDieuHuong(
  COPILOT_PAGE_CONTRACTS,
  NHAN_THEO_ROUTE,
);

/** Contract có control đã duyệt ⇒ trang đó mới cho page-agent thao tác. */
const HOP_DONG_CO_CONTROL: readonly CopilotPageContract[] = COPILOT_PAGE_CONTRACTS.filter(
  (page) => page.safeControlIds.length > 0,
);

/**
 * Allowlist UI-control: nơi page-agent được phép ĐỨNG trong lúc chạy task.
 *
 * Đây là chốt chặn của `makeRouteGuard`/`makeUiControlStepGuard` — SPA rời khỏi
 * danh sách này giữa task thì guard ném lỗi và task dừng thật.
 */
export const PILOT_UI_CONTROL_ROUTES: readonly string[] = HOP_DONG_CO_CONTROL.map(routeCanonical);

// KHOA_TRANG_UI_CONTROL đã bị gỡ 03/09/2026: người dùng duy nhất của nó là
// `rolloutKeys` của `mo_trang`, mà điều hướng nay có khoá riêng
// (`KHOA_ROLLOUT_DIEU_HUONG`). Khoá rollout của TỪNG trang UI-control vẫn được
// đọc đúng chỗ nó có nghĩa — `uiControlGuard` tra theo `page.key` của contract
// ứng với pathname hiện tại. Giữ lại một hằng số không ai gác bằng sẽ đọc như
// một hàng rào, trong khi nó chỉ là một mảng.

/** Câu trả lời khi page-agent đứng ở trang không thuộc pilot. */
export const CHI_DAN_NGOAI_PHAM_VI = 'Trang này ngoài phạm vi thao tác. Hãy dừng và báo người dùng.';

/**
 * Chỉ dẫn theo TRANG, khoá bằng `pageKey` của contract.
 *
 * Khoá theo pageKey chứ không theo tiền tố đường dẫn: một chuỗi `startsWith`
 * viết tay sẽ lặng lẽ trật khi route đổi, còn pageKey thì gate contract đã canh.
 */
const CHI_DAN_THEO_TRANG: Readonly<Record<string, string>> = {
  'rooms.list':
    'Đang ở trang Căn hộ/Phòng. Bạn có thể lọc theo trạng thái/toà nhà bằng các ô lọc trên trang, hoặc điều hướng. KHÔNG chỉnh sửa/xoá dữ liệu.',
  'invoices.list':
    'Đang ở trang Hoá đơn. Bạn có thể lọc (kỳ, trạng thái thanh toán, toà) và mở chi tiết. TUYỆT ĐỐI KHÔNG duyệt/huỷ/xoá hoá đơn hay bấm nút thanh toán.',
  'customers.list':
    'Đang ở trang Cư dân. Bạn có thể tìm kiếm và lọc. KHÔNG sửa/xoá hồ sơ khách hàng.',
};

/**
 * Khoá điều hướng ứng với một pathname, hoặc `null` nếu ngoài phạm vi contract.
 *
 * Đi qua `copilotPageByRoute` để `/apartments/abc-123` vẫn ra trang Căn hộ —
 * contract chi tiết trỏ về cùng `canonicalRoute` với trang danh sách.
 */
export function khoaDieuHuongCuaDuong(pathname: string): string | null {
  const page = copilotPageByRoute(pathname);
  if (!page) return null;
  const route = routeCanonical(page);
  return ROUTE_DIEU_HUONG.find((muc) => muc.route === route)?.key ?? null;
}

/** Chỉ dẫn page-agent cho pathname hiện tại (gọi TRƯỚC MỖI STEP). */
export function chiDanTrang(pathname: string): string {
  const key = khoaDieuHuongCuaDuong(pathname);
  const chiDan = key === null ? undefined : CHI_DAN_THEO_TRANG[key];
  return chiDan ?? CHI_DAN_NGOAI_PHAM_VI;
}
