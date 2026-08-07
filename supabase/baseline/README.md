# Baseline schema — cách khôi phục

> **Đã diễn tập thật ngày 07/08/2026** trên một Supabase project trắng
> (PostgreSQL 17.6, cùng bản chính với production). Kết quả cuối:
> **bảng 439/439 · view 14/14 · policy 1193/1193 · trigger 493/493.**

Baseline này là đường dựng lại môi trường **thay cho** việc replay 640 file
migration (vốn không chạy được). Nó chứa **schema, không chứa dữ liệu**.

## Quy trình khôi phục — ba bước, đúng thứ tự

```bash
# 1. Role trước. BẮT BUỘC.
psql "<connection>" -v ON_ERROR_STOP=1 -f supabase/baseline/roles.sql

# 2. Schema, LƯỢT 1
psql "<connection>" -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql

# 3. Schema, LƯỢT 2 — không phải thừa, xem bên dưới
psql "<connection>" -v ON_ERROR_STOP=0 -f supabase/baseline/schema.sql
```

Sau đó đối chiếu số đếm với `manifest.json`.

## Vì sao phải có `roles.sql`

`pg_dump --schema-only` **không bao giờ dump role** — role thuộc cấp cluster,
chỉ `pg_dumpall --roles-only` mới lấy. Baseline tham chiếu 7 role riêng của ứng
dụng (`openclaw_function_owner`, `ie_canonical_writer`…) mà Supabase **không**
tạo sẵn.

Bỏ bước này, diễn tập 07/08/2026 cho ra: 249 lỗi `role "…" does not exist`, và
**policy chỉ dựng được 922/1193** — mất 271 policy, tức mất phần lớn hàng rào
RLS. Database trông như đã khôi phục, nhưng dữ liệu hở.

## Vì sao phải chạy `schema.sql` HAI LƯỢT

Một số object tham chiếu tới thứ được định nghĩa **sau** chúng trong file. Ví dụ
đã gặp: `public.rooms` có cột sinh tự động
`name_sort GENERATED ALWAYS AS (public.room_sort_key(name))`; ở lượt 1 nó rơi,
kéo theo 3 view phụ thuộc (`building_coverage`, `meter_readings_detailed`,
`meters_with_latest_reading`).

Lượt 2 dựng nốt những gì lượt 1 bỏ lại, vì lúc đó phụ thuộc đã có. Đo được:

| | bảng | view | policy |
|---|---|---|---|
| lượt 1 | 438/439 | 11/14 | 1170/1193 |
| lượt 2 | **439/439** | **14/14** | **1193/1193** |

`ON_ERROR_STOP=0` ở cả hai lượt là **cố ý**: lượt 1 chắc chắn có lỗi, và dừng ở
lỗi đầu tiên sẽ không bao giờ tới được lượt 2.

## Những lỗi BÌNH THƯỜNG, đừng hoảng

Ở lượt 2, phần lớn thông báo là `already exists` — đó là các object lượt 1 đã
dựng thành công. Còn `Non-superuser owned event trigger…` xuất hiện vì Supabase
không cho tạo event trigger bằng role thường; nó không ảnh hưởng schema ứng dụng.

## Điều baseline KHÔNG làm được

- **Không có dữ liệu.** Muốn khôi phục dữ liệu thì dùng bản dump của
  `scripts/backup-before-schema.mjs`.
- **Không thay thế backup.** Đây là đường dựng lại *cấu trúc*, không phải đường
  lùi khi mất sổ sách.

## Chạy lại diễn tập

```bash
node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "<connection-string>"
```

Script từ chối chạy nếu đích trùng project production.
