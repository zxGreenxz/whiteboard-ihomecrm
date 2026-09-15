# Plan con F — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| F | migration mới ×4–5, surfaces/generated regen | src/** |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

## 7. Plan con F (P0/P1) — Database (đã đối chiếu catalog production 15/09)

File sở hữu: migration mới (mỗi mục một file), `contracts/surfaces/*` regen, `docs/generated/*` regen.

1. **P0 `generate_contract_number()` race** (đã đọc thân hàm thật): `SELECT COUNT(*)+1 FROM contracts WHERE user_id = NEW.user_id AND EXTRACT(YEAR …)` trong BEFORE INSERT, không lock, `idx_contracts_contract_number` KHÔNG unique, và `create_contract_v2` **không** truyền `contract_number` nên mọi HĐ đều đi qua đây. Hai người tạo HĐ cùng lúc → trùng số. Sửa: bảng đếm `app_private.contract_number_counters(organization_id, year, last_no)` lấy `FOR UPDATE`, hàm đổi khoá theo org; backfill kiểm trùng hiện có (query đọc trước, báo tôi nếu có trùng); unique partial `(organization_id, contract_number) WHERE deleted_at IS NULL` chỉ tạo khi 0 trùng.
2. **P1 `update_room_status_on_contract_change`**: invoker-rights, không `search_path` (xác nhận trên prod). `UPDATE rooms` chịu RLS người gọi → 0 dòng im lặng. `create_contract_v2` đã tự `UPDATE rooms SET status='OCCUPIED'` (dòng 1042) nên đường tạo an toàn; đường UPDATE status (thanh lý/chuyển) thì không. Sửa: SECURITY DEFINER + `SET search_path = pg_catalog, public` + `IF NOT FOUND THEN RAISE` ; revoke anon/authenticated (luật memory REVOKE FROM PUBLIC không cắt anon).
3. **P1 index**: thiếu `contracts(organization_id, status)` composite; partial `WHERE deleted_at IS NULL` cho hot filter; `invoice_audit_log(invoice_id)`. (Đã có `contracts_one_active_per_room_uq` partial nên `(room_id,status)` KHÔNG cần.) Tạo `CONCURRENTLY` ngoài transaction lane — cần đường riêng, ghi rõ trong migration header.
4. **P2** `get_my_assignments()` grant `anon` (20260518000051:49-50) → REVOKE. `reservation_settlement_vouchers` trong publication nhưng không ai nghe → bỏ khỏi publication hoặc nối descriptor (chọn bỏ, ghi lý do).
5. **Không làm** (agent suy đoán sai so với catalog): không có trigger ma `trigger_update_room_bed_status`; policy SELECT contracts đã là v3 (`buildings_for_v3`, `accessible_*`), không còn 4 thế hệ policy cũ; `update_asset_status_on_contract_change` là no-op nhẹ.
6. Mỗi migration: idempotent, chạy được trên DB rỗng (Restore Drill), dry-run `migrate:forward`, `gate:definer-acl`, `gate:stable-fn-locks`, `gate:migration-provenance`. Kiểm bằng `git diff` md5 thô trước CREATE OR REPLACE (memory).

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
