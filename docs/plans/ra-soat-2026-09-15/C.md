# Plan con C — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| C | 39 hook nuốt lỗi, useMyPermissions, RequirePermission, QueryProvider, ratchet error-swallow | useRooms.ts (D sở hữu) |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

## 4. Plan con C (P0) — Lỗi bị biến thành dữ liệu rỗng (đọc)

39 chỗ trong `src/hooks/**` theo mẫu `if (error) { console.error; return []; }` (useAreas:26, useFloors:28, useJobTypes:17, useMaterials:30, useIncomeExpenseTypes:83/125/161/202, useInvoices:325/1560, useMeters:166/208, useBuildingServices:27, useAssignablePeople:29 …) + `useMyPermissions.ts:29` trả `{}` → `RequirePermission.tsx:46-48` **đá user về `/`** khi RPC quyền lỗi tạm thời. Không có `QueryCache.onError` toàn cục.

File sở hữu: toàn bộ hook trong danh sách (liệt kê đầy đủ bằng `rg -n "if \(error\)[^\n]*\n[^\n]*return \[\]" src/hooks` lúc bắt đầu), `src/hooks/useMyPermissions.ts`, `src/components/auth/RequirePermission.tsx`, `src/app/providers/QueryProvider.tsx`, `scripts/check-error-swallow-ratchet.mjs` + `tooling/error-swallow-baseline.json`.

1. Đổi từng chỗ thành `throw error` (mẫu nhà: `useRooms.ts:39-43`). Với hook dropdown, component đọc `isError` để hiện "Không tải được — thử lại".
2. `useMyPermissions`: throw; `RequirePermission`: `isPending` → skeleton, `isError` → màn "Không tải được quyền" + nút thử lại, **không Navigate**.
3. `QueryProvider`: `new QueryCache({ onError })` toast một lần/queryKey (không toast cho query có `meta.silent`), gắn `reportBoundaryError`.
4. Mở rộng ratchet error-swallow để bắt mẫu `return []`/`return {}`/`return null` sau `if (error)` trong `src/hooks` và `src/lib` (test chứng minh chuỗi trong comment không làm gate xanh — luật §8).

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
