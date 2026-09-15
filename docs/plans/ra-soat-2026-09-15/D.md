# Plan con D — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| D | IncomeExpenseForm, useRooms, useRoomsWithContracts, useMeters, useLeads, useMaterials, useTenants, useManagerSalary (330-345), 11 dialog, OrganizationContext, migration v5_month_money_bulk | AssetsPage (E) |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

## 5. Plan con D (P0/P1) — Query không giới hạn, dialog fetch sớm, N+1

File sở hữu: `src/components/income-expenses/IncomeExpenseForm.tsx`, `src/hooks/useRooms.ts`, `src/hooks/useRoomsWithContracts.ts`, `src/hooks/useMeters.ts`, `src/hooks/useLeads.ts`, `src/hooks/useMaterials.ts`, `src/hooks/useTenants.ts`, `src/hooks/useManagerSalary.ts` (khối 330-345), 11 dialog trong danh sách bên dưới, `src/contexts/OrganizationContext.tsx`, migration mới cho RPC bulk lương.

1. `IncomeExpensePage.tsx:844/850/856` mount 3 `<IncomeExpenseForm open={false}>` mà form không early-return → `useContractsLegacy(undefined)` quét toàn bộ contracts (`select *` + count exact, không range) ngay khi mở /thu-chi. Sửa: `if (!open) return null` ở đầu form (giữ hook order bằng cách tách `IncomeExpenseFormInner`), `useContractsLegacy` thêm `enabled: open && !!roomId`.
2. `useRooms` (key `["rooms"]`, không range, cap 1000 im lặng, dùng ở 5 dialog) → `fetchAllRows` + tiebreaker `id`; 5 call-site thêm `enabled: open`.
3. `useRoomsWithContracts` (join 4 tầng, gọi org-wide từ RoomsPage:87), `useMeters` (view không filter), `useLeads`, `useMaterials`, `useTenants` → `fetchAllRows` hoặc `.range()` (mẫu `useMeterReadings.ts:200-204`).
4. `useManagerSalary.ts:336-339` N+1 `v5_month_money` theo từng staff → RPC `v5_month_money_bulk(p_users uuid[], p_month)` (migration mới, SECURITY DEFINER tự kiểm quyền như bản đơn) + hook dùng 1 request.
5. 11 dialog fetch trước khi mở → thêm `{ enabled: open }` (hook đã hỗ trợ): ManageAreasDialog:37, AssetMaintenanceDialog:38, AssetMovementDialog:37-38, CreateAssetDialog:44-45, EditAssetDialog:48, BuildingFormDialog:67, ContractImportExportDialog:85, TransferRoomDialog:55/61, CreateDepositDialog:133, IncomeExpenseImportDialog:156, ExcelInvoiceDialog:61.
6. `OrganizationContext.selectOrganization` không đụng queryClient → 741/761 key giữ cache org cũ khi đổi công ty → gọi `queryClient.removeQueries` cho mọi key ngoài `['auth', …]` (mẫu `authQueryCache.ts:121-136`). Test bất biến.

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
