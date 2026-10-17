# P11 — Ngừng engine Copilot: callers, phần đã gỡ và phần giữ

Ngày 15/10/2026, viết trên nền `dd2ce3da`; sau rebase lên `209a5423` commit gỡ là `8d4e4520` (PR #171). Thuộc P11.02–P11.04 của
[PLAN.md](PLAN.md); trạng thái chương trình ở [STATUS.md](STATUS.md). Quyết định của chủ dự án
ngày 14/10: Copilot đã ngừng dùng, Hermes là trợ lý chính. Gỡ entrypoint, UI chat/duyệt/PIN,
scheduler và cấu hình riêng của engine sau khi tra callers. Giữ dữ liệu, lịch sử, RPC/ACL/queue/audit,
quota và approval nghiệp vụ CRM dùng chung.

Tài liệu chỉ mô tả source. Không đổi database, không xác nhận production.

Khoảng trống đã biết (review PR #171): `financialModelTransport.test.ts` bị xoá cùng `llmClient`, nên chín ca từ chối của `isFinancialModelEndpoint` (`.e2e-fleet/specs/copilotFinancialReadOracle.ts`, chỉ spec E2E Copilot đang hoãn dùng) không còn test đơn vị. Khi mở lại hoặc gỡ hẳn fleet Copilot thì viết lại các ca đó hoặc xoá oracle. Guard G1 đã bỏ endpoint `localhost:11434/api/tags` của `ollama.ts`.

## 1. Kết luận

- Đã gỡ 24 file nguồn (6.786 dòng) và 30 file test chỉ phục vụ chúng (3.783 dòng). Nhóm này gồm UI chat,
  thẻ duyệt, modal PIN, trang quản trị Copilot, engine hội thoại, model client, chọn provider, cổng
  availability của chat và hook ngữ cảnh trang. Đo trước khi xóa: không file nào nằm trên đồ thị import
  từ `src/main.tsx`, nên bundle sản phẩm không đổi.
- Lớp công cụ/kế hoạch Copilot còn giữ vì là nguồn của `tooling/hermes-crm-inventory.generated.json`
  và các gate P0. Nhóm này không có caller sản phẩm. Chỉ gỡ sau khi P11.01 chốt từng năng lực, cùng lúc
  sửa gate/inventory có review.
- Không tạo migration và không sửa đối tượng DB. Các đối tượng DB chỉ Copilot dùng nằm ở mục 5, mới là đề xuất.

## 2. Cách xác minh caller

1. Dựng đồ thị import tĩnh cho `src/**`, `.e2e-fleet/**`, `scripts/**`. Đồ thị gồm import/export-from,
   `import()`, `vi.mock` và `import.meta.glob`, rồi tính tập tới được từ `src/main.tsx`. Trước khi gỡ,
   trong `src/copilot/**` chỉ `copilotConfig.ts` tới được từ sản phẩm, qua Báo chi nhanh.
2. Tập "core giữ" gồm các nguồn sau:
   - nguồn inventory Hermes: `UI_SOURCE_PATHS`, `ACTION_PATH`, `FLAGS_PATH`, `RPC_HELPER_PATHS`;
   - `SCAN_ROOTS` của gate forbidden-actions;
   - `sourcePaths` của suite `copilot-shared-core` và `hermes-foundation-inventory`;
   - phụ thuộc bắc cầu của các mục trên và file mà `.e2e-fleet` import.

   File không thuộc sản phẩm và không thuộc core giữ là ứng viên gỡ.
3. Tra chuỗi đường dẫn và tên file trong `scripts/`, `tooling/`, `.github/`, `docs/`, `contracts/`,
   `infra/`, `worker/`, `supabase/functions/`. Bước này bắt caller không đi qua import: `readFileSync`,
   manifest, link Markdown và allowlist của gate.
4. Tra tên RPC, bảng và edge slug của file gỡ trong mọi source còn lại (mục 5).

## 3. Đã gỡ

| Mục | Caller trước khi gỡ | Quyết định | Bằng chứng |
| --- | --- | --- | --- |
| `CopilotLauncher.tsx`, `BeChiu.tsx`, `copilot.css` | Không còn caller: App bỏ mount từ `81bb6eb0`; chỉ BeChiu import css | GỠ: entrypoint/launcher | Đồ thị import: không có importer ngoài nhóm gỡ |
| `ChatPanel.tsx`, `chatEngine.ts`, `llmClient.ts`, `anh.ts` | Chỉ gọi lẫn nhau và test | GỠ: UI chat, vòng hội thoại, model client, ảnh đính kèm | Không có importer sản phẩm. Trong app, chỉ `chatEngine` đọc/ghi `ai_chat_threads/messages` (mục 5) |
| `KeHoachCard.tsx`, `XacNhanPhieuCard.tsx` | ChatPanel | GỠ: UI duyệt kế hoạch và xác nhận phiếu trong chat | Core giữ vẫn tham chiếu các RPC phía sau (`copilot_plan_*`, preview/execute) |
| `StepUpPinModal.tsx` | KeHoachCard, HanhDongTab | GỠ: UI PIN | Giữ `stepUpClient.ts` vì allowlist của gate neo vào file này |
| `admin/AiCopilotAdminPage.tsx`, `admin/HanhDongTab.tsx`, `admin/adminPersistence.ts`, `admin/adminWrites.ts`, `admin/hanMucToken.ts`, `admin/hanhDongCopilot.ts` | Không còn caller: route gỡ từ `81bb6eb0` | GỠ: cấu hình riêng của engine (provider, entitlement, hạn mức token, chính sách hành động) | Không có importer. Rủi ro quản trị quota ở mục 6 |
| `useAiProviders.ts`, `providerPolicy.ts`, `providerReadModels.ts`, `ollama.ts` | ChatPanel, CopilotLauncher, admin | GỠ: chọn model/provider của chat | Không có importer sản phẩm |
| `availabilityGate.ts`, `uiControlGate.ts` | ChatPanel | GỠ: cổng gửi và điều khiển của chat | Test `availabilityGate.test.ts` rút khỏi suite `copilot-shared-core` |
| `phaseDWriteMatrix.ts` | Không có, chỉ test của chính nó | GỠ: code chết | Test rút khỏi `copilot-shared-core` |
| `src/hooks/useCopilotPageContext.ts`, kho publish/read trong `activePageContext.ts`, `locDangAp` trong `banDoHeThong.ts` | Không còn consumer sản phẩm (47 consumer gỡ ngày 15/10); 7 test trang chỉ còn `vi.mock` | GỠ. Giữ type `ActivePageContext` và `isContextEntityId` cho tool `ban_do_he_thong` | 7 test trang bỏ mock và vẫn đạt |
| 8 nhãn query key trong `src/lib/queryFeedback.ts` (`ai-providers*`, `ai-copilot-*`, `ai-usage-*`) | Chỉ màn đã gỡ | GỠ | Module tải lazy, không thuộc chunk entry |
| 30 test chỉ phục vụ các file trên (gồm `renderHarness.tsx`, 6 test admin, 3 test page-context) | — | GỠ cùng module | Bỏ 21 mục khỏi `tooling/deferred-modules.json` và 2 mục khỏi `test-matrix` |
| Test hỗn hợp: `actionRollout`, `writeToolsHanhDong`, `copilot.test`, `temporalContext` | — | Chỉ bỏ ca dùng module đã gỡ, giữ ca của core | Mục 7 |

Cập nhật kèm theo:

- Bỏ đường dẫn đã xóa khỏi `tsconfig.strict-islands*.json` và hai baseline đảo strict, vì gate đòi
  việc xóa phải có chủ ý.
- Năm test gate từng dùng `llmClient.test.ts`/`ChatPanel.test.tsx` làm ví dụ đường hoãn. Nay chúng dùng
  `systemPromptVi.test.ts`/`pageScope.test.ts`, hai file vẫn hoãn.
- Test G1 guard thôi đọc `ollama.ts` và ghi thẳng endpoint `http://localhost:11434/api/tags`.
- Hai link Markdown trỏ tới file đã gỡ được đổi thành chữ thường.
- `contracts/surfaces/rpc-surface.json` sinh lại từ catalog live, chỉ đọc. Kết quả bỏ đúng ba RPC mục 5A
  khỏi bề mặt được gọi (375 → 372); `docs/generated/*` cũng sinh lại.

## 4. Giữ lại và lý do

| Mục | Caller hiện tại | Lý do giữ |
| --- | --- | --- |
| `src/copilot/copilotConfig.ts` | `src/hooks/quick-entry/useQuickEntryFeed.ts`, `quickEntryAi.ts`; alias trong `.e2e-fleet/specs/personal-finance-product.spec.ts`; `createAgent.ts` | Báo chi nhanh là tính năng sản phẩm |
| `tools/**`, `plan/**`, `docs/**`, `featureFlags`, `memoryClient`, `confirmationStore`, `createAgent`, `pageScope`, `safeControls`, `safetyGuard`, `uiControlAvailability`, `pageAgentCompatibility`, `useHangDoiSauDuyet` | `scripts/generate-hermes-crm-inventory.mjs` (32 nguồn có sha256); `check-copilot-tool-inventory`; `check-copilot-forbidden-actions` (`SCAN_ROOTS`, `rpcAllowlist` neo vào `planClient`/`stepUpClient`/`standingGrantClient`); `check-copilot-docs-manifest`; `generate-copilot-guide-corpus`; suite `copilot-shared-core` | Nguồn inventory P11.01 và gate P0 đang chạy; không có caller sản phẩm. `useHangDoiSauDuyet` là hàng đợi phía trình duyệt của engine cũ, nay chỉ còn giá trị kiểm kê |
| `banDoHeThong`, `activePageContext` (chỉ còn type), `temporalContext`, `systemPromptVi`, `pageContext`, `chatErrors`, `anToanVanBan`, `maskPii`, `hrefAnToan` | Core giữ import; `.e2e-fleet/specs` cũng import `maskPii`/`hrefAnToan` | Phụ thuộc bắc cầu. Đổi spec fleet làm gate-aggregate chặn promote |
| Edge `llm-proxy` | `infra/hermes-broker/model-relay.mjs` (`x-copilot-feature: chat`), `createAgent`; suite `edge-deno-llm-proxy` | Relay model và quota dùng chung (`reserve_ai_usage`) |
| Edge `quick-entry` | Báo chi nhanh | Tính năng sản phẩm; chế độ `pilot` đọc `ai_copilot_entitlements` |
| `OrganizationProvider`, `src/lib/myOrganizations.ts` | Toàn app | RPC `list_my_copilot_organizations_v1` là danh bạ công ty dùng chung |
| `AiSubmittedBadge.tsx` | Hộp chờ duyệt | Lịch sử và approval nghiệp vụ (`system_source = 'AI_COPILOT'`) |
| Quyền `ai_copilot` trong `permissions.ts`, `permissionPages.ts`, `errorPageNames.ts` | Catalog quyền; `llm-proxy` kiểm `ai_copilot.view` | Đổi catalog quyền là quyết định về quyền, ngoài gói này |
| Page contract Copilot trong `src/app/capabilities/{registry,types}.ts` | Inventory Hermes (`capabilities`, `uiControl`); gate capability/route | Metadata dùng chung với routing |
| `src/lib/__tests__/copilot*Migration.test.ts` | Suite app-unit | Kiểm các migration đã áp, vốn bất biến |
| `.e2e-fleet/specs/copilot-*`, `.e2e-fleet/controlled/*`, `scripts/copilot-*` (golden, G1, G3, room-pass), `.github/workflows/copilot-e2e.yml` | Spec fleet import script; workflow đã đặt `if: false` | Đang hoãn. Spec chat đã chết từ khi gỡ launcher. Gỡ cần PR riêng ghi `known-gaps`, vì đổi spec fleet chặn promote |
| `docs/ai-copilot/**`, `docs/he-thong/21-ai-copilot.md`, `tooling/copilot-*.json` | Corpus/gate P0 và gate đang hoãn | Hồ sơ và dữ liệu của gate |
| Dependency `page-agent` | `createAgent.ts`, `safetyGuard.ts` | Đi theo core giữ; gỡ cùng lượt dọn core (cần `npm install`, chưa làm) |
| Worker, pg_cron | `worker/` không tham chiếu Copilot; migration không có `cron.schedule` nào của Copilot | Không có scheduler riêng để gỡ |

## 5. Đối tượng DB chỉ Copilot dùng: đề xuất, CHƯA làm

Gói này không có migration DROP hay REVOKE. Mọi đề xuất dưới đây cần forward lane, backup và review.

**A. Không còn caller trong app sau gói này**

| Đối tượng | Caller cũ | Đề xuất |
| --- | --- | --- |
| `public.get_copilot_action_policy_v1`, `public.set_copilot_action_policy_v1` | `admin/hanhDongCopilot.ts` | Xác nhận không runbook nào dùng, rồi thu hồi EXECUTE của `authenticated`. Giữ bảng `app_private.copilot_action_policy` và `_audit`, vì `app_private.copilot_plan_role_allowed_v1` còn đọc |
| `public.copilot_action_ledger_list_v1` | `admin/hanhDongCopilot.ts` | Giữ dữ liệu audit. Nếu Hermes không cần màn audit này thì thu hồi EXECUTE |
| `public.ai_chat_threads`, `public.ai_chat_messages` | `chatEngine.ts` (trong app); SQL clone-org/ranh giới org vẫn nhắc tới | Giữ dữ liệu lịch sử. Đề xuất chặn ghi mới (thu hồi INSERT/UPDATE) và đặt chính sách lưu trữ; không DROP |

**B. Chỉ lớp core Copilot giữ cho inventory còn tham chiếu.** Không có caller ở Hermes, worker, edge
hoặc trang CRM khác. Kết quả đo bằng tên trong source, không đọc catalog live. Có 131 RPC `copilot_*`:
nhóm directory/search/report (đọc), cặp `copilot_preview_*`/`copilot_execute_*`, `copilot_plan_*`,
`copilot_step_up_*`, `copilot_standing_grant*` và `copilot_memory_*`. Danh sách đầy đủ nằm trong
`rpcReferences` của inventory Hermes. P11.01 chọn cho từng RPC: chuyển sang gateway Hermes, giữ làm
executor backend, hoặc thu hồi.

**Dùng chung, giữ nguyên:**

- `copilot_available_rooms_v1`, `copilot_org_scope_buildings_v1`: Hermes KHÔNG còn dùng lúc chạy (17/10/2026).
  Phòng đọc qua `hermes_sale_listing_rooms_v1` (trang Sale, 20261016080232); phạm vi toà qua
  `hermes_scope_buildings_v1` gọi thẳng `authorized_scope_v3` (20261017023242, connector đổi RPC cùng đợt).
  Connector bản cũ vẫn gọi `copilot_org_scope_buildings_v1` tới khi deploy bản mới, nên hàm này phải còn
  trên production cho tới lúc đó. Gate `infra/hermes-broker/copilot-independence.test.mjs` chặn tham chiếu mới.
- `copilot_plan_submit_voucher_v1`: approval nghiệp vụ.
- `list_my_copilot_organizations_v1`: danh bạ công ty.
- `reserve_ai_usage`, `ai_copilot_settings`, `ai_copilot_entitlements`, `ai_providers`, `ai_usage_logs`:
  `llm-proxy` và `quick-entry` dùng.

## 6. Rủi ro và việc tiếp theo

- **Quota và provider không còn UI quản trị.** Trang quản trị Copilot rời route từ `81bb6eb0`; nay
  source cũng đã gỡ. Bốn mục `ai_copilot_settings`, `ai_copilot_entitlements`, `ai_providers` và trần
  token vẫn điều khiển `llm-proxy` (relay Hermes) và `quick-entry` ở chế độ `pilot`. Muốn chỉnh thì
  dựng màn quản trị trong Hermes, hoặc dùng runbook SQL qua lane. Mã cũ đọc lại bằng `git show dd2ce3da:<path>`.
- **Dọn core sau khi P11.01 chốt.** Gỡ `tools/**`, `plan/**`, `createAgent`, `safetyGuard`… phải sửa
  đồng thời `generate-hermes-crm-inventory.mjs`, các `check-copilot-*`, `copilot-action-policy.json`,
  test-matrix, deferred-modules và dependency `page-agent`. Cần draft PR theo Contract §3.
- **Spec fleet và workflow Copilot** cần PR riêng có ghi `known-gaps`, không trộn vào PR cần phát hành.
- `eslint-baseline.json` còn 5 fingerprint của file đã xóa. Gate vẫn đạt vì baseline chỉ được teo; chốt
  bằng `--write` cùng lượt dọn baseline khác (máy này báo 172 mục đã dọn được, phần lớn không thuộc gói này).
- Biến CSS `--copilot-fab-inset` trong CSS trang mobile luôn rơi về giá trị mặc định 84px, vì
  `copilot.css` không còn được nạp từ `81bb6eb0`. Hành vi không đổi; đổi tên hoặc dọn khi sửa CSS mobile.

## 7. Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| Vitest focused: `actionRollout`, `copilot`, `writeToolsHanhDong`, `banDoHeThong`, `availabilityAdapters`, `chatErrors`, 7 test trang, quick-entry, `OrganizationContext` | 20 file, 290 test đạt |
| Vitest 5 test gate (`deferred-foundation-routing`, `gate-plan`, `gate-registry`, `kiem-nhanh-truoc-push`, `run-related-vitest`) | 186/186 |
| Vitest `src/app/providers` (nhãn query) | 5 file, 45 test |
| `node --test scripts/__tests__/copilot-g1-guard.test.mjs` | 17/17 |
| `npm run gate:truoc-push` (staged diff của commit gỡ) | 45/47 gate local đạt, kể cả `generate-hermes-crm-inventory`, `check-copilot-*`, `check-strict-islands`, `check-ts-baseline`, `check-test-matrix`, `check-eslint-baseline`. Hai mục đỏ được xử lý như hai dòng dưới |
| `check-docs` | Đỏ do link tới tài liệu này khi file chưa có. Tách ghi chú sang commit tài liệu; chạy lại trên trạng thái commit gỡ: 0 lỗi |
| `suite:node-native` | 2 fail ở `infra/hermes-*`, không file nào bị gói này sửa. `connection-handoff`: mock `fs/promises` thiếu `link` trên Windows, lặp lại khi chạy riêng. `agent-process`: đạt khi chạy riêng |
| `tsc -p .e2e-fleet/tsconfig.json` | 9 lỗi có sẵn ở `personal-finance-product.spec.ts` và `bank-events`, không lỗi nào liên quan Copilot |
| Chưa kiểm | `app-build`/`bundle-inventory`, gate live, browser (không đổi màn sản phẩm); CI chịu trách nhiệm |
