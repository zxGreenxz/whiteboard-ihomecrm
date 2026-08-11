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

  docs: {
    /** Tài liệu hệ thống (docs/he-thong/) — Copilot đọc, luôn phải có. */
    systemDoc: string;

    /**
     * Trang hướng dẫn NGƯỜI DÙNG trong docs-site.
     *
     * `null` = chưa có, và PHẢI kèm `userDocMienTruVi`. Cùng khuôn với `e2e.spec`:
     * một trường bỏ trống mà im lặng thì sau vài tháng không ai phân biệt được
     * "đã cân nhắc và bỏ" với "quên".
     */
    userDoc: string | null;
    userDocMienTruVi?: string;

    /**
     * Capability này có phải bề mặt dành cho NGƯỜI DÙNG CUỐI không.
     *
     * Đây là chỗ luật có răng: `public` thì BẮT BUỘC có `userDoc`, và trang đó
     * phải nằm trong sidebar của docs-site — không thì nó tồn tại mà không ai
     * tìm ra. `internal` là bề mặt quản trị/hạ tầng, không hứa gì với người dùng.
     *
     * Cố ý KHÔNG suy ra từ `userDoc == null`: suy như vậy thì một trang bị xoá
     * nhầm sẽ tự động hạ capability xuống `internal` mà không ai thấy.
     */
    visibility: "public" | "internal";
  };

  /**
   * Đường dẫn CŨ còn trỏ tới capability này (redirect).
   *
   * VÌ SAO KHAI DÙ HIỆN ĐANG RỖNG (đo 11/08/2026: không capability nào có alias)
   *   Khác với `owner` — thứ đã cố ý bỏ vì sẽ không bao giờ có răng — trường này
   *   có một luật cưỡng chế được NGAY KHI có dữ liệu đầu tiên: alias KHÔNG được
   *   xuất hiện ở nav, launcher hay permission picker (acceptance §7). Thêm một
   *   alias mà quên luật đó thì sinh ra hai mục menu cùng trỏ một trang, hoặc hai
   *   dòng quyền cho cùng một bề mặt.
   *
   *   Khai trước + gate sẵn thì cái bẫy đó không bao giờ mở ra được. Khai sau,
   *   lúc đã có alias, nghĩa là lần đầu tiên luôn không được canh.
   */
  aliases?: readonly string[];

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

  /**
   * Mức rủi ro của BỀ MẶT SẢN PHẨM này.
   *
   * KHÔNG PHẢI tier của `tooling/risk-map.json`, và đừng viết checker so hai cái.
   * Hai thứ trả lời hai câu hỏi khác nhau:
   *   - `risk` ở đây: "trang này hỏng thì hậu quả tới đâu" — thuộc tính của một
   *     bề mặt, đứng yên khi không ai sửa gì.
   *   - tier risk-map: "vừa sửa file này thì phải chạy gate nào" — thuộc tính của
   *     một THAY ĐỔI, tính từ đường dẫn file trong diff.
   *
   * Đo 11/08/2026 cho thấy chúng còn không so được về mặt kỹ thuật: file cài đặt
   * của cả hai capability (`src/components/network-center/**`,
   * `src/components/openclaw-zalo/**`) không rơi vào tier nào của risk-map. Một
   * checker "so risk với tier" sẽ so với `null` cho cả hai — xanh mà rỗng nghĩa.
   *
   * Thứ ĐÁNG làm và đã làm: bảo đảm nơi khai route/capability nằm TRONG một tier,
   * để sửa chúng còn kích hoạt đúng bộ gate (xem risk-map, tier `product-surface`).
   */
  risk: "normal" | "financial" | "security" | "infrastructure";

  /*
   * KHÔNG có trường `owner`, và đây là quyết định chứ không phải thiếu sót.
   *
   * Cùng lý do đã áp cho `tooling/known-gaps.yaml` (§0.6): repo một người. Một
   * trường chủ sở hữu chỉ có một giá trị khả dĩ thì không phân biệt được gì, mà
   * vẫn phải điền cho mọi mục mới — và trường bắt buộc nhưng vô nghĩa là thứ
   * người ta điền cho xong, rồi từ đó không ai tin trường nào trong file này nữa.
   *
   * Khi có người thứ hai: thêm `owner` VÀ một phép kiểm rằng mỗi capability trỏ
   * tới một người có thật, chứ đừng thêm trường trước rồi hy vọng nó được giữ đúng.
   */
}
