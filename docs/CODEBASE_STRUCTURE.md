# Bản đồ code và kiểm chứng theo phạm vi

Tài liệu tra cứu khi chưa rõ vị trí source hoặc cách kiểm; không cần đọc cho mọi task. Luật chung ở [Project Contract](engineering/PROJECT_CONTRACT.md).

## Tìm nơi cần sửa

| Khu vực | Nguồn |
|---|---|
| Bootstrap/composition | `src/main.tsx`, `src/App.tsx` |
| Route, capability | `src/app/routes/`, `src/app/capabilities/` |
| Trang/component nghiệp vụ | `src/pages/`, `src/components/` |
| Menu/launcher | `src/components/layout/`, `src/pages/home/launcherTiles.ts` |
| Query/mutation/domain adapter | `src/hooks/`, `src/lib/` |
| Permission catalog | `src/lib/permissionPages.ts`, `src/lib/permissions.ts` |
| Supabase types/client | `src/integrations/supabase/` |
| RPC/Edge/realtime | `contracts/surfaces/`, `supabase/functions/`, `src/app/realtime/` |
| Database hiện hành | Catalog/evidence và migration mới nhất liên quan; [migration runbook](engineering/MIGRATION_STRATEGY.md) |
| Package ngoài app | `infra/`, `.e2e-fleet/`, `api/`, `extensions/`; runtime/dependency riêng theo manifest |

Luồng chính: route/page → hook/domain adapter → query/RPC → RLS/quyền/canonical writer → database/audit.
Client chỉ phản chiếu quyền; quyết định cuối ở backend. Không gọi RPC trực tiếp trong component; high-risk dùng wrapper typed và validate boundary, không thêm cast `any`.

## Quy ước cần khi chạm source

- UI shadcn/Lucide, Tailwind; form React Hook Form + Zod. CSS riêng cô lập, file/media theo storage hiện có.
- Phân biệt permission, validation, concurrency, conflict, internal; Sonner/error boundary không che lỗi bằng dữ liệu rỗng hoặc lộ chi tiết nội bộ.
- Lazy route/component nặng; đo bundle khi đổi tải trang. `src/App.tsx` là composition, không phải nguồn khai route.
- `typecheck:baseline` kiểm `tsconfig.app.json` theo fingerprint `ts-baseline.json`; không tăng baseline/flip strict toàn repo để né lỗi.
- `src/app/providers/AuthCacheSync.tsx`: callback auth chỉ đồng bộ; không `await supabase.*` vì có thể deadlock; effect đăng ký/huỷ listener.
- GitNexus chỉ hỗ trợ callers/callees khi source chưa đủ rõ; wrapper tự kiểm index, không cần freshness gate. Sau đổi code, graph là bản chụp cũ.

## Công thức dùng chung

Công thức/bộ lọc có từ hai nơi trở lên cùng dùng (web, Hermes, báo cáo, worker) hoặc dính tiền/quyền đặt trong hàm SQL dùng chung mà mọi nơi cùng gọi; frontend chỉ giữ hiển thị (định dạng, sắp xếp cột, ẩn/hiện) và truy vấn chỉ trang đó dùng. Chỗ còn chép công thức sang Hermes phải có marker `hermes-parity` (chủ chốt 17/10/2026).

- Chuyển từng màn một: đưa công thức của một màn vào hàm SQL chung, đổi màn đó gọi hàm, xong mới sang màn kế.
- Khớp số trước/sau: cùng org/kỳ/bộ lọc (TEST/DEMO hoặc chỉ đọc), so kết quả cũ với hàm mới; lệch thì dừng và giải trình từng chênh.
- `EXPLAIN` hàm mới trên dữ liệu cỡ thật: quyền/RLS tính theo tập (initplan), không gọi từng dòng; không chậm hơn bản cũ.
- `p_building_ids` và tham số lọc tương tự chỉ thu hẹp (∩) phạm vi quyền server tự tính, không bao giờ mở rộng hay thay quyền.
- Quyền (chốt 18/10/2026): hàm chung là `SECURITY INVOKER` đọc bằng RLS người gọi, `search_path=''`, tự chặn khi `current_user` khác `authenticated` hoặc `auth.uid()` rỗng; không chép policy vào thân hàm.
- `SECURITY DEFINER` chỉ cho helper nhỏ trong `app_private` trả tập id và tự kiểm phạm vi `auth.uid()`; không bao giờ trả cả danh sách.
- Ngoại lệ vị trí: helper DEFINER mà hàm INVOKER gọi trực tiếp phải ở `public` (EXECUTE chỉ `authenticated`): `authenticated` không có USAGE trên `app_private` (đo production 18/10/2026), như helper của màn Hoá đơn.
- Ngoại lệ "DEFINER trả tổng" (vd. `invoice_statistics_money_v1`) chỉ khi đủ ba điều kiện: tự giao phạm vi của chính người gọi, không tin id bên gọi truyền; trả đúng một dòng tổng, không trả danh sách; có test bất biến (gọi thẳng với id toà xoá mềm/công ty khác ra 0, phạm vi ⊆ `accessible_building_ids()`) và đột biến làm suite đỏ.
- Hermes gọi qua đường INVOKER bằng JWT người dùng (không gọi từ thân hàm DEFINER), thu hẹp bằng `p_building_ids`: NULL = toàn phạm vi RLS, `'{}'` = rỗng.
- Ngoại lệ đã duyệt của Hermes đợt 2 (Gói Z 18/10/2026; chi tiết ở đầu [wave2-kit.mjs](../infra/hermes-broker/wave2-kit.mjs)):
  - Helper `SECURITY DEFINER` ở `public` (EXECUTE chỉ `authenticated`, `search_path` cố định) trả **một boolean** về chính người gọi hoặc về một hạng mục trong công ty người gọi, không trả danh sách: `salary_is_admin_v1(p_organization_id)` (người gọi có là admin trang lương: super admin hoặc `salary.lock`/`manage_salary`/`distribute` toàn công ty; không uid/không thuộc công ty ⇒ false) và `finance_type_restricted_v1(p_type_id, p_merged)` (hạng mục có hạn chế không; chỉ trả cho hạng mục thuộc công ty người gọi, khác ⇒ NULL — bản INVOKER bị RLS hạn chế giấu chính hạng mục nên đọc sai thành "không hạn chế"). `finance_my_scope_v1` (DEFINER) trả phạm vi của chính người gọi cho một khoá cố định — thuộc luật "trả tập id của chính người gọi".
  - Hàng tổng hợp toàn công ty `buildingId = null` (`cashbook_daily`, `cash_flow`, `fa_type_breakdown`) chỉ khi kết nối phạm vi Toàn tổ chức (cổng 20261018000700 chỉ nhận null khi `orgWide`); `organizationId` = công ty hàm đã lọc tường minh.
  - Hàng dùng chung (`organization_id` NULL, vd. hạng mục thu chi dùng chung) không trả qua Hermes — rào công ty đòi mọi hàng đúng công ty kết nối — và được đếm ở `summary.globalRowsOmitted`; khi trùng tên, hàng của công ty thắng hàng dùng chung.
  - `network_fleet` toàn công ty bị cổng từ chối khi quá 256 toà (`22023 hermes_domain_scope_too_large`, trần toà của cổng/broker).
  - Chữ tự do gắn hợp đồng (ghi chú hoá đơn/phiếu/thanh lý, người nộp) chỉ trả khi MỌI khách của hợp đồng nhìn thấy dưới RLS `customers`; viết trong câu (đếm dòng khách = đếm dòng nối được hồ sơ), không tách hàm plpgsql gọi theo từng dòng vì mỗi lời gọi tính lại InitPlan RLS.
- Mỗi bảng chỉ tham chiếu một lần trong câu: mỗi lần là thêm một lượt policy/InitPlan (`accessible_*_ids` ≈ 35 ms/lượt trên TEST).
- Hermes còn chép: bọc mã web bằng `hermes-parity:begin/end`, thêm mục vào [web-parity.json](../infra/hermes-broker/web-parity.json); chuyển sang gọi hàm chung thì đổi mục thành `rpc`. Gate: `npm run gate:hermes-web-parity`.

## Kiểm thử

Chọn runner từ [test-matrix](../tooling/test-matrix.json), runtime từ [runtime-matrix](../tooling/runtime-matrix.json), risk/review từ [risk-map](../tooling/risk-map.json). Không suy mọi test trong `supabase/functions/` là Deno.
Package con cần `npm ci --prefix <package>` trước test; giữ `deno.lock` của mỗi function. Không lấy nhầm dependency root.

- Trong lúc sửa: focused test của hành vi/invariant vừa đổi. Trước push: staged diff → `npm run gate:truoc-push -- --plan` → gate theo scope, giữ receipt của đầu vào không đổi.
- UI: kiểm luồng/vai trò và viewport bị ảnh hưởng, xem ảnh/console errors. Không bắt cả desktop/mobile hoặc toàn app nếu phạm vi không đòi hỏi.
- E2E: vào `.e2e-fleet/`, `npx playwright test specs/<file>.spec.ts`, mặc định headless; mật khẩu qua `FLEET_PASS_*`. Chỉ bật `FLEET_HEADED=1` khi user muốn thấy browser.
- Đổi spec `.e2e-fleet/specs/**/*.spec.ts` của suite `e2e-fleet` sinh nghĩa vụ bằng chứng live; CI không chạy được nên gate/promote chặn tới khi có **biên nhận E2E local**. Biên nhận chỉ do runner sinh, cấm viết tay. Khi TOÀN BỘ cây làm việc sạch (không sửa/staged/untracked): `FLEET_BASE_URL=<web test-env hoặc dev server loopback trỏ TEST> FLEET_TARGET_ENV=TEST npm run with-cred -- npm run e2e:fleet:bien-nhan` (xem trước danh sách spec: `npm run e2e:fleet:bien-nhan -- --plan`; mặc định dải `origin/production..HEAD`). Trước khi chạy, runner đọc ref Supabase từ HTML/JS của đích và dừng nếu không đúng project TEST (preview cần `VERCEL_AUTOMATION_BYPASS_SECRET`). Runner ghi `docs/generated/e2e-fleet-evidence/<ngày>-<sha>-<run>.json` cả khi xanh lẫn ĐỎ (biên nhận đỏ cùng tree làm gate chặn; xoá nó để chạy lại là che lượt đỏ); report Playwright giữ ngoài repo ở `FLEET_REPORT_DIR` (mặc định `~/ihomecrm-backups/e2e-fleet-reports/`), biên nhận chỉ mang sha256. Stage đúng file biên nhận và commit riêng. Biên nhận gắn commit đủ 40 ký tự + tree `.e2e-fleet/`: đổi bất kỳ file fleet nào sau đó, rebase hay squash-merge (commit chạy không còn là tổ tiên) đều làm biên nhận vô hiệu, phải chạy lại. Biên nhận ghi `targetBuildSha` nếu đích khai, nhưng không chứng minh bản app dựng từ đúng commit; số đếm do máy chạy tự khai (có `actor`) — review PR vẫn phải xem log chạy.
- Fixture chỉ ghi DEMO hoặc môi trường TEST, tự dọn. Vai tài khoản thật chỉ thử ở TEST theo [data runbook](engineering/DATA_ENVIRONMENTS.md). Thiếu browser/credential thì ghi chưa kiểm.
- Tiền/quyền/org/migration và gate có thể xanh rỗng: dùng `scripts/dot-bien.mjs`, xác nhận hash đổi, suite đỏ đúng lý do, khôi phục trong `finally` và kiểm hash; ghi neo/digest/kết quả. Exit 0 đạt, 1 bỏ lọt, 3 không kiểm được.
- Gate quét code phải bỏ comment bằng `scripts/lib/bo-chu-thich.mjs`; regression chứng minh comment không làm gate đạt giả. Shebang giữ LF theo `.gitattributes`.
- CI build/bundle một lần cho candidate; build local chỉ khi chẩn đoán/cần evidence bổ sung. Skip/DEFERRED/thiếu runner là chưa kiểm, không phải pass.

## Tài liệu là đầu vào sản phẩm

`docs/he-thong/*.md` có thể được bundle và lọc bằng manifest; `docs/huong-dan-su-dung/` xuất bản qua VitePress và một phần được bundle bằng allowlist literal.
Không di chuyển/xoá các thư mục này để giảm context agent. Generated views ở `docs/generated/` sửa qua generator; số đo lấy từ manifest/evidence thay vì đếm tay ở đây.
Zalo/Copilot vẫn deferred theo Contract; giữ mã/tài liệu runtime, không tự đọc hồ sơ hoặc bật kiểm riêng.
