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

## Kiểm thử

Chọn runner từ [test-matrix](../tooling/test-matrix.json), runtime từ [runtime-matrix](../tooling/runtime-matrix.json), risk/review từ [risk-map](../tooling/risk-map.json). Không suy mọi test trong `supabase/functions/` là Deno.
Package con cần `npm ci --prefix <package>` trước test; giữ `deno.lock` của mỗi function. Không lấy nhầm dependency root.

- Trong lúc sửa: focused test của hành vi/invariant vừa đổi. Trước push: staged diff → `npm run gate:truoc-push -- --plan` → gate theo scope, giữ receipt của đầu vào không đổi.
- UI: kiểm luồng/vai trò và viewport bị ảnh hưởng, xem ảnh/console errors. Không bắt cả desktop/mobile hoặc toàn app nếu phạm vi không đòi hỏi.
- E2E: vào `.e2e-fleet/`, `npx playwright test specs/<file>.spec.ts`, mặc định headless; mật khẩu qua `FLEET_PASS_*`. Chỉ bật `FLEET_HEADED=1` khi user muốn thấy browser.
- Fixture chỉ ghi DEMO hoặc môi trường TEST, tự dọn. Vai tài khoản thật chỉ thử ở TEST theo [data runbook](engineering/DATA_ENVIRONMENTS.md). Thiếu browser/credential thì ghi chưa kiểm.
- Tiền/quyền/org/migration và gate có thể xanh rỗng: dùng `scripts/dot-bien.mjs`, xác nhận hash đổi, suite đỏ đúng lý do, khôi phục trong `finally` và kiểm hash; ghi neo/digest/kết quả. Exit 0 đạt, 1 bỏ lọt, 3 không kiểm được.
- Gate quét code phải bỏ comment bằng `scripts/lib/bo-chu-thich.mjs`; regression chứng minh comment không làm gate đạt giả. Shebang giữ LF theo `.gitattributes`.
- CI build/bundle một lần cho candidate; build local chỉ khi chẩn đoán/cần evidence bổ sung. Skip/DEFERRED/thiếu runner là chưa kiểm, không phải pass.

## Tài liệu là đầu vào sản phẩm

`docs/he-thong/*.md` có thể được bundle và lọc bằng manifest; `docs/huong-dan-su-dung/` xuất bản qua VitePress và một phần được bundle bằng allowlist literal.
Không di chuyển/xoá các thư mục này để giảm context agent. Generated views ở `docs/generated/` sửa qua generator; số đo lấy từ manifest/evidence thay vì đếm tay ở đây.
Zalo/Copilot vẫn deferred theo Contract; giữ mã/tài liệu runtime, không tự đọc hồ sơ hoặc bật kiểm riêng.
