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

  /**
   * Đường tới spec E2E khói của capability, tính từ gốc repo.
   *
   * VÌ SAO KHAI Ở ĐÂY thay vì để người ta nhớ viết test
   *   Một capability có route, có nav, có quyền, có tài liệu — và không ai đi hết
   *   một lần qua giao diện. Khi đó mọi phép kiểm đều là kiểm TỪNG MẢNH: route tồn
   *   tại, guard đúng, permission có trong picker. Ba cái xanh vẫn có thể ra một
   *   trang trắng, vì không cái nào mở trình duyệt.
   *
   *   Khai ở registry thì `check-capability-surfaces` khẳng định được FILE CÓ THẬT.
   *   Nó không chứng minh test chạy xanh — chỉ chứng minh capability không lặng lẽ
   *   ra đời mà không có đường khói nào.
   *
   * `null` = CỐ Ý chưa có, và phải kèm `e2eMienTruVi` nói rõ vì sao. Không cho để
   * trống mà im lặng: một trường bỏ trống thì sau vài tháng không ai phân biệt được
   * "đã cân nhắc và bỏ" với "quên".
   */
  e2e: { spec: string | null; mienTruVi?: string };

  risk: "normal" | "financial" | "security" | "infrastructure";
}
