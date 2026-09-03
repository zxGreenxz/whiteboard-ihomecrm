import type { ActionKey } from "@/lib/permissions";

export type CopilotPageMode = "none" | "read" | "navigate" | "filter" | "draft";
export type CopilotDataClass = "public" | "internal" | "financial" | "security" | "pii";
export type CopilotPageBatch = "property" | "crm" | "billing" | "reports" | "communications" | "workforce";

export interface CopilotPageContract {
  key: string;
  route: string;
  canonicalRoute?: string;
  mode: CopilotPageMode;
  permission: { module: string; action: ActionKey };
  dataClass: CopilotDataClass;
  batch: CopilotPageBatch;
  rolloutKey: string;
  safeControlIds: readonly string[];

  /**
   * Mảnh đường dẫn mà FILE mang marker `data-ai-safe` của trang này phải chứa
   * (vd `"rooms"` khớp `src/pages/rooms/RoomsMobilePage.tsx` và
   * `src/components/rooms/RoomListFilters.tsx`).
   *
   * VÌ SAO CẦN: gate marker vốn chỉ đối chiếu marker với DANH SÁCH control, nên
   * `data-ai-safe="rooms.list.room.search"` nằm nhầm trong `CustomersMobilePage`
   * vẫn xanh — trang Phòng coi như đã có marker, còn trang Khách hàng thì mang
   * một control không phải của nó. Buộc file phải nằm đúng vùng của trang là
   * cách rẻ nhất để một marker không thể "đếm hộ" cho trang khác.
   *
   * BẮT BUỘC với mọi trang có `safeControlIds`; gate fail-closed khi thiếu.
   */
  markerFileHint?: string;
  /**
   * Các `action_id` mà Copilot được cầm TRÊN TRANG NÀY (khoá của
   * `app_private.copilot_action_registry`, mirror ở
   * `src/copilot/plan/actionCatalog.ts`).
   *
   * BẮT BUỘC — và là điều kiện DUY NHẤT — để một trang `dataClass: "financial"`
   * được mang `mode: "draft"`. `scripts/check-copilot-page-contracts.mjs` đòi
   * đủ ba thứ cùng lúc: mode `draft`, mọi id có thật trong sổ hành động, và
   * `e2eSpec` trỏ tới một spec có thật. Thiếu một là gate đỏ.
   *
   * Vì sao không suy ra từ `permission`: một khoá quyền có thể phục vụ nhiều
   * hành động (`deposits.create` là cả phiếu giữ chỗ lẫn những thứ sau này), nên
   * suy theo quyền sẽ mở rộng hơn thứ người viết contract định cho phép. Danh
   * sách phải TƯỜNG MINH.
   *
   * `security` KHÔNG bao giờ được nới bằng trường này — quyền và bí mật không
   * có "bản nháp".
   */
  actionIds?: readonly string[];
  e2eSpec?: string;
  exemption?: string;
}

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
    runtimeModule: "network-center" | null;
  };

  /**
   * Quyền gác bề mặt này.
   *
   * `guardMienTruVi` = route CỐ Ý không bọc `RequirePermission`, kèm lý do.
   * Bình thường `check-route-permission-drift` đòi guard của route khớp đúng
   * `module.action` ở đây, và nó đòi vậy vì lệch ở tầng route là loại tệ nhất:
   * trang mở được bằng cách gõ URL mà không có triệu chứng gì.
   *
   * Nhưng có trang CỐ Ý không gác vì nó phục vụ HAI đối tượng và tự rẽ bên trong
   * theo quyền — gác ở router sẽ chặn luôn nhóm đáng được vào. Trường hợp đó khác
   * hẳn "quên gác", và nhập hai thứ lại thì hoặc gate báo sai mãi, hoặc phải tắt
   * gate. Khai tường minh ở đây giữ được cả hai: gate vẫn cắn mọi route quên gác,
   * còn trường hợp cố ý thì đọc được lý do ngay tại chỗ.
   *
   * Cùng khuôn với `docs.userDocMienTruVi` và `e2e.mienTruVi`: miễn trừ phải
   * TƯỜNG MINH và có lý do, không bao giờ là một trường bỏ trống.
   */
  permission: { module: string; action: ActionKey; guardMienTruVi?: string };

  /** Explicit page surfaces Copilot may access; omitted means no Copilot access. */
  copilot?: { pages: readonly CopilotPageContract[] };

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
   * của capability (`src/components/network-center/**`) không rơi vào tier nào
   * của risk-map. Một checker "so risk với tier" sẽ so với `null` — xanh mà rỗng nghĩa.
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
