# AI Copilot Superadmin Control — Plan LEAN (đã đối chiếu thực tế 2026-08-14)

> **[CÒN SỐNG — trạng thái 02/09/2026]** Plan LEAN Op1 (chốt 14/08, commit `f54b9025`). Trạng thái phase: A ⚠ từng phần · **B ❌ chưa đủ bằng chứng** · D ⬜ chưa bắt đầu. Chuỗi migration copilot 28–31/08 (`copilot_org_scope`, `draft_writer`, `restricted_category_guard`…) đã ship phần scope/draft — đối chiếu bảng trạng thái trong file trước khi làm tiếp.

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

**Oracle chất lượng:** `docs/ai-copilot/COPILOT-EVALUATION-2026-08-13.md` — 40 case live. Headline
snapshot ghi C01–C30 là 15 PASS / 7 PARTIAL / 8 FAIL, nhưng các case rows hiện đếm được 16 PASS /
7 PARTIAL / 7 FAIL; discrepancy này phải được reconcile bằng golden runner trước khi dùng làm KPI.
Plan này phải đóng được các FAIL/PARTIAL nhóm query, routing, relative-date, orchestration.

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
// src/copilot/tools/registry.ts — contract đã land ở worktree; acceptance vẫn phải giữ
// selected organization explicit và server-authorized cho mọi tool scoped.
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

- Phase C3 (forward migration rollout; source hien tai `20260828170000_copilot_feature_flags_v1.sql`)
public.get_my_copilot_availability_v1(p_organization_id uuid) RETURNS jsonb
  -- trả set page/action ID đang enabled cho actor+org từ bảng copilot_feature_flags.
```

---

## Tiến độ (cập nhật 2026-08-28 — đối chiếu lại bằng chứng)

| Task | Trạng thái | Commit |
| --- | --- | --- |
| A1 — sửa 4 quan hệ sai | ⚠ source + local harness đã xanh; live PostgREST chưa rerun | `56b177c6`, `2584f23a` |
| A2 — đồng bộ route + gate subset | ✅ xong cho pilot 3 route (không phải full-site) | `a01e63dc`, `fb20970a` |
| A3.2 — bug chỉ dẫn tool `respond` | ✅ xong | `27962a39` |
| A3.3 — inventory tool sinh từ nguồn | ✅ xong | `432c7937` |
| A5 — kỳ tương đối + năng lực prompt | ⚠ unit/static có, live rerun và prompt drift còn mở | `6f20583f` |
| A3.1 — containment write | ⏭ gộp vào B1 (xem ghi chú) | — |
| A4 — selected organization | ⚠ 9 tool scoped đã nhận org ở source: 7 tool qua 8 RPC wrapper; `tim_khach_hang` và `hop_dong_sap_het_han` vẫn query PostgREST với filter do client cung cấp, chưa là server authorization; live catalog/readback, role-real E2E và provenance còn mở | `80cc45aa` (migration), `4f3af291` (client), worktree 28/08 |
| **Phase A** | **⚠ source/static từng phần, chưa đạt release gate** | A1 local 7/7; còn live rerun, A4 scope và A5 behavioral proof |
| B1 — nonce xác nhận server | ⚠ source/migration có, negative/E2E đầy đủ còn thiếu | `86717f59` (migration), `562ea33a` (store), `da89ecc1` (client) |
| B2 — cứng hoá `ai_write_audit` | ⚠ migration/static có, runtime ACL harness chưa có | `e366679c` |
| B3 — build SHA + E2E đầu tiên | ⚠ worktree có 4 Copilot spec (1 tracked + 3 mới chưa tracked); chưa có live run attested đúng SHA | `d5bd7903`, `393a5cbc`, worktree 28/08 |
| **Phase B** | **❌ CHƯA ĐỦ BẰNG CHỨNG / KHÔNG ĐƯỢC GỌI LÀ ĐÃ LÊN PRODUCTION** | E2E fleet local-only; spec mới chưa tracked và behavioral/negative cases chưa đủ |
| C1.1 — pin semantics PageAgent | ✅ source/unit, chưa có browser safety proof | `34fb965e` |
| C1.2 — bộ giải safe-control | ✅ source/unit, chưa có semantic integration | `04437ba8` |
| C1.3+ — safe tools, page contract, flags, CSP | ⚠ scaffold có; marker/browser proof và rollout authority chưa đạt | worktree 28/08 |
| Phase D | ⬜ chưa bắt đầu | — |

**Ghi chú reconciliation 2026-08-28:** ba migration Copilot có evidence đã apply production; điều
đó không đồng nghĩa Phase A/B đã đạt release gate ứng dụng. Sau khi đối chiếu
`COPILOT-EVALUATION-2026-08-13.md`, B3 vẫn chưa đạt vì các spec hiện mới chỉ tồn tại trong
worktree (ba spec mới chưa tracked), chưa có live run/attestation và chưa đủ negative/behavioral
oracle; A4 source đã có server-bound wrapper nhưng chưa
đạt multi-org release vì live catalog/readback, provenance và role-real wrong-org/revocation proof
còn thiếu; A5 còn thiếu live relative-date/routing proof (prompt boolean drift đã được supersede ở
source). Không chuyển
phase tiếp theo hoặc promote production
cho Copilot cho đến khi các điều kiện trong Addendum 2026-08-28 của audit được chứng minh.

A1 đã có thêm harness local ở commit `2584f23a`: 7/7 assertion FK/schema/positive/empty/wrong-org
trên PostgreSQL disposable cluster, có rollback và teardown. Bằng chứng này nâng A1 từ “thiếu
harness” thành “local contract pass”, nhưng chưa thay thế PostgREST schema-cache/live rerun đúng SHA.

Các checkbox ở phần task bên dưới là **acceptance criteria chưa đủ bằng chứng**, kể cả khi file/source
tương ứng đã tồn tại. Không suy ra trạng thái hiện hành từ câu mở đầu lịch sử như “Hiện...” hoặc từ
nhãn “đã thực hiện”; bảng tiến độ và audit Addendum 27 là nguồn trạng thái hiện hành.

**Phát hiện C1.1 sửa lại spec**: `eval` chỉ nằm trong thân
`PageController.executeJavascript` — tool đã tắt từ trước. Nên **CSP production
KHÔNG cần `'unsafe-eval'`**, trái với giả định F6 của spec. Việc thêm CSP rẻ hơn
nhiều so với kế hoạch.

### ✅ ĐÃ APPLY LÊN PRODUCTION — 2026-08-14

Ba migration đã chạy thật, mỗi lần lane tự backup trước và tự phát giấy phép từ
chính bản dump đó:

| Migration | Backup | Giấy phép |
| --- | --- | --- |
| `20260814032500` danh bạ tổ chức | 55.9 MB · 577 bảng có dữ liệu | `958a9678bf427f10` |
| `20260814034500` nonce xác nhận | 55.9 MB · 577 bảng | `94ef51a36f40b610` |
| `20260814034600` cứng hoá audit | 55.9 MB · 578 bảng | `5f3e9927ec411ac7` |

**Kiểm chứng bằng catalog thật**, không tin dòng "catalog KHÔNG ĐỔI" của lane
(fingerprint của nó không phủ hàm public): hàm `1558 → 1559 → 1562 → 1563`,
SECURITY DEFINER `1086 → 1090`. Đúng số dự kiến — hai hàm nonce là DEFINER, hàm
băm KHÔNG phải DEFINER, khớp thiết kế và khớp test tĩnh.

Đã regen types + rpc-surface và **gỡ `GoiRpcChuaSinhType`**. Kiểu thật chặt hơn
cast cũ và bắt được một chỗ: `p_payload` phải là `Json`.

Bằng chứng lưu ở `docs/generated/schema-change-evidence/`.

### Thứ tự phát hành Phase B — bắt buộc (đã thực hiện)

1. `migrate:forward` áp **theo thứ tự timestamp**: `032500` (danh bạ) → `034500`
   (nonce) → `034600` (cứng hoá audit). Thứ tự này có chủ ý: đường ghi mới phải
   tồn tại trước khi đường ghi cũ bị đóng.
2. Regen `src/integrations/supabase/types.ts` + `contracts/surfaces/rpc-surface.json`,
   rồi **xoá `GoiRpcChuaSinhType`** trong `writeTools.ts` — helper đó tồn tại đúng để
   đánh dấu chỗ chưa có type; giữ lại sau khi apply là che mất kiểu thật.
3. Deploy web **ngay sau đó**. Khoảng giữa bước 1 và 3, write tool của bản web cũ
   sẽ báo lỗi RLS và **không tạo phiếu nào** — hỏng an toàn, không phải hỏng dữ liệu.
4. Chạy E2E: `FLEET_BASE_URL=<preview> EXPECTED_SOURCE_SHA=$(git rev-parse HEAD)
   FLEET_PASS_CHUNHA=… npx playwright test specs/copilot-confirmation.spec.ts`.
   Đã xác minh SHA vào được bundle khi build với `VITE_BUILD_SHA`.

**Đã apply production ngày 2026-08-14**: ba migration `032500`/`034500`/`034600` có evidence ở
`docs/generated/schema-change-evidence/`. Source hiện đã chuyển client sang
`list_my_copilot_organizations_v1`; release gate A4 vẫn mở vì các wrapper mới chưa có live
catalog/readback và role-real proof trên deployment đúng SHA.

**Khoảng trống A4 còn lại** (đã ghi một phần bằng test trong `toolOrgScope.test.ts`): 9 tool scoped
hiện gồm 7 tool qua 8 RPC wrapper server-side (occupancy dùng hai RPC) và 2 tool PostgREST còn
tin vào filter `organization_id` do client cung cấp. Filter phía browser không phải selected-org
server boundary, đặc biệt khi RLS cho superadmin đọc toàn bảng. Live catalog/readback, provenance,
server authorization và role-real wrong-org/revocation proof còn thiếu. Không coi binding source là
release PASS; mọi tool phải chứng minh foreign row = 0 trước formatter.
`doanh_thu_thang` là một trong các tool đã được chuyển sang wrapper P&L server-bound; vẫn cần
positive/empty/wrong-org/revoked assertion và parity readback cùng các tool còn lại.

**Ghi chú A3.1 → B1**: plan gốc định gỡ `tao_phieu_thu_chi_nhap` khỏi model cho tới
khi có nonce. Làm vậy sẽ mất một tính năng đang chạy trong suốt thời gian làm B1, mà
bán kính thiệt hại của lỗ hổng hiện tại có giới hạn (phiếu tạo ra là `UNAPPROVED`,
phải có người duyệt ở `/income-expense`). Đổi lại: B1 chuyển thẳng từ `xac_nhan`
sang nonce, không có khoảng trống. Thứ tự phát hành bắt buộc: **apply migration
trước, deploy web sau** (migration chỉ THÊM đối tượng nên apply sớm là an toàn).

**Phát hiện mới trong lúc thực thi** (bổ sung bằng chứng cho B1 của spec):
- Lỗ autosave KHÔNG chỉ có `PaymentsSummaryDialog`. Thêm hai chỗ trên `/buildings`:
  `<Switch>` bật/tắt trạng thái toà nhà (`BuildingListTable`) và multiselect gán toà
  vào khu vực (`ManageAreasDialog`) — cả hai gọi mutation ngay khi đổi, **không có
  nhãn văn bản nào** nên không hàng rào theo nhãn nào bắt được.
- Hàng rào nhãn bỏ sót ba lớp, đã vá hai: `title` (đã đọc), nhãn ghép che nhau (đã
  soi rời), `nhượng` không có "chuyển" phía trước (đã vá regex). Còn lại **chưa vá**:
  nhãn chỉ nằm trong `<TooltipContent>` (portal, chỉ render khi hover) — "Thanh lý",
  "Gia hạn", "Chuyển phòng", "ĐK chuyển đi" trên bảng hợp đồng. Đây là việc của C1.
- `\b` của JS regex không hoạt động sau ký tự có dấu. Đã dính hai lần trong phiên
  này (`công cụ\b` trong gate inventory, và chính `DANGER_RE` đã ghi chú sẵn bẫy đó).

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

**Cập nhật 2026-08-28:** harness đã land ở commit `2584f23a` và pass 7/7 assertion trên
PostgreSQL disposable cluster (có rollback/teardown). Đây là local contract proof; vẫn bắt buộc
rerun PostgREST trên deployment đúng SHA để đóng các case C02/C04/C14/C16/C27.

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
- [ ] **A3.3** Baseline lúc lập plan ghi "10 tool đọc + 1 write" (sau đó từng lệch thành 13 đọc);
  inventory hiện hành là 12 đọc + 1 ghi + 1 điều hướng = 14 tool. Thay số đếm tay bằng block sinh từ registry giữa
  `<!-- COPILOT_TOOL_INVENTORY:START/END -->`; gate so block với source, fail khi drift.

### Task A4: Selected organization — nền tảng đúng-công-ty (đóng B4, thay security-remediation Task 9 phần Copilot)

**Files:**
- Create: `supabase/migrations/20260814032500_copilot_superadmin_organization_directory.sql`
- Modify: `src/contexts/OrganizationContext.tsx`
- Create: `src/contexts/__tests__/OrganizationContext.test.ts` (CHƯA tồn tại — Create)
- Modify: `src/copilot/ChatPanel.tsx`
- Modify: `src/copilot/tools/registry.ts`, `src/copilot/tools/nghiepVuTools.ts`,
  `src/copilot/tools/writeTools.ts`
- Create: `supabase/migrations/20260829020000_copilot_customer_contract_scope_v1.sql`
- Create: `src/copilot/__tests__/toolOrgScope.test.ts`
- Create: `scripts/test-copilot-org.mjs` (harness `--local-cluster`, pattern `test-cross-tenant.mjs`)
- Modify: `.e2e-fleet/specs/copilot-readonly-smoke.spec.ts`
- Modify sau apply: `src/integrations/supabase/types.ts`, `contracts/surfaces/rpc-surface.json`

**Steps:**

- [ ] **A4.1** Xác minh `20260814032500` còn trống (lưu ý: plan security-remediation đã đặt chỗ dải
  `20260814010000..032000` — nếu plan đó land trước và tràn timestamp thì phối hợp cấp lại, không
  âm thầm đổi). Viết test fail-trước:
  - `resolveSelectedOrganizationId`: 4 case như Interface bắt buộc ở trên.
  - RPC: user thường chỉ thấy memberships ACTIVE; superadmin thấy directory ACTIVE; org
    suspended/unknown bị từ chối chọn; user thường forge org khác → từ chối.
  - Mỗi tool org-scoped (`so_quy`, `doanh_thu_thang`, `cong_no_tong_quan`, `coc_dang_giu`,
    `ty_le_lap_day`, `phong_trong`, `tim_hoa_don`, `tim_khach_hang`, `hop_dong_sap_het_han`,
    `tao_phieu_thu_chi_nhap`) trả lỗi ổn định `organization_required`
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
- [ ] **A4.4** Luồn `organizationId` vào `ToolCtx` từ `ChatPanel`; tool truyền
  `p_organization_id` vào typed RPC nơi RPC nhận; **không dùng `.eq('organization_id', ...)` ở
  browser làm authority**. Migration `20260829020000_copilot_customer_contract_scope_v1.sql`
  tạo typed RPC cho `tim_khach_hang` và `hop_dong_sap_het_han`, field allowlist, re-check actor,
  org ACTIVE, sandbox/lifecycle, permission và selected-org contract trước khi đọc. Tool resolve tài
  nguyên cuối (building/type) vẫn authorize server-side. Hai tool A1 chỉ được bật lại cho model sau
  khi base + enrichment cùng bind org và harness wrong-org/forged-org negative xanh.
- [ ] **A4.5** Verify:
  ```powershell
  npx vitest run src/contexts/__tests__/OrganizationContext.test.ts src/copilot/__tests__/toolOrgScope.test.ts src/copilot/__tests__/copilot.test.ts
  node scripts/test-copilot-org.mjs --local-cluster
  node scripts/test-copilot-readonly-queries.mjs --local-cluster
  # positive, empty, forged-org, wrong-org, revoked-membership; foreign-row = 0 trước formatter
  cd .e2e-fleet; npx playwright test specs/copilot-readonly-smoke.spec.ts
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

**Exit gate Phase A:** 5 FAIL query = 0; các ca wrong-org/forged-org/revoked-membership đều
negative xanh; `tim_khach_hang` và `hop_dong_sap_het_han` không còn client-only
`.eq('organization_id', ...)` mà dùng typed server boundary; foreign-row = 0 trước formatter;
`organizations[0]` hết authority; route không lệch; README đúng inventory; write tool không
expose cho **PageAgent/UI-control** (chat vẫn có thể thấy write tool sau khi server consent
contract đã bật).

---

## Phase B — Đóng blocker ghi (consent server + audit bất biến)

### Task B1: Confirmation nonce server (đóng B3 — thay security-remediation Task 16)

**Baseline trước remediation:** `xac_nhan: z.boolean()` từng nằm trong input schema và model có thể
tự lật `false→true`. Source hiện đã có nonce server + `confirmationStore.ts`, nhưng store mới là một
khe global và proof behavioral còn thiếu; các checkbox dưới đây là acceptance criteria chưa đủ bằng
chứng, không phải mô tả code chưa tồn tại.

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

Baseline khi task B3 được lập không có spec `copilot-*`; hiện worktree đã có 4 spec (confirmation
đã tracked và ba spec mới chưa tracked). Playwright config vẫn có default
`https://ptcrm.vercel.app` (production), còn source-SHA helper mới chỉ là source/local evidence.

**Files:**
- Create: `src/buildMetadata.ts` (hằng build-time = full git SHA) + meta tag trong `index.html`
- Modify: `.e2e-fleet/playwright.config.ts` (helper đọc meta tag; spec ghi bắt buộc
  `FLEET_BASE_URL` tường minh)
- Existing/tracked: `.e2e-fleet/specs/copilot-confirmation.spec.ts`
- Existing/untracked at current worktree: `.e2e-fleet/specs/copilot-readonly-smoke.spec.ts`,
  `.e2e-fleet/specs/copilot-golden-readonly.spec.ts`, `.e2e-fleet/specs/copilot-pageagent-safety.spec.ts`

**Steps:**

- [ ] **B3.1** Meta tag `<meta name="build-sha" content="<40-hex>">` từ `buildMetadata`; helper E2E
  so với `EXPECTED_SOURCE_SHA` (`git rev-parse HEAD`); thiếu/ngắn/lệch → fail trước mọi assertion
  nghiệp vụ. KHÔNG xây release manifest/receipt/Management API readback (Deferred).
- [ ] **B3.2** `copilot-confirmation.spec.ts` (mock provider qua proxy, org DEMO): positive
  preview→click→execute tạo đúng 1 draft `UNAPPROVED` + 1 dòng audit; negative (không click, nonce
  hết hạn, payload đổi) tạo 0. `copilot-readonly-smoke.spec.ts`: chạy C01-mẫu, C02, C04, C25, C28
  qua proxy mock — zero runtime query error.
- [ ] **B3.2a** Gate file-existence phải fail nếu một trong **bốn** spec Copilot bắt buộc
  (`copilot-confirmation`, `copilot-readonly-smoke`, `copilot-golden-readonly`,
  `copilot-pageagent-safety`) không tồn tại; không dựa vào Playwright để phát hiện file thiếu.
  Gate cũng phải kiểm tra các spec đã được git-track và ghi artifact run; file tồn tại/typecheck
  không được tính là live behavioral coverage. Confirmation spec phải cấu hình mock provider/upstream
  thật sự; chỉ viết chữ "mock" trong plan không được tính là coverage.
- [ ] **B3.3** Verify:
  ```powershell
  $env:EXPECTED_SOURCE_SHA = git rev-parse HEAD
  # FLEET_BASE_URL trỏ preview build của HEAD đã review — bắt buộc, không nhận default
  cd .e2e-fleet; $env:FLEET_WORKERS='2'; npx playwright test specs/copilot-confirmation.spec.ts specs/copilot-readonly-smoke.spec.ts
  ```
  File-existence/typecheck pass không thay thế việc chạy đủ bốn spec trên preview build đã attested;
  ba spec mới hiện chỉ là smoke/schema tối thiểu, chưa phải behavioral golden proof.

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

- [ ] **C3.1** Migration rollout (forward timestamp thực tế phải theo file chưa deploy): bảng
  `copilot_feature_flags(scope 'page'|'action', contract_id, state 'disabled'|'shadow'|'enabled',
  canary_org uuid null, updated_by, updated_at)` + audit log thường (bảng append phụ, không cần
  ledger engine); RPC `get_my_copilot_availability_v1(p_organization_id)`. Admin toggle qua typed
  transition RPC, không `.from().update()` trực tiếp. Transition RPC phải re-check quyền admin,
  validate `disabled -> shadow -> enabled`/rollback, dùng expected global revision để chặn stale và
  ghi audit append-only trong cùng transaction. Snapshot key phải giữ cả `scope` và `contract_id`
  (composite hoặc nested), không được `jsonb_object_agg(contract_id, state)` làm page/action đè nhau;
  revision phải monotonic toàn cục, không dùng `max()` của counter từng row. Audit tối thiểu có
  reason, evidence/reference, expiry/canary window và rollback ref; có immutability guard. Test bắt
  buộc: unauthorized, stale revision, hai transition đồng thời, rollback và audit UPDATE/DELETE bị
  từ chối. Sổ migration + gates như A4.
- [ ] **C3.2** `buildRegistry`/`toPageAgentTools`/`toLlmTools` lọc theo availability set; null/stale
  snapshot → expose 0 action rollout-controlled (fail closed); mọi capability được expose phải có
  rollout key hoặc exemption tường minh. Test cả execute path cho missing/stale/revoked snapshot,
  không chỉ test registry; admin UI hiển thị state, global revision và blocker.

### Task C4: Mở read/navigation theo batch domain + golden eval lite

- [ ] **C4.1** `tooling/copilot-golden-eval.json` pin C01–C30 (input, outcome kỳ vọng, tool path
  chấp nhận được, empty-state, forbidden). 2 lane trong
  `.e2e-fleet/specs/copilot-golden-readonly.spec.ts`: mock lane (safety/authz deterministic) +
  real-model lane pinned (chất lượng routing + latency, ghi min/median/p95). Ghi provider/model +
  build SHA mỗi run; KHÔNG yêu cầu entitlement/permission snapshot đầy đủ (Deferred).
- [ ] **C4.1a** Product owner chốt SLA số trước khi đánh PASS latency. Baseline 13/08:
  median 17,448 ms, mean 21,105 ms, p95 42,057 ms, max 55,913 ms; golden lane phải giữ ít nhất
  p50/p95/max và không coi HTTP 200 là đạt hiệu năng.
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

**Exit gate Phase C:** default-deny theo contract + flag; transition chỉ qua typed RPC với global
revision + append-only audit; autosave/icon-only/injection zero-mutation proof; 113 route accounted;
golden eval lite chạy 2 lane xanh trên batch đã mở.

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
