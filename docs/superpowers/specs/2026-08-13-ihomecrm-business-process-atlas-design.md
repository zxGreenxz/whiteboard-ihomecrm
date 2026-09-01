# iHomeCRM Business Process Atlas — Design

> **[CÒN SỐNG — trạng thái 02/09/2026]** Đã duyệt phương án, CHƯA bắt đầu triển khai. ("Atlas" ở đây là tên tài liệu quy trình nghiệp vụ — không liên quan công cụ atlas nào khác.)

**Ngày:** 2026-08-13

**Trạng thái:** Đã duyệt phương án kiến trúc, chưa triển khai

**Artifact đích:** `docs/artifacts/ihomecrm-business-process-atlas.html`

## 1. Objective

Tạo một business atlas HTML tương tác, tự chứa và mở trực tiếp được, mô tả hệ thống iHomeCRM từ bức tranh điều hành toàn công ty đến từng miền nghiệp vụ, từng quy trình và từng page thực tế trong ứng dụng.

Atlas phải phục vụ đồng thời ba nhu cầu nhưng ưu tiên theo thứ tự:

1. Lãnh đạo nhìn thấy vòng vận hành, dòng tiền, điểm bàn giao và rủi ro xuyên phòng ban.
2. Nhân viên tìm được page cần dùng, biết đầu vào, các bước, trạng thái, quyền và kết quả của nghiệp vụ.
3. Kỹ thuật và người quản trị truy vết được mỗi mô tả về route, tài liệu domain hoặc nguồn code hiện hành.

Đầu ra không phải một poster tĩnh. Nó là công cụ tra cứu có nhiều mức phóng đại về mặt thông tin:

```text
Tổng quan công ty
  -> Nhóm miền nghiệp vụ
    -> Miền nghiệp vụ
      -> Quy trình
        -> Bước / quyết định / handoff
          -> Page liên quan
            -> Vai trò, quyền, trạng thái, ngoại lệ và nguồn bằng chứng
```

## 2. Scope

### 2.1. In scope

- Một file HTML duy nhất, gồm CSS, JavaScript và dữ liệu atlas inline; không cần build step hoặc kết nối mạng để mở.
- Toàn bộ 112 route pattern render page hiện có trong cây route:
  - 102 page pattern được bảo vệ;
  - 10 page pattern công khai;
  - không tính `*` 404 là page nghiệp vụ.
- Toàn bộ 33 redirect được ghi dưới dạng alias `đường cũ -> page hiện hành`, không đếm thành page riêng.
- Các route render cùng component nhưng mang ý nghĩa tab/alias trực tiếp được giữ dưới dạng surface phụ, ví dụ:
  - `/materials/purchases`, `/materials/usages`, `/materials/adjustments`;
  - `/reports/finance/cash-book`;
  - `/reports/real-estate/vacant`, `/reports/real-estate/expiring`.
- Các route lồng của Network Center:
  - `/network-center/`;
  - `/network-center/buildings/:buildingId`.
- Tất cả miền `00-24` và quy trình tổng `99` trong `docs/he-thong`, với `24-platform-delivery` được trình bày như miền vận hành nền tảng, không phải nghiệp vụ người dùng cuối.
- Các quy trình xuyên miền chính:
  - khởi tạo tổ chức và phân quyền;
  - cấu hình toà/phòng/dịch vụ;
  - lead -> cọc -> hợp đồng;
  - chỉ số -> hoá đơn -> thu tiền;
  - phiếu thu/chi -> phê duyệt -> sổ quỹ -> bàn giao;
  - gia hạn/chuyển phòng/thanh lý;
  - vật tư, tài sản và công việc hiện trường;
  - My Day, kiểm tra nhà, lương và thưởng;
  - báo cáo, thông báo và phân bổ lợi nhuận;
  - Chat Zalo cũ, OpenClaw Zalo và Network Center;
  - cài đặt, danh mục, mẫu biểu, tài khoản và phát hành nền tảng.
- Nhãn mức độ hiện hành và mức tin cậy cho từng page/process.
- Tìm kiếm, lọc, điều hướng sâu bằng hash URL, bàn phím và giao diện responsive.
- Tự kiểm đếm coverage trong artifact và verification bên ngoài bằng browser/test script.

### 2.2. Out of scope

- Không sửa logic CRM, route, quyền, RPC, migration hoặc dữ liệu thật.
- Không refresh hoặc commit Understand Anything graph trong change set này.
- Không biến known issue được phát hiện trong lúc lập atlas thành task sửa lỗi.
- Không tạo tài liệu hướng dẫn sử dụng thay thế `docs-site`.
- Không mô phỏng thao tác ghi dữ liệu thật; atlas chỉ giải thích quy trình và liên kết page.
- Không publish artifact ra Internet nếu chưa có yêu cầu riêng của user.
- Không tuyên bố mô tả quy trình thủ công ngoài code/tài liệu là chính sách công ty đã được xác nhận nếu chưa có bằng chứng.

## 3. Definition of Done

Atlas chỉ được coi là hoàn tất khi có bằng chứng cho tất cả điều kiện sau:

1. **Page coverage:** 112/112 renderable page patterns có record hoặc được gom vào một record canonical có khai rõ surface phụ.
2. **Alias coverage:** 33/33 redirect có mapping target; không alias nào bị hiển thị như nghiệp vụ độc lập.
3. **Domain coverage:** mọi domain `00-24` và `99` có mô tả, nhóm, actor, quy trình hoặc vai trò hỗ trợ rõ ràng.
4. **Process coverage:** mỗi quy trình chính có trigger, actor, steps, decision/exception, output và handoff.
5. **Page detail:** mỗi page record có route, tên, mục tiêu, actor, quyền/gate, input, actions, states, outputs, related processes, related pages, aliases, confidence/status và sources.
6. **Truthfulness:** runtime-off, legacy, placeholder, mock, known issue và undocumented behavior được gắn nhãn; không vẽ chúng như flow production bình thường.
7. **Interaction:** search, filters, overview drill-down, process/page detail, back/forward hash navigation, theme switch và mobile navigation hoạt động.
8. **Accessibility:** semantic controls, visible focus, keyboard navigation, accessible contrast, no essential hover-only content và reduced-motion support.
9. **Responsive:** desktop rộng và mobile hẹp không có accidental body overflow, panel không che nội dung chính và mọi chi tiết vẫn truy cập được.
10. **Browser verification:** mở file trực tiếp, không console error; kiểm tra desktop/mobile, search/filter/detail/hash/theme và coverage panel.
11. **Change hygiene:** change set chỉ chứa artifact/spec/plan/verifier cần cho atlas; không chứa file ngoài phạm vi hoặc thay đổi có sẵn của user.

## 4. Sources of truth

Thứ tự ưu tiên khi các nguồn mâu thuẫn:

1. Route và guard hiện hành trong `src/app/routes/` cùng nested routes.
2. Catalog quyền trong `src/lib/permissionPages.ts`, permission registry và capability registry.
3. Code page/hook/RPC adapter đang chạy.
4. `docs/he-thong/99-quy-trinh-tong.md` và tài liệu domain `00-24`.
5. User docs và prose hỗ trợ khác.

Understand Anything graph không được dùng làm nguồn kết luận trong phiên này vì `gate:graph-freshness -- --nhiem-vu domain-review` báo stale: 192 commit, 496 file đổi, 151 file mới, thiếu 32 migration và thiếu `services/openclaw-media-gateway`.

Các phép kiểm hiện hành đã tạo baseline cho atlas:

- `node scripts/check-route-guards.mjs --list`:
  - 146 route declarations;
  - 102 guarded page patterns;
  - 11 public allowlist entries, trong đó một entry là catch-all `*`;
  - 33 redirects;
  - 10 public page patterns thực tế;
  - 112 renderable page patterns không tính redirect và 404.
- `npm run gate:permission-catalog`: 231 khoá DB khớp 231 nhãn FE.
- `npm run gate:route-permission-drift`: 27 capability khớp guard, một exemption salary có lý do.
- `npm run gate:capability-surfaces`: 27 capability có đủ surface route, permission page và system doc.

### 4.1. Confidence model

Mỗi record khai một trong các mức:

| Mức | Ý nghĩa |
| --- | --- |
| `verified-current` | Route/code hiện hành và tài liệu đã review hoặc kiểm tra trực tiếp cùng xác nhận hành vi. |
| `current-code` | Code/route hiện hành là bằng chứng chính; tài liệu có thể chưa có ngày review. |
| `documented` | Có tài liệu domain nhưng chưa đủ bằng chứng code chi tiết cho mọi state. |
| `needs-operator-confirmation` | Code không thể chứng minh quy ước vận hành ngoài hệ thống. |

`confidence` không thay cho trạng thái sản phẩm. Một record có thể vừa `current-code` vừa `legacy-broken`.

### 4.2. Product status model

Mỗi page/process có một hoặc nhiều badge:

- `current` — flow/page hiện hành.
- `runtime-off` — có code nhưng feature flag mặc định tắt hoặc rollout chưa mở.
- `legacy` — đường cũ còn tồn tại để tương thích.
- `legacy-broken` — flow cũ còn surface nhưng bằng chứng cho thấy không còn đúng schema/nguồn sự thật.
- `placeholder` — route render nhưng nội dung chưa triển khai nghiệp vụ.
- `mock` — dữ liệu hoặc UI hardcode, không phải runtime thật.
- `known-issue` — có lỗi/giới hạn đã được evidence xác nhận.
- `internal` — dành cho quản trị/hạ tầng/kỹ thuật.
- `public` — không cần đăng nhập.

## 5. Information architecture

Atlas dùng một shell duy nhất với bốn chế độ xem phối hợp. Người dùng không phải rời trang để đổi mức chi tiết.

### 5.1. Overview — “Vòng vận hành công ty”

Màn mặc định trả lời: “Công ty vận hành từ lúc cấu hình nguồn lực đến lúc thu tiền, báo cáo và tái phân bổ như thế nào?”

Trục chính từ trái sang phải:

```text
Tổ chức & quyền
  -> Toà / phòng / dịch vụ
  -> Lead / Sale phòng
  -> Cọc giữ chỗ
  -> Hợp đồng
  -> Chỉ số
  -> Hoá đơn
  -> Thu tiền
  -> Phiếu / sổ quỹ / bàn giao
  -> Báo cáo
  -> Lợi nhuận / lương
```

Các nhánh hỗ trợ gắn đúng điểm handoff:

- Khách hàng, phương tiện và CT01 gắn với hợp đồng.
- Tài sản và biên bản bàn giao gắn với phòng/hợp đồng.
- Vật tư gắn với công việc.
- Công việc, My Day và kiểm tra nhà gắn với lương/thưởng.
- Thông báo, Chat Zalo và OpenClaw gắn với chăm sóc khách hàng/vận hành.
- Network Center gắn với toà nhà nhưng nằm ngoài dòng tiền.
- AI Copilot đọc tài liệu/tool theo quyền và không được vẽ như authorization boundary.
- Platform delivery bao quanh toàn bộ như lane vận hành kỹ thuật.

Node overview chỉ giữ thông tin cần để hiểu handoff. Chọn node sẽ chuyển sang Domain hoặc Process view tương ứng.

### 5.2. Domain map

Các domain được gom theo vùng trách nhiệm, không chỉ theo số tài liệu:

1. **Nền tảng & quản trị:** tổng quan, tổ chức/phân quyền, cài đặt/danh mục, tài khoản, platform delivery.
2. **Bất động sản:** toà nhà, phòng, dịch vụ, bản đồ toà, Sale Phòng.
3. **Khách hàng & hợp đồng:** lead, cọc, cư dân, phương tiện, hợp đồng, thanh lý.
4. **Tài chính:** chỉ số, hoá đơn, thu tiền, thu chi, phê duyệt, sổ quỹ, lợi nhuận, ví cá nhân.
5. **Vận hành:** vật tư, tài sản, công việc, My Day, kiểm tra nhà, lương/thưởng.
6. **Quan sát & báo cáo:** dashboard, báo cáo BĐS, báo cáo tài chính, thông báo.
7. **Giao tiếp & tự động hoá:** Chat Zalo, OpenClaw Zalo, AI Copilot.
8. **Hạ tầng toà nhà:** Network Center.

Mỗi domain tile hiển thị số process, số page canonical, số surface phụ và số warning. Chọn tile mở domain workspace gồm process list, page list và dependency/handoff.

### 5.3. Process explorer

Một process record hiển thị theo layout ba vùng:

- **Header:** mục tiêu, actor, product status, confidence và source links.
- **Flow:** các step theo thứ tự, decision branch và handoff.
- **Inspector:** input, states, outputs, exceptions, pages và related processes.

Process flow dùng HTML/CSS cho lanes và step cards; SVG chỉ dùng connectors. Không dùng một canvas khổng lồ. Mỗi process phải hiểu được ở default zoom và reflow thành timeline dọc trên mobile.

Các process bắt buộc tối thiểu:

1. Khởi tạo organization, membership, role và scope.
2. Khai báo toà, tầng, phòng, dịch vụ, công tơ và sổ mặc định.
3. Lead lifecycle và chuyển đổi.
4. Cọc giữ chỗ canonical và Quick Deposit công khai.
5. Tạo hợp đồng, liên kết cọc và sinh khoản đầu kỳ.
6. Gia hạn, chuyển phòng/chuyển nhượng.
7. Ghi chỉ số và sinh hoá đơn.
8. Thu một hoá đơn và thu hàng loạt.
9. Tiền thừa/credit và hoàn tác payment.
10. Phiếu thu/chi thường và recurring/batch.
11. Maker-checker approval.
12. Sổ quỹ, bàn giao và khoá kỳ hai phía.
13. Thanh lý `FORFEIT`.
14. Thanh lý `MOVE_OUT`.
15. Nhập/xuất/điều chỉnh vật tư.
16. Tài sản: tạo, di chuyển, bảo trì và bàn giao.
17. Công việc: giao việc -> bằng chứng camera/GPS -> hoàn thành -> thưởng.
18. My Day, xin nghỉ và inspection FULL/QUICK.
19. Chốt/mở khoá/trả lương.
20. Profit Close V2 và phân bổ cổ đông.
21. Báo cáo và notification deep-link.
22. Chat Zalo cũ: connect -> conversation -> send/realtime.
23. OpenClaw: consent -> QR -> connection -> outbox -> policy -> rollout.
24. Network Center: rollout -> poll -> intent/command -> result/incident.
25. Web/schema/Edge/worker/cron delivery lanes.

### 5.4. Page explorer

Page explorer là danh mục đầy đủ, không chỉ là menu hiện tại. Nó cho phép lọc theo:

- domain;
- actor;
- public/protected/internal;
- permission module/action;
- list/detail/form/print/report/settings/public/internal;
- product status;
- desktop/mobile variant;
- nav/launcher visibility;
- confidence.

Mỗi page detail hiển thị:

- canonical route và direct-render surfaces;
- component/page name;
- mục tiêu và actor;
- route guard/permission cùng exemption nếu có;
- trigger/input;
- main actions;
- states/branches;
- output/handoff;
- related processes;
- related pages;
- aliases/redirects;
- mobile/desktop behavior;
- warnings/known issues;
- source evidence.

Detail, form, print, tab subroute và public surface vẫn là page record hoặc surface rõ ràng, dù không có sidebar/launcher.

## 6. Data model

Dữ liệu được khai ở đầu JavaScript trong cùng file HTML, tách khỏi renderer. Không hardcode nội dung nghiệp vụ trong template DOM.

```ts
type Atlas = {
  meta: AtlasMeta;
  groups: DomainGroup[];
  domains: Domain[];
  actors: Actor[];
  processes: Process[];
  pages: Page[];
  aliases: Alias[];
  sources: Source[];
};
```

### 6.1. Page record

```ts
type Page = {
  id: string;
  canonicalRoute: string;
  surfaces: Array<{
    route: string;
    kind: "canonical" | "detail" | "form" | "print" | "tab" | "direct-alias" | "nested";
  }>;
  name: string;
  component: string;
  domainId: string;
  pageType: string;
  summary: string;
  actors: string[];
  access: {
    public: boolean;
    authenticated: boolean;
    module?: string;
    action?: string;
    gate?: string;
    exemptionReason?: string;
  };
  navigation: {
    desktopNav: boolean;
    mobileLauncher: boolean;
  };
  variants: string[];
  inputs: string[];
  actions: string[];
  states: string[];
  outputs: string[];
  processIds: string[];
  relatedPageIds: string[];
  aliasIds: string[];
  status: string[];
  confidence: string;
  warnings: string[];
  sourceIds: string[];
};
```

### 6.2. Process record

```ts
type Process = {
  id: string;
  name: string;
  domainIds: string[];
  summary: string;
  actors: string[];
  trigger: string;
  inputs: string[];
  steps: Array<{
    id: string;
    lane: string;
    kind: "action" | "decision" | "system" | "handoff" | "terminal";
    title: string;
    description: string;
    pageIds: string[];
    next: Array<{ to: string; label?: string; condition?: string }>;
  }>;
  states: string[];
  outputs: string[];
  exceptions: string[];
  relatedProcessIds: string[];
  status: string[];
  confidence: string;
  sourceIds: string[];
};
```

### 6.3. Alias record

```ts
type Alias = {
  from: string;
  to: string;
  kind: "redirect" | "custom-redirect";
  note?: string;
  sourceIds: string[];
};
```

`/tenants/:id` phải được ghi là `custom-redirect` về `/customers/:id`. `/rooms/:id` phải có note rằng target `/apartments` làm mất `id`.

### 6.4. Source record

Source không nhúng toàn bộ prose. Nó chỉ giữ nhãn, path, optional line và loại bằng chứng để inspector liên kết được trong workspace:

```ts
type Source = {
  id: string;
  path: string;
  line?: number;
  kind: "route" | "permission" | "page" | "hook" | "domain-doc" | "contract" | "gate";
  label: string;
};
```

## 7. Canonicalization rules

1. Redirect không tạo page record.
2. Direct-render alias có thể là surface của cùng page record nếu component và nghiệp vụ giống nhau.
3. Detail/form/print route là surface riêng trong page record khi cùng một capability; tạo page record riêng khi workflow và content đủ độc lập để người dùng tìm riêng.
4. Một component render nhiều tab theo pathname, như MaterialsPage, dùng một canonical page cùng các tab surfaces.
5. Feature runtime-off vẫn có record nhưng mặc định bị dim và mang badge `runtime-off`.
6. Placeholder/mock không bị loại khỏi coverage; chúng phải xuất hiện để atlas trung thực.
7. Route không có `RequirePermission` không được tự suy ra là public. Access lấy từ guard thực tế và page/RPC exemption.
8. Permission picker và capability registry không phải route inventory; chúng chỉ bổ sung quyền và navigation metadata.
9. Known issue được trình bày như warning, không thay thế happy path và không được biến thành recommendation sửa ngoài scope.

## 8. Known caveats that must be visible

Ít nhất các caveat sau phải xuất hiện đúng page/process:

- Lead conversion đang đi flow legacy, dùng `tenants`/legacy deposits và có mismatch `hold_until_date` so với `hold_until`; badge `legacy-broken`.
- Bảng `deposits` và `/reports/finance/deposits` là legacy/dead; nguồn cọc giữ chỗ hiện hành là voucher `income_expenses` có item `is_deposit`.
- Customer `status_v2` chưa có writer đầy đủ cho mọi tab.
- CT01 history hook chưa có UI hoạt động.
- `/rooms/:id` redirect về list và mất `id`.
- Building service replace và service quota tier replace không transactional.
- Meter page có các giới hạn filter/import đã được tài liệu ghi nhận.
- Thu hàng loạt là atomic theo sub-line/invoice, không atomic cho toàn batch.
- Excess credit có bước sau RPC cần reconciliation.
- Final meter khi thanh lý là best effort.
- Approvals page cố ý không có route permission; RPC lọc theo `auth.uid()`.
- Salary route cố ý không có `RequirePermission salary.view`; page tự rẽ admin/self và RLS bảo vệ dữ liệu.
- Asset settings movements/maintenance/types có placeholder; workflow thật nằm ở `/assets`.
- Suppliers và một số general category surface là placeholder.
- Signatures page là mock/inert.
- Material header/line writes là nhiều request với compensating cleanup, không phải một transaction duy nhất.
- Chat Zalo automation chỉ có config UI, không có worker automation engine; số lượt automation hiện có dữ liệu hardcode.
- OpenClaw Zalo và Network Center phụ thuộc runtime flag/rollout.
- `/issues` được một số link nhắc tới nhưng không có route hiện hành.
- General Settings logo preview dùng object URL, không phải upload bền vững.
- `/c/:code` có bằng chứng là public contract/invoice lookup nhưng expiry/revocation behavior chưa được selected docs mô tả đủ; confidence phải phản ánh điều đó.

## 9. Visual direction

### 9.1. Register

“Bản đồ điều hành toà nhà”: kỹ thuật, sáng rõ, có cảm giác của sơ đồ mặt bằng và bảng điều độ, không giống dashboard SaaS chung chung.

Atlas là công cụ làm việc lâu dài, nên ưu tiên legibility và information density có kiểm soát. Không dùng hero khổng lồ, gradient tím, card bo tròn đồng dạng hoặc animation trang trí.

### 9.2. Color tokens

Light theme đề xuất:

| Token | Hex | Vai trò |
| --- | --- | --- |
| `paper` | `#F4F7F5` | Nền bản đồ xanh xám rất nhạt. |
| `ink` | `#102A2C` | Chữ và đường cấu trúc chính. |
| `grid` | `#C8D5D1` | Đường lưới, separator và boundary. |
| `operations` | `#167D8D` | Vận hành, tài sản, công việc, hạ tầng. |
| `money` | `#C58A13` | Dòng tiền, hoá đơn, thu chi, lợi nhuận. |
| `risk` | `#B6493F` | Warning, legacy-broken, known issue. |

Dark theme dùng nền xanh than, không đảo màu cơ học; giữ money đủ sáng và risk đủ tương phản. Status colors độc lập với accent.

### 9.3. Typography

- Display: Georgia/Cambria hoặc font serif local có nét sơ đồ kỹ thuật, dùng tiết chế cho tiêu đề lớn.
- Body: Segoe UI/Tahoma local, ưu tiên khả năng đọc tiếng Việt và không cần tải mạng.
- Utility/data: Consolas/Cascadia Mono local cho route, permission, counts và source path.

Không dùng Google Fonts hoặc CDN. Toàn bộ font stack phải hoạt động offline.

### 9.4. Layout

Desktop:

```text
+---------------------------------------------------------------+
| Command bar: logo/title | search | mode | filters | theme      |
+--------------+--------------------------------+---------------+
| Navigator    | Main stage                     | Inspector     |
| domains      | overview / domain / process    | selected item |
| saved views  | / page results                 | evidence      |
+--------------+--------------------------------+---------------+
| Coverage/status bar                                            |
+---------------------------------------------------------------+
```

Mobile:

- command bar sticky;
- main content là một cột;
- navigator mở bằng drawer;
- inspector mở thành bottom sheet/full-screen detail;
- process chuyển từ lanes ngang sang timeline dọc;
- filter chips có vùng scroll riêng, không làm body overflow.

### 9.5. Motion

Chỉ dùng hai motion có ý nghĩa:

1. Highlight đường handoff khi chọn node/process.
2. Transition nhẹ khi inspector thay record để giữ continuity.

`prefers-reduced-motion` tắt cả hai và thay bằng cập nhật tức thời.

## 10. Interaction design

### 10.1. Search

Search index gồm:

- tên/route/component page;
- process name/step;
- actor;
- permission module.action;
- status/warning;
- domain;
- source label/path.

Kết quả chia nhóm `Quy trình`, `Page`, `Domain`, `Alias`. Keyboard: `/` focus search, arrows di chuyển, Enter mở, Escape đóng.

### 10.2. Filters

Filter state được phản ánh trong URL hash để back/forward và copy link hoạt động. Ví dụ:

```text
#/pages?domain=finance&status=known-issue&actor=collector
#/process/payment-collection
#/page/invoices
```

Filter có nút reset, active count và empty state giải thích vì sao không có kết quả.

### 10.3. Selection and inspector

Node/card là button hoặc link semantic. Chọn item:

- cập nhật hash;
- highlight related pages/processes;
- đưa focus vào heading inspector khi dùng keyboard;
- giữ main stage stable để người dùng không mất vị trí.

Inspector có tabs `Tổng quan`, `Quy trình/Page`, `Ngoại lệ`, `Nguồn` nhưng nội dung quan trọng không bị khóa sau hover.

### 10.4. Theme

Theme mặc định theo OS. Toggle ghi `data-theme` và `localStorage`; attribute override media query cả hai chiều.

### 10.5. Print/export

Print stylesheet chuyển selected domain/process/page thành tài liệu đọc được, hiện source và warning, ẩn controls. Không cần PDF generator riêng.

## 11. Coverage and integrity checks

### 11.1. Runtime self-audit

Artifact có panel `Độ phủ` tính từ dữ liệu inline:

- route surfaces đã ghi;
- canonical page count;
- redirects mapped;
- domains/processes/pages không có liên kết;
- duplicate IDs/routes;
- missing source IDs;
- pages không thuộc process;
- processes không có page/handoff;
- warnings theo status.

Nếu integrity fail, coverage badge chuyển đỏ và liệt kê lỗi cụ thể. Artifact không được hardcode chữ `100%` độc lập với dữ liệu.

### 11.2. External verifier

Triển khai một verifier nhỏ đọc HTML và so route inventory hiện hành từ `collectAllRoutes()` với dataset inline. Verifier phải:

1. loại redirect và `*`;
2. nhận diện custom redirect `/tenants/:id`;
3. so 112 renderable patterns với union của page surfaces;
4. so 33 redirects với aliases;
5. fail khi route thiếu/thừa không có exemption;
6. validate unique IDs, references và required fields;
7. không sửa artifact khi chạy check.

Alias npm dự kiến: `gate:business-atlas`.

Verifier và test của nó thuộc scope vì chúng chứng minh yêu cầu “toàn bộ page”; không mở rộng sang audit product khác.

## 12. Error, empty and loading states

Artifact offline không có network loading. Các state cần model:

- initial render;
- no search results;
- filters produce empty result;
- unknown hash route -> quay về overview kèm thông báo;
- missing record reference -> self-audit error nhưng phần còn lại vẫn dùng được;
- selected runtime-off/placeholder/legacy item -> callout giải thích, không giả action khả dụng;
- narrow viewport drawer/sheet open/closed;
- print mode.

Không có dead button. Control chưa có hành vi cần thiết sẽ không xuất hiện.

## 13. Implementation boundaries

Artifact không import React, Mermaid, D3, external icon font hoặc CDN. Dùng:

- semantic HTML;
- CSS Grid/Flexbox;
- SVG nhỏ cho connectors/icons cần thiết;
- vanilla JavaScript module-style functions trong một `<script>`;
- `history`/`hashchange` cho navigation;
- `localStorage` cho theme và optional saved filter state.

Code trong file được chia rõ:

1. `ATLAS_DATA`;
2. validation/indexing;
3. state/router;
4. renderers theo view;
5. interaction/accessibility utilities;
6. bootstrap.

Không minify source; artifact cần đọc và bảo trì được.

## 14. Verification plan

### 14.1. Static and data gates

- `node scripts/check-route-guards.mjs --list`
- `npm run gate:permission-catalog`
- `npm run gate:route-permission-drift`
- `npm run gate:capability-surfaces`
- `npm run gate:business-atlas`
- focused tests cho verifier/route canonicalization.

### 14.2. Browser verification

Mở file qua local static server hoặc direct file nếu browser tool hỗ trợ. Kiểm tra:

- desktop khoảng 1440x900;
- mobile khoảng 390x844;
- overview -> domain -> process -> page drill-down;
- search theo route, tên nghiệp vụ và permission;
- multi-filter + reset + empty state;
- hash deep link + reload + back/forward;
- alias lookup đưa tới canonical page;
- runtime-off, legacy-broken, placeholder, mock và known-issue callouts;
- theme light/dark và OS preference;
- keyboard Tab/Shift+Tab/Enter/Space/Escape;
- visible focus và focus restoration;
- reduced motion;
- print preview cơ bản;
- console errors;
- horizontal overflow và clipped content.

### 14.3. Completion audit

Trước khi kết luận hoàn tất, lập bảng requirement -> evidence:

- 112 page patterns -> verifier output + runtime coverage panel;
- 33 redirects -> verifier output + alias browser spot checks;
- domain/process coverage -> dataset counts + orphan checks;
- page/process detail fields -> schema validator;
- responsive/accessibility/interactions -> browser evidence;
- scope hygiene -> `git diff --name-status` và review file cụ thể.

## 15. Deliverables

Implementation dự kiến tạo đúng các artifact cần thiết:

1. `docs/artifacts/ihomecrm-business-process-atlas.html` — deliverable chính, tự chứa.
2. `scripts/check-business-atlas.mjs` — coverage/integrity verifier.
3. `scripts/__tests__/check-business-atlas.test.mjs` — focused verifier tests.
4. `package.json` — thêm duy nhất alias `gate:business-atlas` nếu không có cách repo-local phù hợp hơn.
5. Implementation plan trong `docs/superpowers/plans/`.

Không cập nhật `docs/he-thong` chỉ để chèn link atlas trong phase này; đó là bước riêng nếu user muốn đưa atlas vào docs-site hoặc AI Copilot.

## 16. Acceptance summary

Thiết kế này giữ một critical path duy nhất:

1. Chốt dataset schema và route canonicalization.
2. Nhập đủ domain/process/page/alias với sources và status trung thực.
3. Xây renderer/interactions trong một HTML tự chứa.
4. Thêm verifier chứng minh coverage.
5. Browser QA desktop/mobile và completion audit.

Khi toàn bộ verification xanh, dừng. Không mở thêm wave sửa known issue, refresh graph, redesign CRM hoặc publish public page trong cùng task.
