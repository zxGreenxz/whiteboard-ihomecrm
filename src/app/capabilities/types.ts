import type { ActionKey } from "@/lib/permissions";

/**
 * Một "capability" = một bề mặt sản phẩm ở mức TRANG: route chính, chỗ nó xuất
 * hiện trong nav/launcher, quyền gác nó, và cờ bật/tắt.
 *
 * Phạm vi cố ý hẹp. Registry này KHÔNG sở hữu feature/action catalog
 * (src/lib/permissionPages.ts, 742 dòng, nhiều component dùng cho authorization
 * ở mức thao tác) — gộp cả hai trong một đợt sẽ biến một lát nhỏ thành refactor
 * xuyên hệ thống. Ở đây chỉ tham chiếu tới trang tương ứng bằng `permissionPage`.
 */
export interface CapabilityDefinition {
  /** Khớp id tile ở launcher để đối chiếu được. */
  id: string;
  primaryRoute: string;
  label: string;

  /**
   * KHÔNG khai tên biến env ở đây.
   *
   * Cờ đã được resolve đúng một chỗ cho mỗi hệ (src/lib/<domain>/runtime.ts) và
   * consumer import boolean dẫn xuất. Thêm tên env vào registry sẽ tạo nguồn đọc
   * thứ hai cho cùng một quyết định — đúng thứ registry sinh ra để loại bỏ.
   */
  release: {
    /** `true` = luôn bật; ngược lại là giá trị dẫn xuất từ runtime module. */
    enabled: boolean;
    runtimeModule: "network-center" | "openclaw-zalo" | null;
  };

  permission: { module: string; action: ActionKey };

  surfaces: {
    desktopNav: boolean;
    mobileLauncher: boolean;
    /** Route của trang tương ứng trong permission picker. */
    permissionPage: string;
  };

  docs: { systemDoc: string };

  risk: "normal" | "financial" | "security" | "infrastructure";
}
