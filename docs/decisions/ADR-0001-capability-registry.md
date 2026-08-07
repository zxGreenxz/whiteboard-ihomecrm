---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - src/app/capabilities/registry.ts
  - src/app/capabilities/types.ts
  - src/app/capabilities/surfaceAdapters.ts
  - src/app/capabilities/__tests__/capabilityContract.test.ts
  - src/app/capabilities/__tests__/capabilityContractDisabled.test.ts
  - scripts/check-capability-surfaces.mjs
  - src/components/layout/Sidebar.tsx
  - src/pages/home/launcherTiles.ts
  - src/lib/permissionPages.ts
  - src/lib/openclaw-zalo/runtime.ts
  - src/lib/network-center/runtime.ts
  - tooling/program-status.json
copilot_ingest: true
risk: normal
---

# ADR-0001 — Capability Registry: khai bề mặt sản phẩm mức trang đúng một chỗ

**Trạng thái:** đã áp dụng. Lát dựng registry ở `bf03a9b1`, lát đổi chiều phụ thuộc ở `a4265f83`.
**Phạm vi:** đúng 2 capability (`network-center`, `openclaw-zalo`) — xem "Khoảng trống còn lại".

Luật chung về gate/bằng chứng ở [`docs/engineering/PROJECT_CONTRACT.md`](../engineering/PROJECT_CONTRACT.md);
trang này chỉ giải thích quyết định và những cái bẫy đã trả giá thật.

---

## 1. Bối cảnh — bốn nơi khai lặp, và nó đã drift thật

Một capability mức trang phải có mặt ở bốn chỗ độc lập nhau, không chỗ nào biết chỗ nào:

| Bề mặt | File | Bằng chứng |
|---|---|---|
| Route JSX | `src/App.tsx`, `src/app/routes/*.tsx` | `src/App.tsx:338` (`/openclaw-zalo`), `src/app/routes/quickTrackRoutes.tsx:37` (`/network-center/*`) |
| Nav desktop | `src/components/layout/Sidebar.tsx` | `Sidebar.tsx:138`, `Sidebar.tsx:191` |
| Launcher mobile | `src/pages/home/launcherTiles.ts` | `launcherTiles.ts:77`, `launcherTiles.ts:79` |
| Permission picker | `src/lib/permissionPages.ts` | `permissionPages.ts:144` (route `/openclaw-zalo`), `permissionPages.ts:464` (route `/network-center`) |

Bốn bản khai này lệch nhau là chuyện **đã xảy ra**, không phải rủi ro giả định:

- **`7f47c3a6` — "gác nốt mục sidebar bằng cùng cờ với route và tile" (05/08/2026).** Route và
  launcher tile đã bị gác sau cờ runtime, nhưng mục sidebar thì chưa. Hậu quả ghi trong chính commit
  đó: chủ sở hữu **có** quyền `openclaw_zalo.view` nên vẫn thấy mục nav, bấm vào rơi vào 404 vì route
  đã bị biên dịch bỏ. Đây là lỗi chỉ lộ ra với đúng những người có quyền cao nhất — người ít quyền
  không thấy mục nên không bao giờ báo.
- Lớp lỗi rộng hơn cùng dạng, ghi ở `tooling/program-status.json` (mục realtime): `contract_terminations`
  và `contract_transfers` **vắng mặt ở cả hai nơi cần khai**, không test nào bắt — vì khi cả hai bản
  khai cùng thiếu thì phép đối chiếu vẫn khớp.

Cờ runtime làm việc lặp này nguy hiểm hơn bình thường: `resolveOpenClawMode` /
`resolveNetworkCenterMode` mặc định trả `"off"` và từ chối `"demo"` trong production build
(`src/lib/openclaw-zalo/runtime.ts`, `src/lib/network-center/runtime.ts`). Nghĩa là trạng thái mặc
định của repo là "route không tồn tại" — mọi bề mặt quên gác cờ đều dẫn thẳng tới 404.

## 2. Quyết định

**Registry (`src/app/capabilities/registry.ts`) là nguồn khai duy nhất cho: nhãn, route chính, quyền
gác (`module` + `action`), cờ bật/tắt, cờ hiện diện ở từng bề mặt, trang tài liệu, mức rủi ro.**
Hình dạng đầy đủ ở `src/app/capabilities/types.ts:12-43`.

Consumer **sinh ra từ** registry qua `navFieldsFor` / `launcherFieldsFor`
(`src/app/capabilities/surfaceAdapters.ts:61,68`), không khai lại rồi chờ test bắt lỗi. Khác biệt
không nhỏ và được ghi thẳng trong header adapter: đối chiếu chỉ phát hiện lệch **sau khi** lệch đã
nằm trong mã nguồn và chỉ khi test được chạy; sinh từ nguồn thì lệch không dựng lên được.

**Icon và màu accent Ở LẠI consumer.** Chúng là component React và hằng trình bày. Registry phải
**serialize được** để gate/CI đọc bằng Node trần — nhét `LucideIcon` vào đó là mất tính chất ấy.
Xem `launcherTiles.ts:75-79` và `Sidebar.tsx:134-138`: consumer chỉ ghép thêm `icon`/`accent`,
`satisfies` là chỗ trình biên dịch kiểm hai bên còn khớp kiểu.

**KHÔNG khai tên biến env trong registry** (`types.ts:18-24`). Cờ đã resolve đúng một chỗ cho mỗi hệ
(`src/lib/<domain>/runtime.ts`); thêm tên env vào registry là tạo nguồn đọc thứ hai cho cùng một
quyết định — đúng thứ registry sinh ra để loại bỏ.

**KHÔNG nuốt `permissionPages.ts`** (742 dòng, đo bằng `wc -l`; feature/action-level, nhiều component
dùng). Registry chỉ tham chiếu bằng `surfaces.permissionPage` (`types.ts:33-38`).

## 3. Hệ quả ĐÃ BIẾT — lát 3 bịt một lỗ và mở một lỗ khác

Đây là phần quan trọng nhất của ADR này.

Contract test cũ so registry với sidebar/launcher. Sau khi sidebar/launcher **sinh ra** từ registry,
phép so đó trở thành **so registry với chính nó** — xanh vĩnh viễn kể cả khi cả hai cùng sai. Header
của `capabilityContract.test.ts:8-19` ghi thẳng điều này để người sau không tin nhầm một test không
chứng minh gì. Phần còn giá trị: nó vẫn chốt hình dạng dữ liệu và vẫn bắt lỗi ở tầng adapter (quên
map `action`, trả tile khi cờ tắt); và **các phép so với `ALL_PAGES` thì KHÔNG tự quy chiếu** vì
`permissionPages.ts` vẫn khai tay hoàn toàn (`capabilityContract.test.ts:99-106`).

Phép kiểm thật dời sang **`scripts/check-capability-surfaces.mjs`**, đọc mã nguồn và bắt bốn thứ
CÒN lệch được (`check-capability-surfaces.mjs:123-167`):

1. không ai khai TAY lại một capability route ở consumer — bản khai thứ hai làm registry mất quyền sở hữu;
2. `<Route path=...>` vẫn là JSX viết tay nên vẫn lệch được với registry ⇒ phải tồn tại;
3. trang trong permission picker phải còn (mất trang = không ai cấp/thu được quyền qua UI);
4. `docs.systemDoc` registry trỏ tới phải tồn tại thật.

Gate đã chạy tại commit này: `node scripts/check-capability-surfaces.mjs` →
`Capability: 2 · consumer kiểm 2 · nguồn route 10`, exit 0. Wiring: `package.json:75`
(`gate:capability-surfaces`) và `.github/workflows/ci-gates.yml:124`.

Bốn cái bẫy đã trả giá thật, đều đang được mã hoá trong gate:

- **Gate không import registry, mà bóc literal bằng regex** (`check-capability-surfaces.mjs:46-53`).
  Vì `registry.ts` import runtime module đọc `import.meta.env`, Node trần không có nó nên import
  thẳng sẽ nổ.
- **Sàn `TOI_THIEU_CAPABILITY = 2`** (dòng 38). Nếu bộ bóc literal hỏng, danh sách thành rỗng, mọi
  vòng lặp chạy 0 lần và gate in dấu tick trên hư không. `"0 vi phạm" trên 0 capability là câu đúng
  mà vô nghĩa` — nguyên văn dòng 117.
- **Gate strip comment trước khi tìm bản khai tay** (dòng 78). Một comment giải thích "route
  `/openclaw-zalo` bị gác sau cờ" không phải bản khai thứ hai; gate tự khớp vào chính câu nói thứ mà
  nó cấm là lỗi đã lặp nhiều lần trong repo.
- **Route splat.** Bản đầu của gate đòi `path="/network-center"` khít và kêu nhầm ngay lần chạy thứ
  nhất, vì route thật là `/network-center/*` (`quickTrackRoutes.tsx:37`) — react-router vẫn khớp
  đúng đường đó. Nay chấp nhận cả hai dạng (dòng 90-93).

Hệ quả nhỏ hơn nhưng cố ý: adapter **không ném lỗi khi gặp id lạ**, chỉ trả rỗng
(`surfaceAdapters.ts:42-45`) — file chạy lúc module khởi tạo, ném ở đó sẽ làm trắng màn hình vì một
dòng cấu hình sai; id lạ để gate CI bắt. Adapter trả **mảng** thay vì `T | null` để consumer trải
bằng `...` ngay trong literal, giữ nguyên hình dạng cũ của `navigationGroups`.

Vì cờ được đọc lúc module nạp, hai trạng thái bật/tắt không cùng tồn tại trong một module graph ⇒
contract test phải tách hai file, và **mỗi file có một test chốt chặn xác nhận mock thật sự có hiệu
lực** (`capabilityContract.test.ts:65-70`, `capabilityContractDisabled.test.ts:34-37`). Bản đầu
không có chốt này: cả hai cờ mặc định TẮT trong môi trường test nên nhánh kiểm `(module, action)`
return sớm và test xanh trong khi không so gì cả.

## 4. Khoảng trống còn lại

- **`UNSHIPPED_PAGE_KEYS` chỉ che `openclaw_zalo`, không che `network_center`**
  (`permissionPages.ts:622-624`), trong khi `NETWORK_CENTER_RUNTIME_ENABLED` cũng mặc định `off`.
  Registry đã có sẵn `release.enabled` + `surfaces.permissionPage` để dẫn xuất tập này nhưng chưa ai
  nối. Hệ quả: khi cờ tắt, permission picker vẫn chào mời trang "Trung tâm mạng".
  **CHƯA KIỂM CHỨNG:** đây là cố ý (network-center có thể được coi là đã ship) hay bỏ sót — không
  tìm thấy comment hay commit nào giải thích.
- **Registry mới có 2 capability**, cố ý — chọn đúng hai cái đã drift thật. Các trang còn lại (khách
  hàng, hợp đồng, tài chính…) vẫn khai tay ở cả bốn nơi và **không** được gate này bảo vệ.
- **`tooling/program-status.json` đang nói sai về lát 3.** File này ghi lát 3 bị "chủ dự án hoãn
  07/08/2026" trong `hoanCoChuY`, nhưng commit `a4265f83` (07/08/2026 13:21) đã làm xong lát đó.
  `git log -- tooling/program-status.json` cho biết lần sửa gần nhất là `96d090e0`, **trước**
  `a4265f83` ⇒ nhịp tim chương trình chưa được cập nhật lại. Đọc file đó thì phải đối chiếu `git log`.

## 5. Phương án đã cân nhắc và bỏ

| Phương án | Vì sao bỏ |
|---|---|
| Nhét icon/element React vào registry cho "đủ một chỗ" | Mất tính serialize được ⇒ gate Node trần không đọc nổi registry, và toàn bộ mục §3 sụp. Ràng buộc này là CỨNG và chứng minh được trong repo: `check-capability-surfaces.mjs:46-53` bóc literal chứ không import. Plan kiến trúc §7 chỉ ghi ở mức khuyến nghị ("Không nên nhét React component trực tiếp vào JSON") — đừng trích nó như một stop gate. |
| Gộp luôn `permissionPages.ts` vào registry | 742 dòng, feature/action-level, nhiều component phụ thuộc. Gộp cùng đợt biến một lát nhỏ thành refactor xuyên hệ thống — và làm mất luôn phép kiểm không-tự-quy-chiếu duy nhất còn lại trong contract test. |
| Khai tên biến env trong registry | Tạo nguồn đọc thứ hai cho cùng một quyết định (`types.ts:18-24`). |
| Đổi cả hai chiều trong một lát (dựng registry + sinh consumer cùng lúc) | Khi có sai lệch sẽ không biết do registry hay do consumer. Nên tách: `bf03a9b1` dựng nguồn đối chiếu, `a4265f83` đổi chiều phụ thuộc. |
| Giữ nguyên cách kiểm cũ: test regex trên văn bản mã nguồn App.tsx/Sidebar.tsx | Vừa vỡ khi ai đó đổi format, vừa có thể tự khớp vào chính comment nói về route. Hai test `openclawNavigation` kiểu đó đã vỡ ở `a4265f83` vì **hình dạng** biến mất chứ không phải tính chất nào mất; chúng được viết lại theo chỗ còn lệch được (`src/lib/__tests__/openclawNavigation.test.ts:67,81`). |
| Adapter ném lỗi khi id không có trong registry | Chạy lúc module khởi tạo ⇒ trắng màn hình vì một dòng cấu hình sai. Đẩy sang gate CI. |
