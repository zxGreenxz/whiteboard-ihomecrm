# Plan con A — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| A | CommissionVoucherModal.tsx, useCommissionVoucher.ts, realtime/finance.ts (dòng 67), spec E2E mới | useRealtimeDataSync.ts |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

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

## Luật chung (bắt buộc đọc)

- Tạo worktree từ `origin/main` (không từ local main): `git fetch origin && git worktree add "<đường dẫn>" -b <nhánh> origin/main`. Không dùng `.claude/worktrees/` (strict-islands hỏng ở đó — memory). Không `git stash`.
- Chỉ sửa file trong **bảng sở hữu** của plan con mình (mục 12). Cần file của plan khác → ghi vào báo cáo, không sửa.
- TDD: viết test đỏ trước (vitest `src/**/__tests__`), rồi sửa. `supabase.rpc` không bao giờ ném → test phải mock `{error}` chứ không `mockRejectedValue`.
- Trước commit: stage đúng file → `npm run gate:truoc-push`; và chạy tay các gate CI mà truoc-push không phủ: `npm run gate:error-swallow`, `node scripts/check-eslint-baseline.mjs`, `npm run gate:realtime-query-keys` (nếu đụng realtime), `npm run gate:rpc-cast`, `npx tsc --noEmit -p tsconfig.app.json`, `node scripts/check-strict-islands.mjs`. Đụng migration → thêm `gate:migration-provenance`, `gate:definer-acl`, `gate:stable-fn-locks`, `gate:sandbox-leak`.
- Migration: tên bằng `node scripts/tao-ten-migration.mjs <slug>`; idempotent; KHÔNG apply lên production trong session con — chỉ dry-run `npm run migrate:forward -- <file>`; apply là việc của tôi sau khi rà.
- Commit `fix(scope)/feat(scope)/chore(scope)` + trailer Claude; **không push**. Báo cáo theo mục 14.

## Việc KHÔNG làm

- Không đổi `retry: 1` toàn cục sang `retryOnlyConcurrency` cho mutation (đụng đường tiền, cần review riêng — ghi vào known-gaps nếu chưa có).
- Không flip `strict: true` toàn repo; không nâng baseline.
- Không đụng Copilot, Zalo, Network Center trừ khi plan H/I chỉ ra P0.
- Không xoá worktree `codex-worktrees/*` (110 nhánh của phiên khác).

## Quyết định của chủ đã chốt (15/09/2026)

1. H3.3 hoa hồng môi giới lệch bậc: **giữ như hiện tại** (cho tạo, không autopay) → **bỏ mục H3.3 khỏi plan**.
2. H3.5 `v5_recompute_streak` materialize: **để sau** → ghi vào `tooling/known-gaps.yaml` (G sở hữu), không sửa đợt này.
3. G.5 known-gap golden-eval hết hạn 15/10: **để sau** → G chỉ ghi nhắc trong báo cáo, không đổi hạn.
4. G.2 14 file rác ở gốc: **xoá** (G thực hiện `git clean` đúng danh sách, kèm .gitignore).
5. I3.4 `/register`: **tắt** (bỏ route + tắt signup ở Supabase Auth — phần tắt Auth là việc của tôi qua Management API sau khi I3 gộp).

## Mẫu báo cáo khi xong

```
Plan: <A..I> · Nhánh/worktree: … · Base: origin/main@<sha>
Đã sửa: <file:line, vì sao>
Test đỏ→xanh: <tên test, lệnh>
Gate đã chạy (kết quả thật, dán dòng cuối): truoc-push / eslint-baseline / tsc / strict-islands / <gate khác>
Chưa xác minh: …
Cần plan khác/chủ quyết: …
Commit: <sha> (chưa push)
```
