# Trạng thái ledger migration trên production

Cập nhật: 2026-08-03. Project: `tryymsxyyckgbrmmvozx`.

## Tóm tắt

Gate `--schema-drift` **PASS** ở SHA `c241b9e`. Trước đó nó đỏ vĩnh viễn vì 12 dòng
ledger thiếu bytes đã thực thi. Ledger nay đã điền, **sau khi** chứng minh được
production khớp file — không phải điền cho gate xanh.

## Lịch sử thật, không rút gọn

12 file được apply ngày 2026-08-03 bằng script trực tiếp qua session pooler, không
qua Supabase CLI. Script ghi `(version, name)` và **bỏ trống `statements`**. Cả 360
dòng migration khác trong ledger đều có `statements`; chỉ 12 dòng OpenClaw thiếu.

Sau đó file bị **sửa tại chỗ** và phần chênh lệch áp bằng tay, năm lần:

| # | Nội dung | Vì sao |
| --- | --- | --- |
| 1 | `openclaw_unknown_authority_v1` + `openclaw_get_unknown_authority_v1` + dựng lại `openclaw_resolve_unknown_v1` | Browser không có đường đọc bằng chứng UNKNOWN |
| 2 | `openclaw_get_bootstrap_v1` thêm `isActiveOwner` | Legal hold đòi OWNER mà UI không biết |
| 3 | `openclaw_conversations_recent_idx` (CONCURRENTLY) | Danh sách hội thoại quét toàn bảng |
| 4 | `openclaw_actor_id_v1` + dựng lại 35 hàm bỏ `auth.uid()` | 55 RPC browser chết 42501 |
| 5 | `openclaw_get_unknown_authority_v1` STABLE → VOLATILE | PostgREST chạy STABLE trong transaction read-only, chuỗi gọi lấy khoá dòng |

Ngoài ra: ba RLS policy + quyền SELECT trên `role_permissions` để hàm cấp quyền
chủ sở hữu chạy được (nó đang cấp 0 dòng mà không báo lỗi).

Nghĩa là **thứ đã chạy** = 12 file bản đầu + 5 delta. **Thứ trong file bây giờ** =
trạng thái sau cùng. Hai thứ đó không giống nhau về trình tự.

## Vì sao vẫn ghi ledger được

Vì đã **đo** chứ không suy: dựng một database dùng-một-lần từ 12 file hiện tại rồi
so với production.

| Hạng mục | Local | Prod | |
| --- | --- | --- | --- |
| Định nghĩa cột | 1222 | 1222 | khớp |
| Index | 442 | 442 | khớp |
| Policy | 245 | 245 | khớp |
| Hàm (tên, tham số, volatility, security definer, search_path, owner) | 246 | 246 | khớp |
| Trigger | 116 | 116 | khớp |
| Row security | 79 | 79 | khớp |
| Constraint (so theo ĐỊNH NGHĨA) | 1078 | 1078 | khớp |

Hai khác biệt đã loại vì là **khác biệt phiên bản**, không phải drift:

- `NOT NULL`: PostgreSQL 18 (PGlite) đưa thành constraint có tên trong catalog,
  PostgreSQL 17 (production) thì không.
- `digest(...)` vs `extensions.digest(...)`: chỉ là cách `pg_get_constraintdef`
  render theo `search_path`. Đã kiểm: `digest` **chỉ tồn tại** ở schema
  `extensions`, và `digest(bytea,text)` trần trên prod trỏ đúng vào đó.

Nên câu mà ledger đang khẳng định — "những bytes này là migration của phiên bản
này" — là **đúng và đã kiểm chứng**.

Script back-fill từ chối ghi đè bất kỳ dòng nào đã có `statements`: nó lấp chỗ
trống, không viết lại bản ghi của công cụ khác.

## Việc còn lại trước go-live

1. `scripts/apply-openclaw-reviewed-migrations.mjs` mà plan (dòng 3274) yêu cầu
   **chưa tồn tại**. Khi viết, nó **phải ghi `statements`** — nếu không dòng ledger
   mới sẽ thiếu y hệt và gate lại đỏ vĩnh viễn.
2. Người review nên đọc mục "Lịch sử thật" ở trên và xác nhận trình tự đó chấp
   nhận được, vì gate không nhìn thấy nó.
