# Đối chiếu thân hàm production với mã nguồn

Đối chiếu catalog chỉ đọc do root thu thập với snapshot `c095d427e`. Chỉ chuẩn hóa CRLF/CR thành LF; giữ nguyên comment, dấu cách và nội dung thân hàm.

| Hàm | Migration nguồn | MD5 body sau chuẩn hóa | Khớp catalog |
|---|---|---|---|
| `create_room_reservation_v1` | `supabase/migrations/20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql:503` | `83516cdcde0b90ecfa5026cdec06c083` | Có |
| `set_reservation_hold_terms_v1` | `supabase/migrations/20260822120000_han_bo_sung_coc_cho_phieu_giu_cho.sql:86` | `6378d889a73c36b1d422f0002ce3fa84` | Có |
| `update_room_reservation_v1` | `supabase/migrations/20260928025848_room_reservation_workflow.sql:192` | `0dd02dd3079fd84e7522e709784e4f80` | Có |
| `upsert_room_pass_listing` | `supabase/migrations/20260629100000_room_pass_listings_contact_manager.sql:28` | `1b7a83356e653781972a79c0e585704b` | Có |

MD5 catalog được cung cấp khớp MD5 thân hàm trích từ definition: **4/4**. Cả bốn hàm được catalog ghi nhận `SECURITY DEFINER`.

Phát hiện scope của `upsert_room_pass_listing` đã được nối với thân hàm hiện hành trên production: body deployed giống hệt body dùng trong proof cục bộ sau chuẩn hóa xuống dòng. Đây vẫn **chưa phải** thử tấn công bằng JWT/PostgREST hoặc xác minh toàn bộ helper, trigger, ACL của database production.

Nguồn: [catalog chỉ đọc](live-function-audit.json), [đối chiếu máy đọc](live-function-comparison.json), [script đối chiếu](../proofs/compare-live-functions.mjs).
