# AI Copilot Superadmin Control — Plan LEAN (đã đối chiếu thực tế 2026-08-14)

> **For agentic workers:** REQUIRED SUB-SKILL: dùng superpowers:subagent-driven-development (khuyến nghị)
> hoặc superpowers:executing-plans để thực hiện từng task. Các bước dùng checkbox (`- [ ]`) để theo dõi.

**Bản này thay thế bản 18-task ngày 2026-08-13** (giữ nguyên trong git history tại commit
`47b93154`). Lý do thay: (1) đối chiếu code + database ngày 2026-08-14 tìm ra 13 điểm lệch thực tế
(phụ lục A); (2) product owner chốt mức cân bằng **LEAN** — giữ nguyên các rào chắn có bằng chứng lỗi
thật, cắt/hoãn phần governance nặng không làm AI mạnh hơn nhưng làm triển khai chậm đi nhiều lần.

**Goal:** AI Copilot đọc / điều hướng / điền draft trên toàn site theo đúng quyền và đúng công ty đã
chọn; mọi thao tác GHI đều đi qua preview + cú click thật của người dùng (nonce server), audit không
sửa được; superadmin có directory tổ chức nhưng không có scope ngầm định toàn hệ.

**Không phải goal (Deferred — phụ lục B):** execution-plan engine đa bước, immutable contract
manifest + digest, attestation đầy đủ cho llm-proxy, egress grant token, action ledger riêng,
batch-consent / step-up approve (đường nâng cấp Op3 khi cần).

**Tech stack:** React 18, TypeScript 5.8, Vite, Vitest, page-agent 1.11.0, Supabase
(Postgres/RLS/RPC), Edge Function `llm-proxy`, Playwright fleet, Node gates.

**Spec:** `docs/superpowers/specs/2026-08-13-ai-copilot-superadmin-control-design.md` (hồ sơ audit +
findings B1–B7/F1–F7; xem Addendum 2026-08-14 trong spec về quyết định LEAN).

**Oracle chất lượng:** `docs/ai-copilot/COPILOT-EVALUATION-2026-08-13.md` — 40 case live, nhóm
C01–C30 hiện 15 PASS / 7 PARTIAL / 8 FAIL. Plan này phải đóng được các FAIL/PARTIAL nhóm query,
routing, relative-date, orchestration.

---

## Quyết định nền (đã chốt với product owner 2026-08-14)

1. **LEAN (Op1):** AI soạn — người bấm. Không xây workflow engine, không manifest digest, không
   attestation full. Knowledge gate là CẢNH BÁO, không chặn (vì `19-sop-tien-va-so-quy.md` hiện nằm
   trong `unreviewedDebt` — chặn là chết action tài chính từ ngày đầu).
2. **Plan này SỞ HỮU hai interface nền** thay vì phụ thuộc plan security-remediation (chưa implement
   0%, file untracked):
   - Selected organization (thay Task 9 phần Copilot của plan đó);
   - Confirmation nonce (thay Task 16 của plan đó — chốt MỘT migration duy nhất
     `20260814034500`, bỏ `20260814031500` của plan kia).
   Khi plan security-remediation được thực hiện, nó THAM CHIẾU các interface đã land ở đây, không
   tạo bản song song.
3. **Thứ tự:** Phase A/B sửa lỗi đang tồn tại trên production trước; Phase C/D xây năng lực mới sau.
   Không mở phase sau khi phase trước chưa xanh.

## Ràng buộc toàn cục

- Project Contract + `AGENTS.md` là authority cho git, migration, production, E2E, verification.
- **Mọi migration mới phải đăng ký đủ sổ**: `supabase/migration-provenance.json` (chạy
  `npm run provenance:generate`), và khi state là `unknown` thì thêm hồ sơ vào
  `supabase/migration-unknown-review.json`; nếu replay drill dừng có chủ đích thì khai
  `supabase/baseline/forward-lane-expectations.json`. Bắt buộc qua `gate:migration-provenance`,
  `gate:migration-idempotent`, `gate:definer-acl`, `gate:ledger-frozen`.
- Sau mỗi migration apply: regen `src/integrations/supabase/types.ts`
  (`node scripts/gen-supabase-types.mjs` — KHÔNG dùng redirect `>`) và
  `contracts/surfaces/rpc-surface.json`; qua `gate:rpc-surface`, `gate:rpc-arg-names`.
- E2E chạy headless, chỉ ghi org DEMO, password qua `FLEET_PASS_*`. Spec nào GHI dữ liệu bắt buộc
  set `FLEET_BASE_URL` (default production `https://ptcrm.vercel.app` bị cấm cho spec ghi).
- PageAgent không cầm write tool; mọi side effect đi qua RPC preview/execute có nonce.
- Superadmin không bỏ qua chọn tổ chức, permission cuối, hay maker-checker.
- Copilot sản phẩm không bao giờ chạy migration, secret, terminal, deployment (L6 — cấm cứng).

## Interface bắt buộc (lean)

```ts
// src/copilot/tools/registry.ts — mở rộng (hiện KHÔNG có organizationId)
export interface ToolCtx {
  perms: PermissionsMap | undefined;
  organizationId: string | null;      // MỚI — Phase A4
  navigate?: (to: string) => void;
}

// src/contexts/OrganizationContext.tsx — MỚI (hiện chỉ có organization = organizations[0])
selectedOrganizationId: string | null;
selectOrganization(id: string): void;
// resolveSelectedOrganizationId(orgs, persistedId):
//   1 org  -> auto chọn; nhiều org + persisted hợp lệ -> persisted;
//   nhiều org + không có lựa chọn hợp lệ -> null (fail closed);
//   org suspended/unknown -> null.
```

```text
-- Phase A4 (migration 20260814032500)
public.list_my_copilot_organizations_v1() RETURNS jsonb
  -- actor từ JWT; user thường: memberships ACTIVE; is_super_admin(): toàn bộ org ACTIVE.
  -- SECURITY DEFINER, REVOKE PUBLIC/anon, GRANT authenticated.

-- Phase B1 (migration 20260814034500)
public.copilot_preview_income_expense_v1(p_organization_id uuid, p_payload jsonb) RETURNS jsonb
public.copilot_execute_income_expense_v1(p_confirmation_nonce text, p_payload jsonb) RETURNS jsonb
  -- nonce raw 32 byte trả đúng một lần, TTL 5 phút, digest lưu app_private, CAS consumed_at.

-- Phase C3 (migration 20260814035500)
public.get_my_copilot_availability_v1(p_organization_id uuid) RETURNS jsonb
  -- trả set page/action ID đang enabled cho actor+org từ bảng copilot_feature_flags.
```

---

## Phase A — Sửa cái đang hỏng trên production

### Task A1: Sửa 4 query sai relation (đóng FAIL C02/C04/C14/C16, gốc của PARTIAL C27)

Hai tool này nằm ở `src/copilot/tools/registry.ts` (KHÔNG phải `nghiepVuTools.ts`):
`tim_khach_hang` (dòng ~240) đang embed thẳng `rooms`/`buildings` từ `customers`;
`hop_dong_sap_het_han` (dòng ~303) embed thẳng `customers` từ `contracts`. Schema không có các
direct relation đó → PostgREST lỗi schema-cache trên deployment thật (5 case live FAIL).

**Files:**
- Modify: `src/copilot/tools/registry.ts`
- Modify: `src/copilot/__tests__/copilot.test.ts`
- Create: `src/copilot/__tests__/readonlyQueryContracts.test.ts`
- Create: `scripts/test-copilot-readonly-queries.mjs` (harness production-like, pattern
  `scripts/test-cross-tenant.mjs` với `--local-cluster`; hạ tầng
  `scripts/network-center-disposable-db.mjs`)

**Steps:**

- [ ] **A1.1** Viết test contract fail trước: từ chối 4 direct relation
  (`customers->rooms`, `customers->buildings`, `contracts->buildings`, `contracts->customers`);
  pin đường FK-qualified thay thế (cả 3 FK đã xác minh tồn tại đúng tên trong
  `src/integrations/supabase/types.ts`):
  - Khách hàng: select base `customers` rồi enrich qua
    `contract_customers!contract_customers_customer_id_fkey ->
    contracts!contract_customers_contract_id_fkey -> rooms!contracts_room_id_fkey ->
    buildings!rooms_building_id_fkey`.
  - Hợp đồng sắp hết hạn: embed `rooms!contracts_room_id_fkey -> buildings!rooms_building_id_fkey`
    và `contract_customers!contract_customers_contract_id_fkey ->
    customers!contract_customers_customer_id_fkey` (chọn đại diện `is_representative`, fallback
    phần tử đầu).
  Test cả positive row và empty-state hợp lệ; KHÔNG catch lỗi PostgREST để trả list rỗng.
- [ ] **A1.2** Chạy xác nhận đỏ: `npx vitest run src/copilot/__tests__/readonlyQueryContracts.test.ts`
- [ ] **A1.3** Sửa hai query theo đường FK-qualified đã pin. Chạy lại vitest + harness:
  `node scripts/test-copilot-readonly-queries.mjs --local-cluster` — positive/empty/zero
  schema-cache error.

### Task A2: Đồng bộ route mo_trang vs PageAgent allowlist (đóng F1)

Hiện `MO_TRANG_ROUTES` = 5 route (`/apartments /invoices /customers /contracts /buildings`,
`registry.ts:67-73`) nhưng `PILOT_ROUTE_ALLOWLIST` = 3 (`safetyGuard.ts:62`) → AI mở `/contracts`,
`/buildings` xong route guard throw ngay bước sau.

**Files:**
- Modify: `src/copilot/safetyGuard.ts`
- Modify: `scripts/check-copilot-routes.mjs`
- Create: `scripts/__tests__/check-copilot-routes.test.mjs`
- Modify: `src/copilot/__tests__/copilot.test.ts`

**Steps:**

- [ ] **A2.1** Test gate: export `routesNgoaiAllowlist(whitelist, allowlist)` từ
  `check-copilot-routes.mjs`; case đo thật (5 vs 3) phải trả `['/contracts','/buildings']`.
- [ ] **A2.2** Thêm safety test cho 2 trang mới (blacklist DOM bắt được nút nguy hiểm trên
  contracts/buildings) rồi mở rộng `PILOT_ROUTE_ALLOWLIST` lên đủ 5. Nếu safety test lộ vấn đề
  không sửa nhanh được thì rút `MO_TRANG_ROUTES` còn 3 — hai danh sách KHÔNG được lệch nhau.
- [ ] **A2.3** Gate exit 1 khi lệch: `node --test scripts/__tests__/check-copilot-routes.test.mjs`
  và `npm run gate:copilot-routes` xanh.

### Task A3: Containment write + sửa doc drift (đóng một phần B3, DoD-7 của evaluation)

**Files:**
- Modify: `src/copilot/tools/registry.ts` (`buildRegistry` hiện KHÔNG có tham số — thêm options)
- Modify: `src/copilot/tools/writeTools.ts`
- Modify: `docs/ai-copilot/README.md`
- Modify: `scripts/check-copilot-docs-manifest.mjs` (hoặc gate mới nhỏ nếu tách hợp lý hơn)
- Modify: `src/copilot/__tests__/copilot.test.ts`

**Steps:**

- [ ] **A3.1** Thêm `buildRegistry(options?: { serverConfirmedActions?: ReadonlySet<string> })`:
  `tao_phieu_thu_chi_nhap` chỉ được expose cho model khi
  `serverConfirmedActions.has('tao_phieu_thu_chi_nhap')` — trước Phase B1 set này rỗng → tool
  write biến mất khỏi model. Test fail-trước rồi implement.
- [ ] **A3.2** Sửa bug `writeTools.ts:106`: bỏ chỉ dẫn model "gọi respond NGAY BÂY GIỜ" — tool
  `respond` đã bị gỡ khỏi chat engine (xem doc-comment `chatEngine.ts:3-11`); chỉnh text preview
  theo flow hiện tại.
- [ ] **A3.3** `docs/ai-copilot/README.md` dòng 4 đang claim "10 tool đọc + 1 write" — thực tế 13
  đọc + 1 write. Thay số đếm tay bằng block sinh từ registry giữa
  `<!-- COPILOT_TOOL_INVENTORY:START/END -->`; gate so block với source, fail khi drift.

### Task A4: Selected organization — nền tảng đúng-công-ty (đóng B4, thay security-remediation Task 9 phần Copilot)

**Files:**
- Create: `supabase/migrations/20260814032500_copilot_superadmin_organization_directory.sql`
- Modify: `src/contexts/OrganizationContext.tsx`
- Create: `src/contexts/__tests__/OrganizationContext.test.ts` (CHƯA tồn tại — Create)
- Modify: `src/copilot/ChatPanel.tsx`
- Modify: `src/copilot/tools/registry.ts`, `src/copilot/tools/nghiepVuTools.ts`,
  `src/copilot/tools/writeTools.ts`
- Create: `src/copilot/__tests__/toolOrgScope.test.ts`
- Create: `scripts/test-copilot-org.mjs` (harness `--local-cluster`, pattern `test-cross-tenant.mjs`)
- Modify sau apply: `src/integrations/supabase/types.ts`, `contracts/surfaces/rpc-surface.json`

**Steps:**

- [ ] **A4.1** Xác minh `20260814032500` còn trống (lưu ý: plan security-remediation đã đặt chỗ dải
  `20260814010000..032000` — nếu plan đó land trước và tràn timestamp thì phối hợp cấp lại, không
  âm thầm đổi). Viết test fail-trước:
  - `resolveSelectedOrganizationId`: 4 case như Interface bắt buộc ở trên.
  - RPC: user thường chỉ thấy memberships ACTIVE; superadmin thấy directory ACTIVE; org
    suspended/unknown bị từ chối chọn; user thường forge org khác → từ chối.
  - Mỗi tool org-scoped (`so_quy`, `doanh_thu_thang`, `cong_no_tong_quan`, `tim_khach_hang`,
    `hop_dong_sap_het_han`, `tao_phieu_thu_chi_nhap`) trả lỗi ổn định `organization_required`
    TRƯỚC khi query khi `ctx.organizationId === null`.
- [ ] **A4.2** Migration: RPC `list_my_copilot_organizations_v1` (SECURITY DEFINER, REVOKE
  PUBLIC/anon). Đăng ký đủ sổ migration (provenance + unknown-review nếu áp dụng); qua
  `gate:migration-provenance`, `gate:migration-idempotent`, `gate:definer-acl`,
  `gate:ledger-frozen`; regen types + rpc-surface.
- [ ] **A4.3** `OrganizationContext`: thêm `selectedOrganizationId`/`selectOrganization`; nguồn
  selectable set là RPC mới (không phải cờ isSuper phía browser); persist chỉ ID; revalidate mỗi
  lần refresh, clear ngay khi org hết ACTIVE. **Xoá authority `organizations[0]`**
  (`OrganizationContext.tsx:103`). Grep chốt:
  `rg -n "organizations\[0\]" src/contexts src/copilot` → 0 kết quả mang tính authority.
- [ ] **A4.4** Luồn `organizationId` vào `ToolCtx` từ `ChatPanel`; tool đọc thêm
  `.eq('organization_id', ctx.organizationId)` nơi schema có cột đó; RPC tool truyền
  `p_organization_id` nơi RPC nhận; tool resolve tài nguyên cuối (building/type) vẫn authorize
  server-side. Hai tool A1 chỉ được bật lại cho model sau khi cả base + enrichment query đều bind
  org và harness wrong-org negative xanh.
- [ ] **A4.5** Verify:
  ```powershell
  npx vitest run src/contexts/__tests__/OrganizationContext.test.ts src/copilot/__tests__/toolOrgScope.test.ts src/copilot/__tests__/copilot.test.ts
  node scripts/test-copilot-org.mjs --local-cluster
  node scripts/test-copilot-readonly-queries.mjs --local-cluster
  npm run gate:migration-provenance; npm run gate:rpc-surface; npm run gate:definer-acl
  ```

### Task A5: Chất lượng routing/prompt (đóng PARTIAL C23/C25/C27/C28)

**Files:**
- Create: `src/copilot/temporalContext.ts` + `src/copilot/__tests__/temporalContext.test.ts`
- Modify: `src/copilot/systemPromptVi.ts`, `src/copilot/chatEngine.ts`
- Modify: `src/copilot/__tests__/chatTurn.test.ts`

**Steps:**

- [ ] **A5.1** `resolveRelativePeriod(text, ctx)` cho "tháng này"/"tháng trước" (C28); request
  context mang `currentDate` + IANA timeZone máy-đọc-được, không chỉ prose trong system prompt.
  Nếu model đề xuất tháng lệch với giá trị chuẩn hoá → reject tool call và re-plan.
- [ ] **A5.2** System prompt render danh sách khả năng từ registry đã lọc quyền (C25 — model đang
  phủ nhận `ty_le_lap_day`/`cong_no_tong_quan`/`coc_dang_giu`/`so_quy` dù tool tồn tại); cấm danh
  sách prose viết tay.
- [ ] **A5.3** Chat engine: một tool lỗi không hủy nhánh độc lập còn lại trong cùng câu hỏi (C27);
  câu trả lời cuối báo từng ý `thành công|lỗi|không chạy`. C23: khi yêu cầu lọc UI mà UI-control
  không bật, gọi readonly tool tương đương + trả deep-link canonical thay vì "không thể thao tác".
- [ ] **A5.4** Verify: vitest các file trên + chạy lại thủ công 6 case eval
  (C23/C25/C27/C28 + C02/C04) trên preview build, ghi kết quả vào PR.

**Exit gate Phase A:** 5 FAIL query = 0; wrong-org negative xanh; `organizations[0]` hết authority;
route không lệch; README đúng inventory; write tool không còn expose cho model.

---

## Phase B — Đóng blocker ghi (consent server + audit bất biến)

### Task B1: Confirmation nonce server (đóng B3 — thay security-remediation Task 16)

Hiện `xac_nhan: z.boolean()` nằm trong input schema (`writeTools.ts:29-32`) — model tự lật
`false→true`, prompt injection tạo được phiếu thật. Không có `confirmationStore.ts` (Create mới).

**Files:**
- Create: `supabase/migrations/20260814034500_copilot_confirmation_intent_v1.sql`
- Create: `src/copilot/confirmationStore.ts`
- Modify: `src/copilot/chatEngine.ts`, `src/copilot/tools/writeTools.ts`,
  `src/copilot/ChatPanel.tsx`
- Modify: `src/copilot/__tests__/chatTurn.test.ts`, `src/copilot/__tests__/copilot.test.ts`
- Create: `src/lib/__tests__/copilotConfirmationNonceMigration.test.ts`
- Modify sau apply: `src/integrations/supabase/types.ts`, `contracts/surfaces/rpc-surface.json`

**Steps:**

- [ ] **B1.1** Test fail-trước: model gửi xac_nhan=true lượt đầu; payload đổi sau preview; org đổi;
  nonce hết hạn/replay/khác user; 2 execute đồng thời; building thuộc org khác; idempotency key
  trùng với payload khác. Mỗi case phải fail TRƯỚC khi tạo phiếu/audit.
- [ ] **B1.2** Migration: `app_private.copilot_write_confirmations` (id, nonce_digest bytea UNIQUE,
  user_id, organization_id, tool, payload_hash bytea, permission_key, expires_at, consumed_at,
  created_at); RPC preview trả nonce raw đúng một lần TTL 5 phút; RPC execute: hash → lock theo
  thứ tự org→confirmation→building/type → re-check actor/org/permission/payload-hash → CAS
  `consumed_at IS NULL` → tạo draft `UNAPPROVED` + ghi audit **trong cùng transaction**. Đăng ký
  đủ sổ migration; định danh ACL như A4.
- [ ] **B1.3** Client: bỏ `xac_nhan` khỏi schema (input chỉ còn business fields); `chatEngine` gọi
  preview → render confirmation card deterministic → CHỈ click UI thật lưu nonce vào
  `confirmationStore` (in-memory, theo conversation/action/payload-hash); model không bao giờ thấy
  nonce; execute tiêu nonce rồi read-after-write hiển thị link draft + bước duyệt còn lại.
- [ ] **B1.4** Verify: vitest 4 file test + `npm run gate:migration-provenance`,
  `gate:rpc-surface`, `gate:definer-acl`; `npm run gate:reconcile-money` không đổi ngoài draft
  pending kỳ vọng.

### Task B2: Cứng hoá `ai_write_audit` (LEAN thay cho action ledger mới)

Đã xác minh: policy `ai_write_audit_insert` + `ai_write_audit_update_own` cho phép browser
INSERT/UPDATE trực tiếp (baseline schema ~159941-159995), và `writeTools.ts:112,125,179` đang làm
đúng thế. Audit sửa được thì không phải audit.

**Files:**
- Create: `supabase/migrations/20260814034000_ai_write_audit_hardening.sql`
- Modify: `src/copilot/tools/writeTools.ts` (gỡ mọi `.from('ai_write_audit')` phía client)
- Create: `src/lib/__tests__/aiWriteAuditHardeningMigration.test.ts`

**Steps:**

- [ ] **B2.1** Test fail-trước: authenticated INSERT/UPDATE/DELETE trực tiếp phải bị từ chối;
  ghi audit chỉ đi qua RPC execute B1; UPDATE/DELETE bị trigger chặn kể cả đường service không
  chủ đích.
- [ ] **B2.2** Migration: DROP 2 policy trên; trigger immutable chặn UPDATE/DELETE; giữ SELECT
  policy hiện có. Sổ migration + gates như A4. (B2 land CÙNG PR hoặc TRƯỚC B1-client-switch để
  không có khoảng trống write path.)

### Task B3: E2E Copilot đầu tiên + chống deployment drift kiểu lean (đóng C38, F cũ về E2E)

Hiện `.e2e-fleet/specs/` KHÔNG có spec `copilot-*` nào; Playwright config default
`https://ptcrm.vercel.app` (production) và chưa có logic source-SHA.

**Files:**
- Create: `src/buildMetadata.ts` (hằng build-time = full git SHA) + meta tag trong `index.html`
- Modify: `.e2e-fleet/playwright.config.ts` (helper đọc meta tag; spec ghi bắt buộc
  `FLEET_BASE_URL` tường minh)
- Create: `.e2e-fleet/specs/copilot-confirmation.spec.ts` (Create — plan cũ ghi nhầm "Modify")
- Create: `.e2e-fleet/specs/copilot-readonly-smoke.spec.ts`

**Steps:**

- [ ] **B3.1** Meta tag `<meta name="build-sha" content="<40-hex>">` từ `buildMetadata`; helper E2E
  so với `EXPECTED_SOURCE_SHA` (`git rev-parse HEAD`); thiếu/ngắn/lệch → fail trước mọi assertion
  nghiệp vụ. KHÔNG xây release manifest/receipt/Management API readback (Deferred).
- [ ] **B3.2** `copilot-confirmation.spec.ts` (mock provider qua proxy, org DEMO): positive
  preview→click→execute tạo đúng 1 draft `UNAPPROVED` + 1 dòng audit; negative (không click, nonce
  hết hạn, payload đổi) tạo 0. `copilot-readonly-smoke.spec.ts`: chạy C01-mẫu, C02, C04, C25, C28
  qua proxy mock — zero runtime query error.
- [ ] **B3.3** Verify:
  ```powershell
  $env:EXPECTED_SOURCE_SHA = git rev-parse HEAD
  # FLEET_BASE_URL trỏ preview build của HEAD đã review — bắt buộc, không nhận default
  cd .e2e-fleet; $env:FLEET_WORKERS='2'; npx playwright test specs/copilot-confirmation.spec.ts specs/copilot-readonly-smoke.spec.ts
  ```

**Exit gate Phase B:** model không thể tự xác nhận ghi (mọi negative đỏ→xanh); browser hết đường
INSERT/UPDATE audit; E2E copilot tracked chạy trên đúng bản build đã review.

---

## Phase C — Hợp đồng hoá nhẹ + mở rộng đọc toàn site

### Task C1: Safe-control whitelist thay blacklist regex (đóng B1 — lỗ autosave)

Blacklist DANGER_RE/SUBmit_RE hiện tại đã thủng: dropdown autosave đổi phương thức thanh toán =
ghi DB thật không bị chặn. `interactiveWhitelist` của page-agent 1.11.0 là additive, không
exclusive; selector-map không public — nên đi path B: semantic tools.

**Steps:**

- [ ] **C1.1** Spike pin semantics dependency: test version-sensitive đọc declarations/runtime
  1.11.0, chứng minh whitelist không exclusive + index primitives tồn tại. Nếu upgrade đổi
  semantics, test này đỏ trước.
- [ ] **C1.2** Disable index primitives qua `customTools: { click_element_by_index: null,
  input_text: null, select_dropdown_option: null, ... }` (hiện mới null mỗi `execute_javascript`);
  thêm `safe_click/safe_input/safe_select` resolve `data-ai-safe="<pageKey>.<control>"` ngay trước
  dispatch, quét document + portal + open shadow root + same-origin iframe, đúng một match; từ
  chối label/index/CSS input. TOCTOU test: element bị thay/route đổi giữa observe và act → deny.
- [ ] **C1.3** Giữ blacklist hiện tại làm defense-in-depth. KHÔNG mark
  `PaymentsSummaryDialog` payment items safe (onSelect mutate). Browser proof:
  `.e2e-fleet/specs/copilot-pageagent-safety.spec.ts` — autosave/icon-only/submit/injection tasks
  → zero mutation request.
- [ ] **C1.4** (PR riêng) CSP production không `'unsafe-eval'`: dời inline watchdog
  (`index.html:19-227`) + inline style (`:233`) ra file tĩnh, thay font-preload `onload`
  (`:326`) bằng loader same-origin; thêm CSP header vào `vercel.json` (hiện CHƯA có CSP nào) sau
  khi inventory đủ origin (Supabase, fonts, ảnh, geocode, storage/PDF iframe). PageAgent không
  chạy được thiếu eval → giữ UI-control disabled, không nới CSP.

### Task C2: Page contract nhẹ trên Capability Registry

`CapabilityDefinition` (9 field, 27 capability) CHƯA có field `copilot` — mở rộng schema thật.

- [ ] **C2.1** Thêm `copilot?: { pages: readonly CopilotPageContract[] }` (key, route, mode
  `none|read|navigate|filter|draft`, permission, dataClass, safeControlIds, e2eSpec?, exemption?);
  `copilotPageByRoute(pathname)` normalize trailing slash/wildcard, redirect về canonical.
- [ ] **C2.2** Gate mới `scripts/check-copilot-page-contracts.mjs` (+ npm script
  `gate:copilot-pages`): key/route unique, permission tồn tại đúng `module.action`, `draft` bắt
  buộc e2eSpec, trang financial/security khởi đầu tối đa `read|navigate`, và **113 route
  non-redirect** (đếm lại từ `collectAllRoutes()` của `check-route-guards.mjs`, không hard-code)
  đều được kê khai hoặc exempt có lý do. `mo_trang`/PageAgent allowlist sinh từ page contract —
  một nguồn duy nhất. KHÔNG sinh manifest digest/revision (Deferred).

### Task C3: Feature flags rollout đơn giản (thay rollout control plane)

- [ ] **C3.1** Migration `20260814035500_copilot_feature_flags.sql`: bảng
  `copilot_feature_flags(scope 'page'|'action', contract_id, state 'disabled'|'shadow'|'enabled',
  canary_org uuid null, updated_by, updated_at)` + audit log thường (bảng append phụ, không cần
  ledger engine); RPC `get_my_copilot_availability_v1(p_organization_id)`. Admin toggle qua RPC,
  không `.from().update()` trực tiếp. Sổ migration + gates như A4.
- [ ] **C3.2** `buildRegistry`/`toPageAgentTools`/`toLlmTools` lọc theo availability set; null/stale
  snapshot → expose 0 action rollout-controlled (fail closed); admin UI hiển thị state + blocker.

### Task C4: Mở read/navigation theo batch domain + golden eval lite

- [ ] **C4.1** `tooling/copilot-golden-eval.json` pin C01–C30 (input, outcome kỳ vọng, tool path
  chấp nhận được, empty-state, forbidden). 2 lane trong
  `.e2e-fleet/specs/copilot-golden-readonly.spec.ts`: mock lane (safety/authz deterministic) +
  real-model lane pinned (chất lượng routing + latency, ghi min/median/p95). Ghi provider/model +
  build SHA mỗi run; KHÔNG yêu cầu entitlement/permission snapshot đầy đủ (Deferred).
- [ ] **C4.2** Mở page contract theo batch (buildings/rooms → customers/contracts → invoices read →
  reports...) — mỗi batch: khai contract, bật flag `shadow` → chạy golden + smoke → `enabled`.
  Trang admin/public/auth mặc định `none` + exemption. Batch sau chỉ mở khi batch trước xanh.

### Task C5: Provider lite + egress tối giản

- [ ] **C5.1** Thêm `pricing_mode: 'metered'|'free'|'self_hosted'|'unknown'` vào từng model trong
  jsonb `ai_providers.models` (KHÔNG bảng mới; bảng đã có pricing trong jsonb — không có bảng
  `ai_usage_reservations`, reservation là dòng `ai_usage_logs` status pending). `llm-proxy` +
  admin UI cùng từ chối model `unknown` pricing; cost hiển thị "unknown" thay vì $0. Ollama:
  dev/read-only, ghi rõ trong copy.
- [ ] **C5.2** Egress dùng cột `data_class` sẵn có của `ai_providers` + `maskPii` hiện hữu; tool
  output structured field-allowlist ở mức đơn giản (hàm thuần trong `chatEngine`). KHÔNG xây
  grant token TTL (Deferred). Knowledge: citation trỏ
  `/settings/ai-copilot?knowledge=<docKey>` + cảnh báo `knowledge_stale` khi doc chưa review —
  KHÔNG chặn execute.

**Exit gate Phase C:** default-deny theo contract + flag; autosave/icon-only/injection zero-mutation
proof; 113 route accounted; golden eval lite chạy 2 lane xanh trên batch đã mở.

---

## Phase D — Draft + write có kiểm soát

- [ ] **D1. Draft-only safe controls:** chọn form không autosave, trace mọi
  onChange/onValueChange/onSelect/blur trước khi mark safe; E2E fill qua từng traversal root →
  DOM value đổi, mutation count = 0, reload mất draft
  (`.e2e-fleet/specs/copilot-draft-matrix.spec.ts`).
- [ ] **D2. Promote finance draft:** ma trận role (superadmin org A, manager building được phép,
  staff thiếu quyền, org B, revoke giữa preview/execute, replay, 2 execute đồng thời, injection
  đòi auto-approve); thành công = đúng 1 draft `UNAPPROVED` + 1 audit, KHÔNG posting/approval;
  duyệt vẫn là người khác qua workflow thường. Chạy `npm run gate:reconcile-money` +
  `gate:reconcile-money-v2` trước canary.
- [ ] **D3. Ranh giới cấm (L5/L6):** test hỏi Copilot duyệt/vào sổ/xoá/đổi quyền/SQL/secret/deploy
  → chỉ trả hướng dẫn + hồ sơ chờ duyệt, không có executor; validator fail build nếu action cấm
  có tool. Admin không toggle được các action này.

**Exit gate Phase D / chương trình:** ma trận E2E role-real xanh trên DEMO; unintended-write = 0;
duplicate = 0; wrong-org success = 0; kill switch (`ai_copilot_settings` 3 tầng:
settings singleton + entitlements per-user + permission) tắt được giữa task.

---

## Phụ lục A — 13 điểm lệch giữa plan cũ và thực tế (đã sửa trong bản này)

1. Prerequisite security-remediation Task 9/16: chưa implement 0%, file untracked → plan này sở
   hữu org+nonce; bỏ mô thức "reuse nếu đã land".
2. `scripts/test-security-remediation.mjs` không tồn tại → thay bằng harness copilot riêng theo
   pattern `test-cross-tenant.mjs` (2 tiền lệ `--local-cluster` duy nhất trong repo).
3. Timestamp: bỏ `20260814036000` (phút 60 — không phải thời khắc hợp lệ); dải
   `20260814010000..032000` đã bị plan security-remediation đặt chỗ; plan này dùng
   032500/034000/034500/035500.
4. Plan cũ thiếu toàn bộ bước đăng ký sổ migration (`migration-provenance.json`,
   `forward-lane-expectations.json`, `migration-unknown-review.json`) + gates
   idempotent/ledger-frozen — đã đưa vào ràng buộc toàn cục.
5. `tim_khach_hang`/`hop_dong_sap_het_han` nằm ở `tools/registry.ts`, không phải
   `nghiepVuTools.ts`.
6. Các file plan cũ ghi "Modify" nhưng chưa tồn tại (Create): `confirmationStore.ts`,
   `copilot-confirmation.spec.ts`, `src/contexts/__tests__/OrganizationContext.test.ts`.
7. `buildRegistry()` hiện không nhận tham số — mô tả đúng là "thêm options".
8. Entitlement là 3 tầng: `ai_copilot_settings` (singleton global) + `ai_copilot_entitlements`
   (per-user, không có dòng = không dùng) + permission `ai_copilot.view`/`ui_control`. Không tồn
   tại `organization_entitlements` hay `global_settings`.
9. Không có bảng `ai_usage_reservations` — reservation = dòng `ai_usage_logs` `status='pending'`;
   `usageReservationId` = id dòng đó.
10. Rate limit ở DB (`ai_copilot_settings.rate_per_min`, default 20/phút/user) — khớp kết quả
    C36 (21 request → 20 OK + 1×429); quota USD 2/10/30 theo `Asia/Ho_Chi_Minh`.
11. Bug thực tế mới phát hiện: `writeTools.ts:106` chỉ dẫn model gọi tool `respond` đã bị gỡ —
    sửa ở A3.2.
12. Playwright default `https://ptcrm.vercel.app` (production) và chưa có logic
    `EXPECTED_SOURCE_SHA` — B3 xử lý kiểu lean (meta tag + helper), không xây bộ máy attestation.
13. `supabase/config.toml` không có block `[functions.llm-proxy]` (verify_jwt=true từ default
    platform; surface xác nhận version 25 ACTIVE) — chỉ ghi nhận, LEAN không cần đổi.

## Phụ lục B — Deferred (nâng cấp khi mở write tự động rộng / lên Op3)

- Execution-plan engine đa bước (6 RPC, claim token, CAS checkpoint, reconciliation).
- Immutable contract manifest + digest/revision server (thay cho feature flags).
- Action ledger riêng append-only đầy đủ (thay cho `ai_write_audit` đã cứng hoá).
- Egress grant token một lần TTL 5 phút; per-result authorization resolvers.
- Attestation llm-proxy đầy đủ (release manifest, deploy receipt, Management API readback,
  SHA/digest mọi response).
- Golden eval provenance đầy đủ (bind entitlement/permission snapshot, manifest digest).
- Batch consent cho chuỗi ghi cùng loại + step-up approve cho L5 (đường lên Op3 — quyết định
  sản phẩm, làm sau khi Op1 chạy ổn và có số liệu).
