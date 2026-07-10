# Phase 4 — DB hygiene & perf (initplan + view guard + dọn migration)

**Commit:** `be1ffc0` · **Loại:** DB + tool · **Migration:**
`20260710140000_rls_initplan_wrap_remaining.sql`

## Vì sao
Ba việc tách biệt, gộp vì cùng là dọn dẹp DB an toàn:
1. ~128 policy write/self còn gọi `is_admin()`/`is_super_admin()` TRẦN (per-row
   eval) — migration initplan trước (20260702150000) chỉ làm SELECT policy.
2. View `security_invoker` không có chốt chống hồi quy (án lệ đã lộ tenant).
3. Migration hiểm hoạ replay còn trong cây.

## 1. Wrap initplan 128 policy

- Sinh ALTER POLICY **tự động** từ `pg_policies` bằng `regexp_replace` wrap
  `is_admin()`→`(SELECT public.is_admin())` (tương tự is_super_admin). CHỈ emit
  policy biểu thức THỰC SỰ đổi (lọc `new_qual IS DISTINCT FROM qual`) → đúng 128
  policy. Áp **all-or-nothing** trong 1 transaction.
- **Semantics-preserving**: `(SELECT fn())` cho kết quả HỆT `fn()` — Postgres chỉ
  eval 1 lần (initplan) thay vì per-row → giảm CPU hot path RLS. KHÔNG đổi hàng nào
  thấy/không-thấy.
- Bảng nặng nhất: `vehicles`, `meter_readings`, `leads`, `jobs`, `deposits`,
  `assets`, `areas` (5 policy mỗi bảng).

### GOTCHA khi sinh DDL (đã sửa, ghi lại cho reviewer)
- Lần 1: `COALESCE(with_check,'')` khiến policy có `with_check` NULL luôn "khác" →
  emit thừa 493. Sửa: dùng `regexp_replace(with_check,...)` trực tiếp (NULL→NULL).
- Lần 2: WHERE dùng `~` case-SENSITIVE bắt cả policy đã-wrap ("SELECT" hoa ≠
  "select" thường trong lookbehind), nhưng `regexp_replace` 'gi' không re-wrap →
  ALTER no-op. Sửa: lọc `new IS DISTINCT FROM old` → đúng 128.

## 2. Chốt view-invoker

- `scripts/check-view-invoker.mjs`: quét `pg_class.reloptions` mọi view public
  thiếu `security_invoker=true` → exit 1. **6/6 view hiện an toàn.**
- Án lệ (migration 20260704180000): `CREATE OR REPLACE VIEW` làm RỚT
  `security_invoker` (vì `pg_get_viewdef` bỏ reloptions) → view chạy quyền owner →
  tài khoản demo đọc được sổ quỹ/chỉ số điện của tenant thật. Script này chốt chống
  tái phát. Ghi CLAUDE.md: **chạy sau mọi migration đụng view**.

## 3. Dọn hiểm hoạ replay
- `20260617000001_forfeit_full_settlement.sql` (đánh dấu "SUPERSEDED — KHÔNG APPLY")
  + `migrations-bundle/` (14 file hand-apply Apr–May 2026) → chuyển sang
  `supabase/migrations-archive/` + README giải thích. Ngăn `supabase db push` (hay
  ai đó) vô tình replay.

## Verify
- **0 policy bare còn lại** (query pg_policies case-insensitive sau áp).
- `reconcile-money.mjs` **PASS** sau initplan → chứng minh rewrite KHÔNG đổi kết quả
  tiền (RLS đọc y nguyên).
- Playwright: `/contracts` (265 HĐ), `/vehicles` (có dữ liệu) — 2 bảng nằm trong
  128 policy vừa rewrite, hiển thị dữ liệu bình thường, không lỗi quyền → RLS đọc
  nguyên vẹn.
- `check-view-invoker.mjs` exit 0.

## Reviewer cần soi
1. **128 policy rewrite là điểm rủi ro cao nhất phase này.** Cách kiểm chắc nhất:
   dump `pg_policies` TRƯỚC (từ git blame/migration cũ) và SAU, so từng cặp — chỉ
   được khác ở lớp `(SELECT ...)` quanh 2 hàm, mọi thứ khác BYTE-IDENTICAL. Vì sinh
   tự động từ chính output decompiled của Postgres nên rủi ro syntax gần như 0,
   nhưng nên xác nhận không policy nào bị đổi ngữ nghĩa (vd wrap nhầm vào 1 hàm khác
   trùng tên).
2. **Write path chưa test bằng Playwright** (mới test đọc). Nên tạo/sửa/duyệt 1
   phiếu, 1 hợp đồng, 1 xe để chắc WITH CHECK policy rewrite không chặn nhầm ghi.
3. **Không có ROLLBACK block trong migration** (chỉ ghi "bỏ lớp SELECT quanh fn").
   Nếu cần đảo, phải sinh lại DDL ngược. Cân nhắc có nên thêm rollback tường minh.
