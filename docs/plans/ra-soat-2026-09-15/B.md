# Plan con B — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| B | useRealtimeDataSync.ts, prefetchPages.ts, useContracts.ts (onSuccess 612-621), useInvoices.ts (46-59) | finance.ts |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

## 3. Plan con B (P1) — Hub realtime tự đánh lại mutation của chính mình + bão prefetch

Vấn đề chung (bug A là một ca): mỗi mutation local đã invalidate xong thì 0,8–2,4 s sau hub invalidate **lần hai** toàn bộ key của bảng + prefetch 3–4 domain, kể cả khi user không ở trang đó. Với `create_contract_v2` là 5 bảng → ~70 key + 6 RPC nặng.

File sở hữu: `src/hooks/useRealtimeDataSync.ts`, `src/lib/prefetchPages.ts`, `src/hooks/useContracts.ts` (chỉ khối onSuccess 612-621), `src/hooks/useInvoices.ts` (chỉ khối useAdjustInvoice 46-59), test `src/hooks/__tests__/useRealtimeDataSync.test.ts`.

1. **Cửa sổ "vừa tự ghi"**: hub giữ `Map<table, tsLastLocalMutation>`; mutation local gọi `markLocalWrite(tables[])` (helper export từ hub); event realtime tới trong ≤3 s sau mốc đó cho bảng ấy thì **chỉ** invalidate key đang `active`, **không** prefetchDomain. Đo bằng test: sau mutation, số `invalidateQueries` gọi ≤ 1 lần/bảng.
2. `prefetchDomain` trong `flushEntry` chỉ chạy khi route hiện tại **không** phải domain đó (đang ở trang đó thì invalidate đã refetch rồi) và cách lần prefetch trước ≥10 s (throttle theo domain).
3. `useCreateContract.onSuccess`: bỏ các key hub đã phủ, giữ đúng key màn đang mở; `useAdjustInvoice`: 17 prefix → invoice id + 3–4 aggregate.
4. Đo trước/sau bằng `__perfReport()` (src/lib/perfTrace.ts) trong E2E của plan A: số request Supabase trong 5 s sau tạo HĐ (mục tiêu giảm ≥50%).

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
