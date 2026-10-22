# Plan — Quyết toán toà vận hành cho chủ nhà (21/10/2026)

> Trạng thái: **dựng ở local + TEST để chủ xem trước**. Production chỉ làm sau khi chủ duyệt bản xem thử.
> Repo công khai: tài liệu này không ghi số tiền thật hay tên sổ quỹ thật.

## 1. Nghiệp vụ chủ đã chốt (21/10/2026)

| # | Điểm | Chốt |
|---|---|---|
| 1 | Hình thức | Một số toà **vận hành cho chủ nhà**: chủ nhà sở hữu, iHome vận hành, **không thuê lại, không có tiền nhà**. Các toà khác vẫn thuê rồi cho thuê lại. |
| 2 | Bên nhận % | Quản lý = chủ iHome (super admin). Tỷ lệ **thoả thuận riêng từng toà**. |
| 3 | Lợi nhuận tháng | Doanh thu − chi phí **ghi vào toà** (đúng các khoản tính KQKD của toà). Chi phí chung ở toà ảo không trừ. |
| 4 | Tháng lỗ | Phần quản lý = 0đ ("lỗ thì không tính"); lỗ không chuyển sang tháng sau. |
| 5 | Áp dụng | Từ tháng **10/2026**. |
| 6 | Tiền | Doanh thu mặc định vào **sổ quỹ của chủ nhà**. Cọc do quản lý giữ để trả cọc khách và thanh lý nội bộ. Có khoản lọt vào sổ quản lý (cọc lố tiền phòng, chuyển nhầm, cấn cọc khi thanh lý) và khoản quản lý chi hộ ⇒ phải bù trừ khi quyết toán. |
| 7 | Một trang | Mỗi tháng: tổng chủ nhà thu/chi, tổng quản lý thu/chi ⇒ bàn giao quyết toán ⇒ chốt % ⇒ con số **chủ nhà trả quản lý** hoặc **quản lý bù chủ nhà**, cộng dồn các tháng. **Chủ nhà xem cùng trang** (chỉ đọc), không qua trang chia lợi nhuận. |
| 8 | Dữ liệu cũ | Tiền nhà 3 toà ⇒ "không áp dụng". Phiếu cũ ghi nhầm toà ảo: để nguyên. |

## 2. Công thức — một nơi duy nhất trong database

`app_private.landlord_settlement_compute_v1(toà, tháng)`; web và link chủ nhà chỉ hiển thị.

- **Phiếu tính:** phiếu của toà, `approval_status = 'APPROVED'`; dòng tính như KQKD canonical
  (`fa_accrual_allocations`): `business_result_accounting IS DISTINCT FROM false` và
  (`business_result_accounting IS TRUE` hoặc `accounting_class = 'PNL'`); phiếu không có dòng hạng mục lấy `total_amount`.
- **Chia tháng theo kỳ (chủ chốt 22/10):** dòng lãi lỗ vào tháng theo **kỳ ghi trên hạng mục**, đúng luật của
  `fa_accrual_allocations` (hoá đơn ⇒ tháng hoá đơn; kỳ nhiều tháng ⇒ chia đều; không kỳ ⇒ ngày phiếu) qua bản chép
  `app_private.landlord_kqkd_lines_v1` (không xét quyền người gọi — link chủ nhà — và có cả phiếu chờ duyệt; test so từng đồng
  với hàm gốc) ⇒ lợi nhuận quyết toán = lợi nhuận toà trên Báo cáo LN (phần đã duyệt). Cọc / trả thừa / không tính / tiền thối
  theo **ngày phiếu** (dòng tiền thật). Bản 21/10 chia theo ngày phiếu — đã bỏ.
- **Bên giữ tiền:** sổ quỹ của phiếu nằm trong danh sách "sổ chủ nhà" của toà ⇒ CHỦ NHÀ; mọi sổ khác
  (kể cả sổ ảo cấn trừ thanh lý, phiếu không sổ) ⇒ QUẢN LÝ.

```text
doanh_thu    = chủ nhà thu + quản lý thu
chi_phi      = chủ nhà chi + quản lý chi
loi_nhuan    = doanh_thu − chi_phi
phan_quan_ly = loi_nhuan > 0 ? round(loi_nhuan × % / 100) : 0
phan_chu_nha = loi_nhuan − phan_quan_ly
coc_chu_nha_giu = cọc/tiền khách trả thừa vào sổ chủ nhà − chi ra từ sổ chủ nhà
                  + tiền thối rơi vào sổ chủ nhà (làm tròn không phải tiền mặt ⇒ không tính)
chu_nha_tra_quan_ly = phan_quan_ly + quản lý chi − quản lý thu + coc_chu_nha_giu   (âm ⇒ quản lý trả lại chủ nhà)
```

Kiểm chứng: chủ nhà đang giữ (chủ nhà thu − chủ nhà chi + coc_chu_nha_giu) nhưng chỉ được hưởng `phan_chu_nha`
(cọc là tiền quản lý giữ để hoàn khách); phần chênh đúng bằng công thức trên.

- **Cọc & tiền khách trả thừa** (`DEPOSIT`, `CUSTOMER_CREDIT`): ở sổ quản lý thì chỉ hiển thị; vào sổ chủ nhà thì đưa vào bù trừ.
- **Thanh lý hợp đồng** tách theo `system_source`: cấn cọc vào khoản khách phải trả (`termination.revenue`) và bỏ cọc
  (`termination.forfeit_revenue`) là doanh thu ở sổ ảo cấn trừ ⇒ bên quản lý; khách trả thêm phần vượt cọc
  (`termination.extra_receipt`) theo sổ nhận; trả thêm cho khách ngoài cọc (dòng PNL của `termination.refund`) là quản lý chi;
  hoàn cọc không tính; cặp `termination.rent_refund_*` tự triệt tiêu.
- **Không khoản nào biến mất:** mọi dòng thuộc đúng một nhóm — tính KQKD / cọc / không tính (nội bộ, phiếu tắt KQKD) — nhóm
  "không tính" vẫn liệt kê kèm lý do.
- **Phiếu chờ duyệt** chưa tính, liệt kê riêng; còn phiếu chờ (hoặc phiếu đã duyệt mà bút toán sổ quỹ bị đảo / chưa ghi sổ,
  phiếu dùng sổ chủ nhà của toà vận hành khác, phiếu của toà khác ghi vào sổ chủ nhà toà này) thì không chốt được. Tháng đầu tiên còn chặn phiếu chờ duyệt ghi ngày trước tháng
  áp dụng (duyệt xong cũng không rơi vào kỳ nào).
- **Số dư đầu kỳ** khai ở Cài đặt toà; màn gợi ý số cọc đang nằm ở sổ chủ nhà trước tháng áp dụng. Phải đánh dấu "đã đối
  chiếu với chủ nhà" mới chốt được (khi số dư hoặc cọc trước kỳ khác 0); đổi số thì phải đánh dấu lại.
- **Điều khoản theo tháng** (bổ sung sau rà 21/10): % và sổ chủ nhà lưu theo `valid_from`; sửa "từ tháng X" (chưa chốt) chỉ
  ghi trường đã đổi so với điều khoản đang áp ở X, cho X và các mốc sau; tháng đã chốt giữ nguyên. Không dời tháng áp dụng ra
  sau tháng đã chốt. Xác nhận số dư đầu kỳ chỉ nhận khi đúng số cọc trước kỳ màn đã hiện và cơ sở không đổi trong lần lưu.
- **Đối chiếu Báo cáo LN** (chỉ màn quản trị): lợi nhuận quyết toán cạnh lợi nhuận toà theo `fa_accrual_allocations` — cùng luật
  kỳ nên khớp từng đồng; lệch chỉ khi phiếu đổi sau khi chốt (hoặc lỗi công thức). Cảnh báo: khoản chi cố định chưa có phiếu,
  phiếu ở toà khác nhắc mã toà, khoản lãi lỗ có kỳ trước tháng áp dụng mà phiếu lập sau (không tính, không chặn).
- **Dòng "Lợi nhuận của iHome" trên Báo cáo LN** (chủ chốt 22/10): giữ tổng lợi nhuận, thêm một dòng = tổng − phần chủ nhà
  của toà vận hành trong phạm vi đang xem (`public.landlord_ihome_profit_v1`; tháng chốt lấy số đã chốt, tháng mở tạm tính).
  Phần chủ nhà không hiện thành dòng riêng.
- **Cộng dồn:** còn lại = Σ quyết toán các tháng **đã chốt** − chủ nhà đã trả + quản lý đã trả. Màn hiện thêm số
  "gồm cả tháng tạm tính".

## 3. Dữ liệu (schema `app_private`, chỉ đi qua RPC)

| Bảng | Vai trò |
|---|---|
| `landlord_operations` | Một dòng/toà: tên chủ nhà, tháng áp dụng, số dư đầu kỳ (+ dấu đã đối chiếu), đang áp dụng |
| `landlord_operation_terms` | % quản lý + sổ quỹ chủ nhà theo tháng bắt đầu (`valid_from`) |
| `landlord_operation_changes` | Sổ thay đổi cấu hình (append-only) |
| `landlord_settlement_closes` | Chốt / mở chốt tháng, append-only; CLOSE chụp nguyên bảng quyết toán + `source_hash` |
| `landlord_settlement_payments` | Hai bên đã trả nhau; không xoá, huỷ phải có lý do; khoá chống bấm trùng |
| `landlord_share_links` | Link chỉ đọc `/qt/:token` cho chủ nhà; thu hồi được |

Không writer nào đọc các bảng này; không sửa phiếu, sổ quỹ, hoá đơn, KQKD, chốt LN hay bộ máy chi.
Chốt tháng **không khoá phiếu**: phiếu đổi sau khi chốt thì màn báo "đã thay đổi sau khi chốt", phải mở chốt (có lý do)
rồi chốt lại.

## 4. RPC

| RPC | Ai gọi | Việc |
|---|---|---|
| `landlord_operations_list_v1()` | chủ công ty / super admin | toà đã cài + toà có thể cài |
| `landlord_operation_options_v1(toà)` | như trên | cấu hình hiện tại, gợi ý sổ chủ nhà (sổ nhận nhiều phiếu thu nhất), lịch sử đổi |
| `landlord_operation_upsert_v1(...)` | như trên | thêm/sửa cấu hình, ghi sổ thay đổi |
| `landlord_settlement_month_v1(toà, tháng)` | như trên | bảng quyết toán tháng + trạng thái chốt + lý do chưa chốt được |
| `landlord_settlement_overview_v1(toà)` | như trên | các tháng từ khi áp dụng, thanh toán, số còn lại |
| `landlord_settlement_close_v1` / `reopen_v1` | như trên | chốt (CAS theo `source_hash`, tháng đã qua, không còn phiếu chờ) / mở chốt (lý do ≥ 8 ký tự) |
| `landlord_settlement_add_payment_v1` / `void_payment_v1` | như trên | ghi / huỷ thanh toán quyết toán |
| `landlord_share_link_create_v1` / `revoke_v1` / `landlord_share_links_v1` | như trên | link cho chủ nhà |
| `landlord_settlement_public_v1(token, tháng)` | anon (link) | gói chỉ đọc, bỏ id nội bộ; token sai/thu hồi ⇒ NULL |

Quyền: `public.is_super_admin()` hoặc chủ công ty của đúng công ty sở hữu toà
(`app_private.ie_actor_is_company_owner_v1`), và vẫn phải `can_access_building`. Mọi hàm ghi khoá theo toà
(`pg_advisory_xact_lock`), VOLATILE; hàm đọc STABLE.

## 5. Giao diện

- **`/reports/finance/quyet-toan-van-hanh`** (menu Báo cáo → Tài chính, chỉ chủ công ty / super admin):
  chọn toà + tháng; thẻ Doanh thu · Chi phí · Lợi nhuận · Phần quản lý (x%) · Phần chủ nhà; bảng "ai đang giữ tiền"
  (chủ nhà thu/chi, quản lý thu/chi); khung **Quyết toán tháng** (phần quản lý + quản lý chi hộ − quản lý thu hộ ⇒ ai
  trả ai bao nhiêu); danh sách phiếu theo từng nhóm; cọc trong tháng; phiếu chờ duyệt.
  Bảng **Tổng quyết toán** các tháng + thanh toán + số còn lại. Nút: Cài đặt toà · Link cho chủ nhà · Ghi nhận thanh
  toán · Chốt tháng / Mở chốt.
- **`/qt/:token`** (công khai, ưu tiên điện thoại): cùng nội dung, chỉ đọc, chọn tháng.
- Công thức không chép sang TypeScript; client chỉ parse (zod) và định dạng.

## 6. Kiểm thử

- SQL trên TEST (bọc ROLLBACK): công thức, chặn quyền (quản lý toà, anon), chốt/CAS/tháng chưa hết/phiếu chờ,
  thanh toán + chống bấm trùng, link công khai không lộ id.
- Vitest: parse gói RPC (zod), nhãn chiều tiền, trạng thái màn.
- Playwright trên dev server local trỏ TEST: màn quản trị (desktop) + link chủ nhà (điện thoại 390px), ảnh + console.
- Cổng repo theo `npm run gate:truoc-push -- --plan`.

## 7. Xem thử ở local (TEST)

1. Áp migration vào TEST (`npm run test-env:thu-sql -- <file> --ghi`); lần đồng bộ TEST sau sẽ xoá — áp lại nếu cần.
2. Cài 3 toà trên TEST bằng chính màn Cài đặt (tỷ lệ chủ nhập; sổ chủ nhà theo gợi ý).
3. Dev server local trỏ TEST; chủ tự đăng nhập tài khoản TEST.

## 8. Lên production (sau khi chủ duyệt)

1. Draft PR (tiền + quyền + migration) → CI → review chéo một lượt trên diff cuối.
2. `npm run migrate:forward -- <file>` dry-run → `--apply` (lane có backup + biên nhận) → provenance, `gen:types`,
   bỏ lớp bọc kiểu RPC tạm, gỡ hồ sơ "chưa áp có chủ ý" ở `supabase/migration-unknown-review.json`. Ngay sau khi áp:
   `node scripts/check-definer-acl.mjs --update` (RPC `landlord_settlement_public_v1` cho anon là có chủ đích — hàng rào
   là token) trong cùng PR nối tiếp, không thì security-gates trên main đỏ.
3. Promote web theo lane (`promote:production`), `release:verify`.
4. Chủ nhập cấu hình 3 toà trên production; đánh dấu tiền nhà "không áp dụng" ở Phí cố định theo toà.

## 9. Mặc định đã tự chọn (chủ đổi được khi xem thử)

- Lợi nhuận chia **theo kỳ** trên hạng mục (chủ chốt 22/10), chỉ phiếu đã duyệt; tiền cọc / trả thừa theo ngày phiếu.
- Chỉ **chốt tháng đã qua** và không còn phiếu chờ duyệt.
- Thanh toán quyết toán ghi trên trang này; **không** tự sinh phiếu thu/chi trong sổ quỹ.
- Link chủ nhà: không cần đăng nhập, thu hồi được, không lộ id nội bộ; chủ nhà thấy tên phiếu và số tiền, tên sổ chỉ hiện
  "Sổ chủ nhà" / "Sổ quản lý", phiếu có hạng mục hạn chế bị che tên.

## 10. Ngoài phạm vi đợt này

- Chốt LN tháng (Profit Close) **không đổi** — vẫn chốt LN toàn toà; Báo cáo LN chỉ thêm dòng "Lợi nhuận của iHome".
- Hermes chưa đọc quyết toán vận hành.
