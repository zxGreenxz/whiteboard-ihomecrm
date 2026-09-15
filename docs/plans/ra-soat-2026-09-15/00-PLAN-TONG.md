# Plan tổng 15/09/2026 — kiến trúc · hiệu năng · CI/CD · logic · phân quyền · bug "tạo HĐ → phiếu hoa hồng treo"

Plan lớn chia thành **13 plan con độc lập** (A, B, C, D, E, F, G, H1, H2, H3, I1, I2, I3), mỗi plan con chạy ở một
session/worktree riêng, tập file **không giao nhau** (mục 12). Xong từng plan con thì báo lại cho tôi theo mẫu ở mục 14
để tôi rà tổng thể, regen artifact máy, apply migration, rồi push/promote (mục 13).

Sau khi plan này được duyệt, tôi sẽ tách mỗi plan con thành một file riêng
`docs/plans/ra-soat-2026-09-15/<A..I3>.md` (kèm luật chung mục 1 + bảng sở hữu) để mở session song song.

Ưu tiên chạy trước: **A** (bug người dùng đang gặp), **C**, **H1**, **H2**, **I1** (tiền/rò org), rồi phần còn lại.

## 0. Context

**Trạng thái phát hành**: `production` = `origin/main` = `f45cb81a`, Vercel READY (14/09 10:45). Không có gì chưa lên.
Checkout local `main` đang ở `a16bbd20`, **tụt 11 commit** so với origin/main → mọi worktree mới phải tạo từ `origin/main`.

**CI 40 lần gần nhất**: 3 lần đỏ, đều được commit kế tiếp vá trong <1 giờ, không phải flake:

| SHA | Job đỏ | Nguyên nhân | Vá bởi |
|---|---|---|---|
| d226d26f | security-gates: rò xuyên org | 1 dòng `invoice_audit_log.organization_id` NULL (bản ghi DELETE) | 5d9d3365 |
| 0d61f18b | quality-gates: lint ratchet | file CT01 mới có lỗi lint | e350928f |
| 6c344f8a (PR) | contract-gates + docs-freshness | hồ sơ rà soát + 5 số đếm tài liệu lệch | 1a2306fd |

Mẫu chung: `gate:truoc-push` **không phủ** security-gates / contract-gates / lint ratchet, nên đỏ chỉ lộ SAU push (repo GitHub Free không có required checks — known-gap). Chuỗi `fix(ci)` gần đây (91897a71, 5a836b01, aafa4aa0) cùng một gốc: gate đọc working tree thay vì index/commit. Đã có `|| true` ở golden-eval nhưng checker kế tiếp `readFileSync` không guard nên ENOENT vẫn làm đỏ → không nuốt lỗi. `continue-on-error`: 0 lần trong workflows.

**Điểm tốt đã xác minh (KHÔNG đụng)**: manualChunks + lazy 97 trang có gate bundle; auth cache sync; hub realtime ref-count + debounce có trần; `supabaseFetchAll` fail-closed; `ts-baseline.json = []`; 75 gate; `migrate:forward` lane; 14/15 finding audit hiệu năng 26/07 đã sửa thật.

## 1. Luật chung cho MỌI session con

- Tạo worktree từ `origin/main` (không từ local main): `git fetch origin && git worktree add "<đường dẫn>" -b <nhánh> origin/main`. Không dùng `.claude/worktrees/` (strict-islands hỏng ở đó — memory). Không `git stash`.
- Chỉ sửa file trong **bảng sở hữu** của plan con mình (mục 12). Cần file của plan khác → ghi vào báo cáo, không sửa.
- TDD: viết test đỏ trước (vitest `src/**/__tests__`), rồi sửa. `supabase.rpc` không bao giờ ném → test phải mock `{error}` chứ không `mockRejectedValue`.
- Trước commit: stage đúng file → `npm run gate:truoc-push`; và chạy tay các gate CI mà truoc-push không phủ: `npm run gate:error-swallow`, `node scripts/check-eslint-baseline.mjs`, `npm run gate:realtime-query-keys` (nếu đụng realtime), `npm run gate:rpc-cast`, `npx tsc --noEmit -p tsconfig.app.json`, `node scripts/check-strict-islands.mjs`. Đụng migration → thêm `gate:migration-provenance`, `gate:definer-acl`, `gate:stable-fn-locks`, `gate:sandbox-leak`.
- Migration: tên bằng `node scripts/tao-ten-migration.mjs <slug>`; idempotent; KHÔNG apply lên production trong session con — chỉ dry-run `npm run migrate:forward -- <file>`; apply là việc của tôi sau khi rà.
- Commit `fix(scope)/feat(scope)/chore(scope)` + trailer Claude; **không push**. Báo cáo theo mục 14.

## 2. Plan con A (P0) — Bug: tạo HĐ xong mở phiếu hoa hồng, đang điền thì form tự xoá rồi kẹt "Đang tải thông tin hợp đồng..."

### Chuỗi nguyên nhân (đã đọc code + catalog thật; chưa tái hiện trên trình duyệt)

1. `create_contract_v2` ghi trong 1 giao dịch vào `contracts`, `contract_customers`, `contract_services`, `income_expenses` + items (phiếu cọc), `invoices` + items, `rooms.status` — ≥5 bảng đều trong publication realtime.
2. Sau khi RPC trả về, `useContracts.ts:612-621` đã invalidate 9 key. **Rồi** hub `src/hooks/useRealtimeDataSync.ts` nhận event, debounce 800 ms (trần 2,4 s), `flushEntry` từng bảng: descriptor `src/hooks/realtime/finance.ts:67` khai **`["commission-prefill"]` bị invalidate khi `income_expenses` đổi**, kèm ~45 key khác của income_expenses, 13 key invoices, 9 key contracts, và `prefetchDomain()` cho 3 domain (list + stats + warm chunk). → cơn bão fetch thứ hai nổ 1–2,5 s SAU khi modal hoa hồng mở = "bị giựt".
3. `useCommissionPrefill` (`src/hooks/useCommissionVoucher.ts:111-201`) không có `staleTime` riêng → refetch, trả **object mới**; queryFn còn gọi **2 request tuần tự** (contracts rồi accounts).
4. `CommissionVoucherModal.tsx:129-156`: `useEffect(..., [open, prefill])` reset **toàn bộ** ô người dùng đang gõ (tên MG, số TK, ngân hàng, ảnh đã upload, số tiền) mỗi khi `prefill` đổi identity. `CurrencyInput` bỏ qua sync khi đang focus nên số tiền "nhảy về" lúc blur — đúng cảm giác giựt.
5. `useCommissionPrefill:134-137` **nuốt lỗi**: `if (error || !contract) return null`. Refetch lỗi (5xx/timeout giữa cơn bão, PGRST116) → `data = null` với trạng thái success, không retry, staleTime 60 s → `isLoading || !prefill` hiện **"Đang tải thông tin hợp đồng..." vĩnh viễn**, nút Tạo phiếu disable (`:581-583`). Vi phạm Contract §14.
6. Phụ: `useContractFormState` giữ `useRooms(selectedBuildingId)`/`useBuildingServices` sống sau khi đóng (effect reset chỉ chạy khi `open`), và `["rooms"]` bị invalidate → thêm fetch nền.

### Sửa (file sở hữu: `src/components/contracts/CommissionVoucherModal.tsx`, `src/hooks/useCommissionVoucher.ts`, `src/hooks/realtime/finance.ts` (chỉ dòng 67), test mới)

1. **Bỏ `["commission-prefill"]` khỏi descriptor `income_expenses`** (finance.ts:67). Prefill đọc contracts/rooms/buildings/customers/accounts — không đọc income_expenses; key này vào đây là nhầm. Chạy `npm run gate:realtime-query-keys` để gate không kêu key mồ côi.
2. `useCommissionPrefill`: `staleTime: Infinity`, `gcTime` ngắn (5 phút); **throw** lỗi thay vì `return null`; tách lookup accounts thành `Promise.all` với contracts (2 request song song, không tuần tự); cân nhắc dùng `useAccounts` đã có sẵn trong modal để chọn sổ mặc định phía client thay vì query thứ hai (bỏ được 1 round-trip).
3. Modal: effect seed chỉ chạy **một lần cho mỗi `contractId`** (ref `seededForContractId`), không phụ thuộc identity của `prefill`; các ô user đã gõ không bao giờ bị reset bởi refetch. Tách 3 trạng thái: `isPending` → "Đang tải…"; `isError` → thông báo lỗi + nút "Tải lại" (`refetch()`); có data → form. Nút "Bỏ qua" luôn bấm được.
4. Test vitest (`src/components/contracts/__tests__/CommissionVoucherModal.test.tsx` hoặc `src/hooks/__tests__/useCommissionVoucher.test.ts`): (a) refetch prefill với object mới KHÔNG xoá `brokerName`; (b) queryFn ném khi PostgREST trả `{error}`; (c) `isError` hiện nút tải lại; (d) test descriptor: `finance.ts` không còn `commission-prefill`.
5. E2E UI mới `.e2e-fleet/specs/contract-create-then-commission.spec.ts` (org DEMO, tự dọn): tạo HĐ qua UI → modal hoa hồng mở → gõ tên MG → chờ 4 s (qua trần debounce) → khẳng định giá trị còn nguyên, không có "Đang tải…", console không lỗi. Spec cũ `commission-voucher-per-section.spec.ts` chỉ test HTTP nên không bắt được bug này.

### Việc của tôi trước khi giao (đã ghi vào mục 13): tái hiện bằng Playwright MCP trên ptcrm.vercel.app với DEMO để có ảnh chụp "trước".

## 3. Plan con B (P1) — Hub realtime tự đánh lại mutation của chính mình + bão prefetch

Vấn đề chung (bug A là một ca): mỗi mutation local đã invalidate xong thì 0,8–2,4 s sau hub invalidate **lần hai** toàn bộ key của bảng + prefetch 3–4 domain, kể cả khi user không ở trang đó. Với `create_contract_v2` là 5 bảng → ~70 key + 6 RPC nặng.

File sở hữu: `src/hooks/useRealtimeDataSync.ts`, `src/lib/prefetchPages.ts`, `src/hooks/useContracts.ts` (chỉ khối onSuccess 612-621), `src/hooks/useInvoices.ts` (chỉ khối useAdjustInvoice 46-59), test `src/hooks/__tests__/useRealtimeDataSync.test.ts`.

1. **Cửa sổ "vừa tự ghi"**: hub giữ `Map<table, tsLastLocalMutation>`; mutation local gọi `markLocalWrite(tables[])` (helper export từ hub); event realtime tới trong ≤3 s sau mốc đó cho bảng ấy thì **chỉ** invalidate key đang `active`, **không** prefetchDomain. Đo bằng test: sau mutation, số `invalidateQueries` gọi ≤ 1 lần/bảng.
2. `prefetchDomain` trong `flushEntry` chỉ chạy khi route hiện tại **không** phải domain đó (đang ở trang đó thì invalidate đã refetch rồi) và cách lần prefetch trước ≥10 s (throttle theo domain).
3. `useCreateContract.onSuccess`: bỏ các key hub đã phủ, giữ đúng key màn đang mở; `useAdjustInvoice`: 17 prefix → invoice id + 3–4 aggregate.
4. Đo trước/sau bằng `__perfReport()` (src/lib/perfTrace.ts) trong E2E của plan A: số request Supabase trong 5 s sau tạo HĐ (mục tiêu giảm ≥50%).

## 4. Plan con C (P0) — Lỗi bị biến thành dữ liệu rỗng (đọc)

39 chỗ trong `src/hooks/**` theo mẫu `if (error) { console.error; return []; }` (useAreas:26, useFloors:28, useJobTypes:17, useMaterials:30, useIncomeExpenseTypes:83/125/161/202, useInvoices:325/1560, useMeters:166/208, useBuildingServices:27, useAssignablePeople:29 …) + `useMyPermissions.ts:29` trả `{}` → `RequirePermission.tsx:46-48` **đá user về `/`** khi RPC quyền lỗi tạm thời. Không có `QueryCache.onError` toàn cục.

File sở hữu: toàn bộ hook trong danh sách (liệt kê đầy đủ bằng `rg -n "if \(error\)[^\n]*\n[^\n]*return \[\]" src/hooks` lúc bắt đầu), `src/hooks/useMyPermissions.ts`, `src/components/auth/RequirePermission.tsx`, `src/app/providers/QueryProvider.tsx`, `scripts/check-error-swallow-ratchet.mjs` + `tooling/error-swallow-baseline.json`.

1. Đổi từng chỗ thành `throw error` (mẫu nhà: `useRooms.ts:39-43`). Với hook dropdown, component đọc `isError` để hiện "Không tải được — thử lại".
2. `useMyPermissions`: throw; `RequirePermission`: `isPending` → skeleton, `isError` → màn "Không tải được quyền" + nút thử lại, **không Navigate**.
3. `QueryProvider`: `new QueryCache({ onError })` toast một lần/queryKey (không toast cho query có `meta.silent`), gắn `reportBoundaryError`.
4. Mở rộng ratchet error-swallow để bắt mẫu `return []`/`return {}`/`return null` sau `if (error)` trong `src/hooks` và `src/lib` (test chứng minh chuỗi trong comment không làm gate xanh — luật §8).

## 5. Plan con D (P0/P1) — Query không giới hạn, dialog fetch sớm, N+1

File sở hữu: `src/components/income-expenses/IncomeExpenseForm.tsx`, `src/hooks/useRooms.ts`, `src/hooks/useRoomsWithContracts.ts`, `src/hooks/useMeters.ts`, `src/hooks/useLeads.ts`, `src/hooks/useMaterials.ts`, `src/hooks/useTenants.ts`, `src/hooks/useManagerSalary.ts` (khối 330-345), 11 dialog trong danh sách bên dưới, `src/contexts/OrganizationContext.tsx`, migration mới cho RPC bulk lương.

1. `IncomeExpensePage.tsx:844/850/856` mount 3 `<IncomeExpenseForm open={false}>` mà form không early-return → `useContractsLegacy(undefined)` quét toàn bộ contracts (`select *` + count exact, không range) ngay khi mở /thu-chi. Sửa: `if (!open) return null` ở đầu form (giữ hook order bằng cách tách `IncomeExpenseFormInner`), `useContractsLegacy` thêm `enabled: open && !!roomId`.
2. `useRooms` (key `["rooms"]`, không range, cap 1000 im lặng, dùng ở 5 dialog) → `fetchAllRows` + tiebreaker `id`; 5 call-site thêm `enabled: open`.
3. `useRoomsWithContracts` (join 4 tầng, gọi org-wide từ RoomsPage:87), `useMeters` (view không filter), `useLeads`, `useMaterials`, `useTenants` → `fetchAllRows` hoặc `.range()` (mẫu `useMeterReadings.ts:200-204`).
4. `useManagerSalary.ts:336-339` N+1 `v5_month_money` theo từng staff → RPC `v5_month_money_bulk(p_users uuid[], p_month)` (migration mới, SECURITY DEFINER tự kiểm quyền như bản đơn) + hook dùng 1 request.
5. 11 dialog fetch trước khi mở → thêm `{ enabled: open }` (hook đã hỗ trợ): ManageAreasDialog:37, AssetMaintenanceDialog:38, AssetMovementDialog:37-38, CreateAssetDialog:44-45, EditAssetDialog:48, BuildingFormDialog:67, ContractImportExportDialog:85, TransferRoomDialog:55/61, CreateDepositDialog:133, IncomeExpenseImportDialog:156, ExcelInvoiceDialog:61.
6. `OrganizationContext.selectOrganization` không đụng queryClient → 741/761 key giữ cache org cũ khi đổi công ty → gọi `queryClient.removeQueries` cho mọi key ngoài `['auth', …]` (mẫu `authQueryCache.ts:121-136`). Test bất biến.

## 6. Plan con E (P1) — Render: ảo hoá + memo cho 3 màn nặng nhất

File sở hữu: `src/pages/assets/AssetsPage.tsx`, `src/hooks/useAssets.ts`, `src/pages/rooms/RoomsPage.tsx`, `src/components/rooms/RoomListTable.tsx`, `src/pages/deposits/DepositsPage.tsx`, `src/pages/leads/LeadsPage.tsx`, `package.json` (thêm `@tanstack/react-virtual`, ghim exact), `tooling/bundle-baseline.json` (regen).

1. Hiện tại **0 virtualization, 2 `React.memo` toàn app**, 187 `.reduce` trong render (~15 có useMemo). Assets: `fetchAllRows` toàn bảng rồi reduce 2 lần ngoài useMemo mỗi phím gõ (`AssetsPage:107-113`).
2. Assets: tổng bằng RPC `SUM` server + phân trang server; danh sách ảo hoá. Rooms: `RoomListTable` memo hàng + ảo hoá; Deposits: 4 danh sách `.map` (556/618/696/887) ảo hoá phần ≥50 dòng, tổng 245-248 vào useMemo. Leads kanban: phân trang cột.
3. Đo bằng React Profiler/`__perfReport()` trước-sau, ghi số vào commit. Kiểm bundle: `npm run gate:bundle` (baseline `soTrangLazy: 99` đang lệch 2 so với thực tế 97 — regen `--write` sau build sạch và ghi delta).

## 7. Plan con F (P0/P1) — Database (đã đối chiếu catalog production 15/09)

File sở hữu: migration mới (mỗi mục một file), `contracts/surfaces/*` regen, `docs/generated/*` regen.

1. **P0 `generate_contract_number()` race** (đã đọc thân hàm thật): `SELECT COUNT(*)+1 FROM contracts WHERE user_id = NEW.user_id AND EXTRACT(YEAR …)` trong BEFORE INSERT, không lock, `idx_contracts_contract_number` KHÔNG unique, và `create_contract_v2` **không** truyền `contract_number` nên mọi HĐ đều đi qua đây. Hai người tạo HĐ cùng lúc → trùng số. Sửa: bảng đếm `app_private.contract_number_counters(organization_id, year, last_no)` lấy `FOR UPDATE`, hàm đổi khoá theo org; backfill kiểm trùng hiện có (query đọc trước, báo tôi nếu có trùng); unique partial `(organization_id, contract_number) WHERE deleted_at IS NULL` chỉ tạo khi 0 trùng.
2. **P1 `update_room_status_on_contract_change`**: invoker-rights, không `search_path` (xác nhận trên prod). `UPDATE rooms` chịu RLS người gọi → 0 dòng im lặng. `create_contract_v2` đã tự `UPDATE rooms SET status='OCCUPIED'` (dòng 1042) nên đường tạo an toàn; đường UPDATE status (thanh lý/chuyển) thì không. Sửa: SECURITY DEFINER + `SET search_path = pg_catalog, public` + `IF NOT FOUND THEN RAISE` ; revoke anon/authenticated (luật memory REVOKE FROM PUBLIC không cắt anon).
3. **P1 index**: thiếu `contracts(organization_id, status)` composite; partial `WHERE deleted_at IS NULL` cho hot filter; `invoice_audit_log(invoice_id)`. (Đã có `contracts_one_active_per_room_uq` partial nên `(room_id,status)` KHÔNG cần.) Tạo `CONCURRENTLY` ngoài transaction lane — cần đường riêng, ghi rõ trong migration header.
4. **P2** `get_my_assignments()` grant `anon` (20260518000051:49-50) → REVOKE. `reservation_settlement_vouchers` trong publication nhưng không ai nghe → bỏ khỏi publication hoặc nối descriptor (chọn bỏ, ghi lý do).
5. **Không làm** (agent suy đoán sai so với catalog): không có trigger ma `trigger_update_room_bed_status`; policy SELECT contracts đã là v3 (`buildings_for_v3`, `accessible_*`), không còn 4 thế hệ policy cũ; `update_asset_status_on_contract_change` là no-op nhẹ.
6. Mỗi migration: idempotent, chạy được trên DB rỗng (Restore Drill), dry-run `migrate:forward`, `gate:definer-acl`, `gate:stable-fn-locks`, `gate:migration-provenance`. Kiểm bằng `git diff` md5 thô trước CREATE OR REPLACE (memory).

## 8. Plan con G (P1) — CI/CD, quy trình, vệ sinh repo

File sở hữu: `scripts/kiem-nhanh-truoc-push.mjs`, `.gitignore`, `.github/workflows/ci-gates.yml` (chỉ phần paths-filter), `tooling/known-gaps.yaml`, `scripts/check-known-gaps.mjs` (chỉ comment), `docs/engineering/PROJECT_CONTRACT.md` (nếu đổi quy trình).

1. `gate:truoc-push` thêm bước **tuỳ chọn nhưng mặc định bật** chạy các gate CI hay đỏ sau push: lint ratchet (`check-eslint-baseline.mjs`), doc-counts (`check-doc-counts` sau `git add`), contract-gates (known-gap hết hạn, review record), và bước `measure-org-leak` khi có credential (cảnh báo ⚠ nếu thiếu, không giả xanh). Khi staged diff đụng `supabase/migrations/**` mà offline → **đỏ**, không ⚠.
2. `.gitignore`: `*.tmp.json`, `*.dc.html`, `/*.png` ở gốc, `.codex/`, `/chitiethoadon/`, `/ch-nh-s-a-giao-di-n-h-p-ng/`, `/*-snapshot.md`. 14 file rác hiện tại ở gốc checkout chính: **chủ quyết xoá** — G xoá đúng danh sách (không `git clean -fd` trần), ghi danh sách đã xoá vào báo cáo.
3. `.claude/settings.local.json` đang **được track** (commit ea89dd87) dù trong .gitignore; nội dung chỉ là allowlist permission, không có token → `git rm --cached` + commit `chore`. `.claude/settings.json` mới là `{}` — bỏ hoặc commit rỗng có chủ đích.
4. `ci-gates.yml` không có path filter: PR chỉ docs vẫn chạy 12 job. Thêm `dorny/paths-filter` (ghim SHA) ở `preflight` để bỏ qua job không liên quan; **không** bỏ qua security-gates cho thay đổi `supabase/**` hay `src/**`.
5. Known-gap `copilot-golden-eval-real-lane-daily-quota` hết hạn **15/10/2026** → external-controls sẽ đỏ từ 16/10. **Chủ quyết để sau** — G không đổi, chỉ ghi nhắc trong báo cáo. Thêm known-gap mới cho H3.5 (`v5_recompute_streak` replay, hạn 31/12/2026).
6. Sửa comment lỗi thời ở `known-gaps.yaml:20` và `check-known-gaps.mjs:4` ("đang dùng continue-on-error" → "gate tồn tại để không ai thêm lén").
7. Đồng bộ checkout: `git pull --ff-only` local main lên f45cb81a (việc của tôi, không phải session con).

## 9. Plan con H — Logic nghiệp vụ (tiền) — chia 3 session H1/H2/H3, mỗi session một cụm migration riêng

Nguồn định nghĩa hiện hành = `supabase/baseline/schema.sql` (dump prod 06/08) + migration > 20260806. Đã đối chiếu catalog prod 15/09 cho các mục đánh dấu ✔. Mọi RPC tiền: DROP rồi CREATE khi đổi chữ ký (memory), VOLATILE nếu có khoá dòng, revoke anon + authenticated riêng, `gate:reconcile-money` + `-v2`, test đột biến `scripts/dot-bien.mjs` cho invariant.

### H1 — Hoá đơn (file sở hữu: migration `hoa_don_*`, `src/lib/invoiceUtils.ts`, `src/hooks/useInvoices.ts` phần cancel, test)
1. **P0 ✔ `cancel_invoice_v1` / `cancel_invoice_with_credit_v1` không guard status/paid_amount ở DB** — `canCancelInvoice` client là hàng rào duy nhất (memory đã ghi). Đưa luật `status IN ('DRAFT','APPROVED') AND coalesce(paid_amount,0)=0` vào RPC; super admin đi đường force riêng đã có. Test: gọi thẳng PostgREST huỷ hoá đơn PAID → 42501/P0001.
2. **P0 ✔ `previous_debt_sources` không kiểm org/contract** khi `recompute_invoice_for_id` cộng nợ kéo (`20260731070000:3699-3712`): carrier bất kỳ (kể cả org khác) có thể "trả hộ" hoá đơn nạn nhân → PAID. Sửa: `create_invoice_v1`/`update_invoice_v1` validate từng `src.id` cùng `organization_id` + cùng `contract_id` với carrier, cap theo nợ còn lại lúc phát hành; recompute thêm predicate `carrier.organization_id = invoice.organization_id`. Backfill: query đọc tìm carrier lệch org (báo tôi số lượng trước).
3. **P0 `create_invoice_v1`/`update_invoice_v1`/`create_invoice_with_credit_v1` tin `p_subtotal` client** (memory đã ghi "chưa vá"; `20260908051659:285-299`). Re-sum `p_items` server như `adjust_invoice_v2` (`20260912065909:235-238`), lệch → P0001. Kèm test property ở `src/lib/__tests__/invoiceEntry*.test.ts` chứng minh client gửi đúng.
4. **P0 `record_invoice_collection_v5` nhận ngày thu tương lai** trong khi reverse (13/09) đã chặn → `IF p_collection_date > public.org_today_v1(v_org) THEN RAISE`.
5. **P1 `PARTIAL_PAID` không bao giờ đạt được khi quá hạn** (nhánh OVERDUE đứng trước, `:3720-3737`) và doc 07 nói OVERDUE suy ở lớp đọc — thực tế ghi xuống. Quyết định: giữ ghi xuống nhưng đổi thứ tự để `OVERDUE` chỉ khi `paid=0`, thêm cột suy `is_overdue` cho báo cáo; sửa doc.
6. **P1 LIFO guard `reverse_invoice_collection_v5`** so `paid_amount` gồm cả nợ kéo suy ra → hoá đơn vừa thu vừa kéo nợ không bao giờ hoàn tác được. So với `paid_amount − carried`.
7. **P2** nhánh xoá nợ <10 000 đ legacy không ghi `rounding_amount` (`:3723-3729`) → khoanh theo cutoff ngày; revoke `record_invoice_payment_v2/_v3` khỏi authenticated; `generate_invoice_number_v2` dùng `NOW()` thay năm org; `org_today_v1(NULL)` → truyền org của dòng (`:3725/3732/3736`); gộp 3 bản "làm tròn 1000" (round_invoice_total_v1 / create_contract_v2 inline / firstInvoiceBuilder chưa làm tròn) về một helper + test ≤999 đ lệch màn xác nhận.

### H2 — Cọc & thanh lý (file sở hữu: migration `coc_thanh_ly_*`, `src/lib/terminationSettlement.ts`, `src/hooks/useContracts.ts` khối termination, test)
1. **P0 `settle_previous_debt_sources` ghi tay `contracts.deposit_paid`** (`baseline:91204`), không kiểm org, mâu thuẫn nguồn sự thật `contract_deposit_paid_derived` (memory: deposit_paid là dẫn xuất). Xoá nhánh; nợ cọc kéo phải là voucher DEPOSIT thật.
2. **P0 `recompute_contract_deposit_paid` early-return khi `v_count_any = 0`** (`baseline:84612-84640`) → gỡ liên kết voucher cuối thì `deposit_paid` cũ thành tiền hoàn thật. Bỏ early return, luôn `SET deposit_paid = contract_deposit_paid_derived(id)`.
3. **P0 `approve_contract_termination_v1`** (UI vẫn gọi, `useContracts.ts:1172`): trả `refund_amount` GENERATED từ `total_deposit` chứ không từ cọc đã nhận (`013:84-95`); item hoàn không có `amount` (sống nhờ trigger ghi đè — xem H3.1); trả phòng AVAILABLE vô điều kiện (`:755`, mất RESERVED của khách kế). Sửa cả ba: cap theo `contract_deposit_paid_derived`, truyền `amount`, dùng predicate NOT EXISTS của trigger. **Lưu ý plan 2 hoàn cọc: đợt 4 "khoá đường thanh lý cũ" chủ đã TẠM DỪNG 28/08 (memory) → H2.3 chỉ vá an toàn, KHÔNG khoá đường cũ.**
4. **P1 `terminate_contract_move_out_impl` nuốt lỗi insert audit** (`20260902104355:533-548`, EXCEPTION WHEN OTHERS) → bỏ bắt lỗi, để giao dịch fail (anh em `transfer_room` đã sửa đúng mẫu này).
5. **P1 `update_room_status_on_contract_change`** — trùng F.2; **F sở hữu**, H2 không đụng.

### H3 — Phiếu thu chi & ngày (file sở hữu: migration `phieu_*`, `src/hooks/income-expenses/statusMutations.ts`, test)
1. **P0 ✔ `income_expense_items.quantity` là `integer`** và trigger `auto_calc_item_amount` ghi đè `amount := quantity*unit_price` vô điều kiện (BEFORE INSERT OR UPDATE) → số lượng lẻ (kWh, m³, người) bị làm tròn rồi tổng phiếu sai; writer truyền `amount` bị bỏ. Sửa: `quantity numeric(15,4)` + `NEW.amount := COALESCE(NEW.amount, quantity*unit_price)` và assert khớp khi cả hai có. Backfill: đọc trước có dòng nào `amount <> quantity*unit_price` (báo số).
2. **P1 ✔ `approve_voucher` cho người tạo tự duyệt phiếu của mình** (`ie.user_id = auth.uid()` OR …; granted authenticated; vẫn là fallback cho org chưa canonical — `statusMutations.ts:158`). Bỏ vế creator; org legacy đi `approve_income_expense_v1`. `unapprove_voucher`: thêm `FOR UPDATE` + CAS `p_expected_approval_version` + bump `approval_version`.
3. ~~`create_commission_voucher` lệch bậc~~ — **chủ quyết giữ như hiện tại (mục 15)**, không sửa.
4. **P1 `accounts_with_balance_v2` security_invoker** đọc thẳng từ `useAccounts.ts:104` → chuyển sang RPC definer `list_cashbooks_with_balance_v2`.
5. **P2** `CURRENT_DATE` còn sót: `transfer_room`/`transfer_contract(_impl)` default, `get_room_cash_lifecycle_v1`, `payments.payment_date` default, `cancel_income_voucher_v1` (`GREATEST(LEAST(org_today, CURRENT_DATE))` kéo lùi ngày 0–7h) → `org_today_v1(<org>)`. `v5_recompute_streak` replay từ 01/09 mỗi tick + `v_sunday` không cap → **chủ quyết để sau (mục 15)**; H3 chỉ ghi known-gap qua G.

### Đã xác minh ĐÚNG, không đụng (từ agent + catalog): `adjust_invoice_v2` (re-sum, PT409, idempotency); `create_contract_v2` tự tính tổng; `record_invoice_collection_v5` CAS `p_expected_paid_amount`; `contract_deposit_paid_derived`; `generate_invoice_number_v2` có advisory lock; `distribute_shareholder_profit_v1` + `_profit_write_close_v2_base`; `income_expenses_check_lock` FOR KEY SHARE; freeze payload phiếu V5; 3 lớp chống trùng hoa hồng; `prorateCalculation.ts`; `buildStructuredLines`.

## 10. Plan con I — Phân quyền công ty / người dùng — chia 3 session I1/I2/I3

Chuỗi quyền hiện tại: JWT → (a) RLS `*_select_rbac` PERMISSIVE + `*_org_boundary` / `*_hide_sandbox_admin` RESTRICTIVE; (b) RPC definer gọi `app_private.authorize_tenant_action_v3` → `authorized_scope_v3(key, org)`; (c) FE `get_my_permissions()` → `canUse` / `RequirePermission`. Ba lớp **lệch nhau** ở 5 chỗ (D1–D5 dưới).

### I1 — Rò xuyên org qua RPC lương + cấu hình lương toàn cục (file sở hữu: migration `luong_authz_*`, `src/hooks/useManagerSalary.ts` phần gọi RPC — phối hợp với D.4 bulk: **D chỉ tạo RPC bulk, I1 thêm guard vào cả bản đơn lẫn bulk**; đơn giản nhất: I1 sở hữu luôn D.4)
1. **P0 ✔ `v5_month_money(p_user, p_month)` / `v5_n_chuan`**: SECURITY DEFINER, grant authenticated, **không có auth.uid()/scope check** (catalog xác nhận) → user bất kỳ đọc lương bất kỳ ai ở org khác bằng UUID. Guard: `p_user = auth.uid()` hoặc `authorized_scope_v3('salary.view', org_of_staff)`; test harness JWT DEMO gọi p_user THẬT → 42501.
2. **P0 ✔ `get_salary_v5_config()` / `vn_workdays`**: lấy rule của super admin đầu tiên → mọi org tính lương bằng hằng số của THẬT, và ai cũng đọc được. Khoá theo `organization_id` (bảng `salary_bonus_rules` đã có `_org_boundary`), thêm `p_org` + validate. **Đụng V5.1 lương (memory: khiên 3 lớp, hiệu lực 01/09) — chỉ đổi cách chọn org, KHÔNG đổi hằng số.**
3. `test-cross-tenant.mjs` (job `cross-tenant-isolation`) hiện chỉ có 20 ca Network Center → thêm ca salary/invoices/income_expenses/contracts/customers, và chạy trên PR chứ không chỉ push main.

### I2 — Mô hình quyền UI ↔ RPC (file sở hữu: migration `get_my_permissions_v2_*`, `src/hooks/useMyPermissions.ts` (phối hợp C: **C sửa throw; I2 sửa chữ ký/cache key** — thứ tự gộp C trước I2), `src/lib/permissionPages.ts` (`canUse`), `src/components/auth/RequirePermission.tsx` (chỉ phần buildingId), test)
1. **P1 D1/D2** `get_my_permissions()` không có tham số org, gộp mọi org, vứt `scope_type/building_ids` (`20260725220000:44-56,164-176`) → nhân viên có quyền duyệt ở 1 toà thấy nút Duyệt/Thu/Chi ở mọi toà rồi ăn lỗi RPC; chủ nhiều org thấy hợp của các org. Sửa: `get_my_permissions_v2(p_org uuid)` trả `{resource:{action:{org_wide, building_ids}}}`; `canUse(perms, module, action, buildingId?)`; cache key kèm `selectedOrganizationId`; giữ v1 song song một đợt rồi revoke.
2. **P2** xoá đoạn comment lỗi thời `useMyPermissions.ts:13-18` ("record_payment không có hậu kiểm DB" — sai, `record_invoice_payment_v4` đã kiểm).
3. Gate mới `gate:definer-body-authz` (`scripts/check-definer-body-authz.mjs` + test): definer đụng bảng tiền/PII mà grant authenticated **và** thân hàm không có primitive scope (`authorized_scope_v3|can_access_building|can_do_on_building|accessible_building_ids|auth.uid()`) → đỏ; allowlist có lý do. Đây là gate đóng lớp lỗi I1.

### I3 — Org NULL, vai chủ công ty, tạo toà (file sở hữu: migration `org_autofill_strict_*`, `chu_cong_ty_system_key_*`, `buildings_insert_v3_*`; `src/app/routes/publicRoutes.tsx` + `src/hooks/useAuth.ts` phần signUp)
1. **P1 `public._autofill_org()` gán hằng org THẬT khi không suy ra được** (`20260713121000:46`, `COALESCE(v, PROD)`, không guard `count=1`) trên 27 bảng tiền/PII → chủ (member THẬT+DEMO) tạo dòng ở DEMO có thể rơi vào sổ THẬT. Thay bằng `app_private.autofill_org_strict()` (fail-closed) trên 27 trigger; gắn thêm cho các bảng còn nhận NULL có writer đã tìm thấy: `notifications` (award_job_bonus, record_payment_gps, request_paid_leave), `jobs` (complete_inspection), `public_room_share_tokens`. (Memory: `autofill_org_zalo` đòi cột user_id — kiểm cột trước khi gắn.)
2. **P1 ✔ vai "Chủ công ty" `system_key NULL`** không lọt `is_org_owner_v1` (memory) → migration dữ liệu `UPDATE organization_roles SET system_key='TENANT_OWNER', is_system=true WHERE name='Chủ công ty'` + unique partial 1 vai/org; 5 hàm khác còn so tên chuỗi (`20260731011000:1090-1100`) → dùng system_key.
3. **P1 Chủ công ty không tạo được toà** (memory; `buildings_insert_rbac` đòi `staff_assignments`) → thêm `OR authorized_scope_v3('buildings.create', organization_id).org_wide`; sau đó tạo toà phải sinh `authorization_scope` (memory: toà mới vô hình trong hộp thoại phân quyền) — trigger AFTER INSERT buildings.
4. **P1 `/register` công khai** tạo tài khoản mồ côi (`handle_new_user` insert profiles không org) → **chủ quyết tắt**: I3 bỏ route + hook signUp + test route-guards; tắt signup ở Supabase Auth là việc của tôi sau khi gộp; giữ `admin-create-user`.
5. **P1** `profiles_select_super_admin USING (is_user_super_admin(id))` cho mọi user đọc profile super admin → đổi `USING (is_super_admin())`. `network_center_list_fleet_v1/get_building_v1` join `network_site_settings` không lọc org → thêm `organization_id = ANY(my_org_ids())`. `can_access_building` mất loại trừ demo-building so với `buildings_for_v3` (D4) → đồng bộ.
6. **P2** Copilot quota/kill-switch toàn cục (`ai_copilot_settings` singleton, cap global) → cap theo org; `get_my_assignments()` grant anon → REVOKE (trùng F.4, **F sở hữu**); `org-boundary-inventory.json` cũ 16 ngày → regen; **storage**: agent báo P0 nhưng catalog prod ĐÃ có `storage_pii_org_isolation` RESTRICTIVE SELECT qua `can_read_storage_object_v1` + `storage_object_links` → chỉ cần kiểm `supabase/baseline/schema.sql` có đủ policy đó và mọi object PII đều có dòng `storage_object_links` (query đếm object thiếu link; thiếu = fail-closed không đọc được, không rò).

### Đã xác minh ĐÚNG (không đụng): `authorized_scope_v3` (không shortcut super admin, DENY toà thắng org_wide từ 08/09); `buildings_for_v3` tự kiểm ORG_ISOLATION_V1; `record_invoice_payment_v4` chuỗi đầy đủ; Copilot tool chạy bằng session user + nonce server; `llm-proxy` đòi `x-organization-id`; `admin-create-user`; Zalo worker scope-guard; realtime: mọi bảng publish đều có RLS + org_boundary, hub bỏ payload; sandbox/demo hiding đủ.

## 11. Việc KHÔNG làm trong đợt này (ghi để không ai tự ý)

- Không đổi `retry: 1` toàn cục sang `retryOnlyConcurrency` cho mutation (đụng đường tiền, cần review riêng — ghi vào known-gaps nếu chưa có).
- Không flip `strict: true` toàn repo; không nâng baseline.
- Không đụng Copilot, Zalo, Network Center trừ khi plan H/I chỉ ra P0.
- Không xoá worktree `codex-worktrees/*` (110 nhánh của phiên khác).

## 12. Bảng sở hữu file (chống xung đột khi chạy song song)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| A | CommissionVoucherModal.tsx, useCommissionVoucher.ts, realtime/finance.ts (dòng 67), spec E2E mới | useRealtimeDataSync.ts |
| B | useRealtimeDataSync.ts, prefetchPages.ts, useContracts.ts (onSuccess 612-621), useInvoices.ts (46-59) | finance.ts |
| C | 39 hook nuốt lỗi, useMyPermissions, RequirePermission, QueryProvider, ratchet error-swallow | useRooms.ts (D sở hữu) |
| D | IncomeExpenseForm, useRooms, useRoomsWithContracts, useMeters, useLeads, useMaterials, useTenants, useManagerSalary (330-345), 11 dialog, OrganizationContext, migration v5_month_money_bulk | AssetsPage (E) |
| E | AssetsPage, useAssets, RoomsPage, RoomListTable, DepositsPage, LeadsPage, package.json, bundle-baseline | hooks của D |
| F | migration mới ×4–5, surfaces/generated regen | src/** |
| G | kiem-nhanh-truoc-push.mjs, .gitignore, ci-gates.yml (paths), known-gaps.yaml, check-known-gaps.mjs | src/** |
| H1 | migration `hoa_don_*`, invoiceUtils.ts, useInvoices.ts (khối cancel), test | recompute deposit (H2) |
| H2 | migration `coc_thanh_ly_*`, terminationSettlement.ts, useContracts.ts (khối termination 1150-1200), test | update_room_status (F) |
| H3 | migration `phieu_*`, statusMutations.ts, useAccounts.ts (dòng 104 → RPC), test | create_commission_voucher amount (chờ chủ) |
| I1 | migration `luong_authz_*` (guard v5_month_money/v5_n_chuan/config + RPC bulk `v5_month_money_bulk`), useManagerSalary.ts (330-345), scripts/test-cross-tenant.mjs | — (D.4 chuyển sang I1) |
| I2 | migration `get_my_permissions_v2_*`, permissionPages.ts (canUse), RequirePermission.tsx (buildingId), scripts/check-definer-body-authz.mjs + test, package.json (1 dòng gate) | useMyPermissions.ts phần throw (C) |
| I3 | migration `org_autofill_strict_*`, `chu_cong_ty_system_key_*`, `buildings_insert_v3_*`, publicRoutes.tsx, useAuth.ts (signUp) | — |

Mọi session tạo migration đều đụng `supabase/migration-provenance.json` + `docs/generated/*` khi chạy `provenance:generate` → **KHÔNG commit hai file máy sinh đó trong session con**; tôi regen một lần sau khi gộp.

Thứ tự gộp khi về: **A → C → I2 → D → B → E** (frontend), rồi **F → H1 → H2 → H3 → I1 → I3** (migration, tôi dry-run + apply từng file, backup trước), G độc lập. C và D cùng đụng "hook đọc lỗi" nên D không sửa phần `if (error)` của hook mình sở hữu — để C làm; D chỉ sửa range/enabled.

## 15. Quyết định của chủ (15/09/2026)

1. H3.3 hoa hồng môi giới lệch bậc: **giữ như hiện tại** (cho tạo, không autopay) → **bỏ mục H3.3 khỏi plan**.
2. H3.5 `v5_recompute_streak` materialize: **để sau** → ghi vào `tooling/known-gaps.yaml` (G sở hữu), không sửa đợt này.
3. G.5 known-gap golden-eval hết hạn 15/10: **để sau** → G chỉ ghi nhắc trong báo cáo, không đổi hạn.
4. G.2 14 file rác ở gốc: **xoá** (G thực hiện `git clean` đúng danh sách, kèm .gitignore).
5. I3.4 `/register`: **tắt** (bỏ route + tắt signup ở Supabase Auth — phần tắt Auth là việc của tôi qua Management API sau khi I3 gộp).

## 16. Cách mở nhiều session chạy song song

Nguyên tắc: **một session = một worktree = một nhánh**, tất cả tạo từ `origin/main` (đã fetch). Không dùng chung thư mục checkout chính (index chung là bẫy — memory "phiên song song").

Sau khi plan được duyệt, tôi làm bước 1–2; bạn làm bước 3.

1. Tôi ghi 13 file plan con vào `docs/plans/ra-soat-2026-09-15/<A|B|C|D|E|F|G|H1|H2|H3|I1|I2|I3>.md` và commit lên `main` (chỉ tài liệu), để mọi worktree tạo sau đều có sẵn.
2. Tôi tạo sẵn 13 worktree + nhánh bằng một script (PowerShell), đường dẫn không dấu cách:

```powershell
git fetch origin
$plans = 'A','B','C','D','E','F','G','H1','H2','H3','I1','I2','I3'
foreach ($p in $plans) {
  git worktree add "C:\Users\Nguyen Tam\rasoat-worktrees\$p" -b "rasoat/$p" origin/main
}
```

   Mỗi worktree cần `node_modules`: dùng junction về checkout chính (memory "push-qua-worktree"): 
   `New-Item -ItemType Junction -Path "C:\Users\Nguyen Tam\rasoat-worktrees\$p\node_modules" -Target "C:\Users\Nguyen Tam\whiteboard-ihomecrm-main\node_modules"` — **gỡ junction trước khi xoá worktree**.
3. Bạn mở 13 cửa sổ VS Code (hoặc terminal) — mỗi cửa sổ mở đúng một thư mục worktree — rồi trong mỗi cửa sổ chạy Claude Code và dán câu lệnh mở đầu:

```
Đọc docs/plans/ra-soat-2026-09-15/<X>.md và thực hiện đúng plan đó. Chỉ sửa file trong bảng sở hữu của plan <X>. Không push. Xong thì báo cáo theo mẫu mục 14.
```

   Số session cùng lúc: máy này chạy vitest đầy tải hay đỏ giả ở 5 bài DOM nặng (memory) → khuyến nghị **tối đa 5–6 session** một lượt: đợt 1 = A, C, H1, H2, I1; đợt 2 = D, F, I2, I3; đợt 3 = B, E, G, H3.
4. Cách thay thế nếu bạn không muốn mở tay: tôi tự phái mỗi plan con thành một agent nền có `isolation: worktree` ngay từ session này (chạy song song, kết quả trả về cho tôi rà). Nói "tự phái" là tôi làm; mặc định tôi dựng worktree cho bạn mở tay như bước 3.
5. Khi session con báo xong: tôi vào worktree đó rà diff, chạy gate, rebase lên `origin/main`, gộp theo thứ tự mục 12, rồi mới push và promote. Không session con nào push.

## 13. Kiểm chứng tổng (tôi làm sau khi gộp)

1. Tái hiện bug A trên ptcrm (DEMO, Playwright MCP) trước và sau: tạo HĐ → gõ tên MG → chờ 4 s → giá trị còn; không "Đang tải…" kẹt; console 0 lỗi; `__perfReport()` số request 5 s sau tạo HĐ giảm ≥50%.
2. `npx vitest run src scripts/__tests__` xanh (5 bài DOM nặng có thể đỏ giả khi đầy tải → chạy riêng, memory).
3. `npx tsc --noEmit -p tsconfig.app.json`, `npm run typecheck:baseline`, strict-islands, eslint baseline, `gate:bundle`, `gate:realtime-query-keys`, `gate:error-swallow`, `gate:rpc-cast`.
4. E2E fleet: `commission-voucher-per-section`, spec mới của A, `accounting-chain`, `network-center-hardening` (đã có sẵn), headless, DEMO.
5. Migration F: dry-run lane, Restore Drill local (docker postgres 17.6), rồi `migrate:forward --apply` từng file với backup; `gate:sandbox-leak` = 0 bảng rò.
6. Push `HEAD:main` → chờ CI Gates xanh cho đúng SHA (`promote:production -- --sha <40 ký tự>`) → `--apply` → kiểm Vercel READY + bundle hash.

## 14. Mẫu báo cáo từ session con về cho tôi

```
Plan: <A..I> · Nhánh/worktree: … · Base: origin/main@<sha>
Đã sửa: <file:line, vì sao>
Test đỏ→xanh: <tên test, lệnh>
Gate đã chạy (kết quả thật, dán dòng cuối): truoc-push / eslint-baseline / tsc / strict-islands / <gate khác>
Chưa xác minh: …
Cần plan khác/chủ quyết: …
Commit: <sha> (chưa push)
```
