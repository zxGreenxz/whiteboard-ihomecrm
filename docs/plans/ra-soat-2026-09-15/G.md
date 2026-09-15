# Plan con G — rà soát 15/09/2026

> Trích từ plan tổng `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md` (đã duyệt 15/09/2026). Plan tổng là nguồn luật; file này là phần việc của **một session**.

## Sở hữu file (chỉ sửa trong đây)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| G | kiem-nhanh-truoc-push.mjs, .gitignore, ci-gates.yml (paths), known-gaps.yaml, check-known-gaps.mjs | src/** |

Mọi session tạo migration: **KHÔNG commit** `supabase/migration-provenance.json` và `docs/generated/*` — người gộp regen một lần.

## Phần việc

## 8. Plan con G (P1) — CI/CD, quy trình, vệ sinh repo

File sở hữu: `scripts/kiem-nhanh-truoc-push.mjs`, `.gitignore`, `.github/workflows/ci-gates.yml` (chỉ phần paths-filter), `tooling/known-gaps.yaml`, `scripts/check-known-gaps.mjs` (chỉ comment), `docs/engineering/PROJECT_CONTRACT.md` (nếu đổi quy trình).

1. `gate:truoc-push` thêm bước **tuỳ chọn nhưng mặc định bật** chạy các gate CI hay đỏ sau push: lint ratchet (`check-eslint-baseline.mjs`), doc-counts (`check-doc-counts` sau `git add`), contract-gates (known-gap hết hạn, review record), và bước `measure-org-leak` khi có credential (cảnh báo ⚠ nếu thiếu, không giả xanh). Khi staged diff đụng `supabase/migrations/**` mà offline → **đỏ**, không ⚠.
2. `.gitignore`: `*.tmp.json`, `*.dc.html`, `/*.png` ở gốc, `.codex/`, `/chitiethoadon/`, `/ch-nh-s-a-giao-di-n-h-p-ng/`, `/*-snapshot.md`. 14 file rác hiện tại ở gốc checkout chính: **chủ quyết xoá** — G xoá đúng danh sách (không `git clean -fd` trần), ghi danh sách đã xoá vào báo cáo.
3. `.claude/settings.local.json` đang **được track** (commit ea89dd87) dù trong .gitignore; nội dung chỉ là allowlist permission, không có token → `git rm --cached` + commit `chore`. `.claude/settings.json` mới là `{}` — bỏ hoặc commit rỗng có chủ đích.
4. `ci-gates.yml` không có path filter: PR chỉ docs vẫn chạy 12 job. Thêm `dorny/paths-filter` (ghim SHA) ở `preflight` để bỏ qua job không liên quan; **không** bỏ qua security-gates cho thay đổi `supabase/**` hay `src/**`.
5. Known-gap `copilot-golden-eval-real-lane-daily-quota` hết hạn **15/10/2026** → external-controls sẽ đỏ từ 16/10. **Chủ quyết để sau** — G không đổi, chỉ ghi nhắc trong báo cáo. Thêm known-gap mới cho H3.5 (`v5_recompute_streak` replay, hạn 31/12/2026).
6. Sửa comment lỗi thời ở `known-gaps.yaml:20` và `check-known-gaps.mjs:4` ("đang dùng continue-on-error" → "gate tồn tại để không ai thêm lén").
7. Đồng bộ checkout: `git pull --ff-only` local main lên f45cb81a (việc của tôi, không phải session con).

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
