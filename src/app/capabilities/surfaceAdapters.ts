import type { ActionKey } from "@/lib/permissions";
import { capabilityById } from "./registry";

/**
 * Cầu nối registry → bề mặt thật (sidebar, launcher).
 *
 * LÁT NÀY LÀM GÌ
 *   Đợt 4 lát 1–2 dựng registry làm nguồn ĐỐI CHIẾU: contract test đọc nó rồi so
 *   với bốn nơi khai tay. Lát 3 (đây) đổi chiều phụ thuộc — consumer SINH RA từ
 *   registry thay vì khai lại rồi chờ test bắt lỗi.
 *
 *   Khác biệt không nhỏ. Đối chiếu chỉ phát hiện lệch SAU KHI lệch đã tồn tại
 *   trong mã nguồn và chỉ khi test được chạy; sinh ra từ nguồn thì lệch không
 *   dựng lên được. Án lệ ngay trong repo: `contract_terminations` và
 *   `contract_transfers` vắng mặt ở cả hai nơi cần khai, không test nào bắt.
 *
 * VÌ SAO CHỈ TRẢ TRƯỜNG DỮ LIỆU, KHÔNG TRẢ CẢ MỤC
 *   Icon và màu accent là component React và hằng trình bày — plan §7 chốt không
 *   nhét chúng vào registry (registry phải serialize được để gate/CI đọc). Nên
 *   hàm ở đây trả đúng phần registry SỞ HỮU (nhãn, route, quyền, cờ), còn phần
 *   trình bày do chính consumer ghép vào.
 *
 * VÌ SAO KHÔNG import kiểu NavItem / LauncherTile
 *   Sidebar.tsx và launcherTiles.ts đều import module này; nhập ngược lại kiểu
 *   của chúng sẽ thành vòng. Kiểu ở đây khai theo CẤU TRÚC, và `satisfies` ở
 *   phía consumer là chỗ trình biên dịch kiểm hai bên còn khớp nhau.
 */
export interface CapabilitySurfaceFields {
  title: string;
  href: string;
  module: string;
  action: ActionKey;
}

/** Thêm `id` — launcher dùng nó làm khoá React và test đối chiếu theo id. */
export interface CapabilityTileFields extends CapabilitySurfaceFields {
  id: string;
}

function truong(id: string): CapabilitySurfaceFields | null {
  const c = capabilityById(id);
  // Không ném lỗi khi id lạ: file này chạy lúc module khởi tạo, ném ở đó sẽ làm
  // trắng màn hình vì một dòng cấu hình sai. Trả rỗng = mục biến mất, và gate
  // scripts/check-capability-surfaces.mjs mới là chỗ bắt id lạ ở CI.
  if (!c || !c.release.enabled) return null;
  return {
    title: c.label,
    href: c.primaryRoute,
    module: c.permission.module,
    action: c.permission.action,
  };
}

/**
 * Mục sidebar cho một capability — mảng rỗng khi cờ TẮT hoặc khi capability
 * không hiện ở nav desktop.
 *
 * Trả mảng (thay vì `T | null`) để consumer trải bằng `...` ngay trong literal,
 * giữ nguyên hình dạng cũ của navigationGroups thay vì phải lọc null về sau.
 */
export function navFieldsFor(id: string): CapabilitySurfaceFields[] {
  const t = truong(id);
  if (!t) return [];
  return capabilityById(id)!.surfaces.desktopNav ? [t] : [];
}

/** Tile launcher cho một capability — cùng ngữ nghĩa mảng rỗng như trên. */
export function launcherFieldsFor(id: string): CapabilityTileFields[] {
  const t = truong(id);
  if (!t) return [];
  return capabilityById(id)!.surfaces.mobileLauncher ? [{ ...t, id }] : [];
}
