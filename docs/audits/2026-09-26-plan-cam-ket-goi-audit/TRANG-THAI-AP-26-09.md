# Trạng thái áp production — plan cỗ máy chi theo cam kết (26/09/2026, tối)

Chủ uỷ quyền trực tiếp trong phiên: *"khỏi soi, tự kiểm tra plan rồi thực hiện chi tiết toàn bộ và đưa toàn bộ
lên production"*. Đã áp **hai** giai đoạn có đường lùi sạch nhất; dừng trước các giai đoạn đụng writer tiền
(lý do ở §12 của plan).

## Đã áp — qua lane `npm run migrate:forward -- <file> --apply` (kiểm 2 lượt ROLLBACK → backup full → áp)

| | G1 · `20260926082454_bang_cam_ket_chi.sql` | G3 · `20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql` |
|---|---|---|
| Digest lane | `a960494aa851b84e…` | `9e82e0cf2f4d3203…` |
| Backup trước áp | `ihomecrm-full-2026-09-26T11-30-32-672Z.dump` · 26,4 MB · sha256 `dcca965ea16f6781…` (159s) | `ihomecrm-full-2026-09-26T11-39-49-880Z.dump` · 26,4 MB · sha256 `a55500a6ce0b1ebf…` (128s) |
| Giấy phép | `bien-nhan-backup · 741963c3c984991d` | `bien-nhan-backup · c3a4750e1419fd32` |
| Áp | 0s | 4s |
| Catalog | `afe30d1f… → 35e360fe…` | `35e360fe… → ce4b01d1…` |
| Evidence | `docs/generated/schema-change-evidence/20260926082454_bang_cam_ket_chi.json` | `docs/generated/schema-change-evidence/20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.json` |
| `catalog:capture` | fingerprint `35e360fe8118e175…`, "không object hở" | fingerprint `ce4b01d1f86724b0…`, "không object hở" |

## Kiểm đọc thật trên production sau áp (pooler, `BEGIN READ ONLY`)

- **G1:** `spend_commitments` MIGRATED/PUBLISHED = **1.272 dòng / 106 khe / 12 tháng** (2026-10-01 → 2027-09-01);
  tiền nhà 10/2026 = **15 toà · 681.650.000đ**; `spend_commitment_draws` = 0; ACL hai RPC:
  `authenticated=X`, `service_role=X`, **anon không có**.
- **G3:** cột `fee_category`, `spend_mode` có; ánh xạ **9 khoá × 2 org** (iHome CRM và Demo độc lập):
  `dien/nuoc = TRAN`, 7 khoá còn lại `CAM_KET`; trigger `a05_ie_type_rule_columns_guard` có mặt.

## Gate tiền sau G1

- `gate:reconcile-money` — **PASS**: A (SQL) = B (RPC/RLS) = C (phân trang FE) = **5.788.924.013 VND**, 1.166 phiếu,
  cửa sổ 2026-07→09; cap-1000 có bị chạm, phân trang được thử thật.
- `gate:reconcile-money-v2` — **PASS**: 20 sổ thật khớp legacy == v2 (< 0,01đ); posting 3.740 dòng, phân trang
  P == T = 2.688.708.004 VND.

## Thử trên TEST trước khi áp (`hzulujxgonszuleqticb`, transaction rồi ROLLBACK)

- Script: `thu-G3-tren-TEST-kem-guard.cjs` (chạy G1 rồi G3 nối tiếp; thử hai lượt; thử hành vi guard).
- G1: 106 khe × 12 = 1.272; lượt hai không nhân đôi.
- G3: 18 ánh xạ (9 × 2 org); trigger có; lượt hai 18 → 18.
- **Guard — lỗi bắt được và đã sửa trước khi áp:** bản đầu không `SECURITY DEFINER` ⇒ `authenticated` không có
  USAGE `app_private` ⇒ guard chặn nhầm **cả chủ công ty**. Sau sửa: chủ sửa `spend_mode` → **được (1 dòng)**;
  thành viên thường → **bị chặn 42501** đúng thông báo *"Chỉ chủ công ty hoặc quản trị hệ thống được đổi luật
  chi của hạng mục…"*.

## Vá hồi quy của G3 — `20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql` (26/09, 19:27 VN)

**Lỗi:** guard G3 là `SECURITY DEFINER` nên chỉ thấy người bấm. 20 hàm hệ thống tự ghi `force_approval` /
`is_deposit` như một bước phụ (`_termination_ensure_type` do `pay_utility_bill`, `confirm_cash_handover`,
`terminate_contract_*` gọi; `ensure_income_expense_type_v1` do `reservation_create_leg_v1`,
`generate_special_fees_v1` gọi) ⇒ lần đầu hệ thống cần tạo/chỉnh hạng mục trong lúc **quản lý** bấm thanh lý
hay đóng điện nước là bị 42501. Đo prod: **chưa ca nào dính** (mọi hạng mục hệ thống đã có đúng cờ ở cả hai
org; 0 hạng mục, 0 phiếu mới từ lúc áp G3) — hồi quy chờ nổ.

**Sửa:** guard chuyển `SECURITY INVOKER`, chỉ canh `current_user IN ('authenticated','anon')` — tức ghi thẳng
từ client. Trong hàm definer, `current_user` là chủ hàm ⇒ mã server đi như trước G3. Kiểm chủ đúng org qua
helper `public.ie_type_rule_editor_ok_v1(org)` (definer; anon không có). Trigger đổi tên `zz_…` để chạy sau
`trg_autofill_org`. Không dùng `session_user` (bài học 17/09).

**TEST, cùng bộ ca trước/sau** (`thu-va-guard-tren-TEST.cjs` → `.json`):

| Ca | G3 cũ | Sau vá |
|---|---|---|
| Quản lý gọi hàm hệ thống **thật** `_termination_ensure_type` (tên mới) | **CHẶN 42501** | được |
| Quản lý gọi hàm definer tạo hạng mục `force_approval` + đổi `is_deposit` | **CHẶN 42501** | được |
| Quản lý sửa thẳng `spend_mode` | chặn | chặn |
| Quản lý INSERT thẳng hạng mục mặc định (đường màn Danh mục) | được | được |
| Quản lý INSERT thẳng hạng mục `is_deposit=true` | chặn | chặn |
| Chủ sửa thẳng `spend_mode` | được | được |
| Chủ INSERT thẳng hạng mục `force_approval=true` (không gửi org) | **chặn nhầm** (org chưa điền) | được |

**Áp:** lane, backup `ihomecrm-full-2026-09-26T12-27-29-253Z.dump` · sha256 `dc533a449c0e2491…` · giấy phép
`65e28c84439d0f2e`; catalog `ce4b01d1… → c7b8f8b6…`; `catalog:capture` "không object hở". Đọc lại prod: trigger
`zz_ie_type_rule_columns_guard` có, `a05_…` không còn; guard `prosecdef=false`; helper anon=false.

## Chưa áp

G2 (bộ máy quyết định + bóng), G4 (giao thức cam kết), G5 (bật theo bucket — cần ≥ 14 ngày bóng), G6 (sổ chi),
G7 (một đường duyệt), G8 (dọn đường cũ). Màn hình cho chủ nhập/sửa cam kết chưa có — dùng RPC trực tiếp.

## Hành vi hệ thống

**Không đổi.** Hai migration chỉ thêm bảng/cột/trigger; không writer nào đọc chúng. Guard chỉ siết việc sửa
*luật của hạng mục* (chủ/super admin), không đụng luồng lập/duyệt/chi phiếu.
