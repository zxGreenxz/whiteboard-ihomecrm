# Kiểm toàn bộ web trên TEST và rà soát mã — 11/10/2026

> Bản tổng hợp hợp nhất đợt 07/10 và đợt 11/10, đã gỡ số tiền, tên người/khách/sổ quỹ, mã phiếu/hợp đồng thật. Báo cáo gốc từng nhóm của đợt 11/10 lưu ngoài repo vì chứa dữ liệu thật của bản sao TEST; mã nguồn bằng chứng (S1…E) là tên nhóm trong cột 'Bằng chứng'.

## 0. Trạng thái phát hành, phạm vi, cách làm

| Hạng mục | Chi tiết |
|---|---|
| **Phát hành** | Đợt kiểm này KHÔNG đổi code production. **PR #154 đã áp production 11/10**: thu quyền `monthly_building_profit` (anon/PUBLIC/authenticated) và `approve_meter_reading`/`bulk_approve_meter_readings` (authenticated) — mục K11-01, K11-03. **Bản sửa ranh giới công ty (PR #156): migration `20261011042329` đã áp production 11/10 lúc 12:37; app phát hành production `2bf14a00` (READY, `release:verify`)**: 35 bảng NOT NULL + trigger điền org + bỏ nhánh NULL khỏi policy, trigger khoá `organization_id` trên 258 bảng, hook gửi org (commit `70a213e7`) — mục N-A6-11, K11-02. Mọi mục khác CHƯA sửa. Copilot: bỏ qua theo chủ. |
| **Phạm vi** | Toàn web: 117 route × 4 vai desktop 1440 + 19 trang × 2 vai mobile 390 + 7 trang công khai (489 lượt); luồng nghiệp vụ thao tác thật (hợp đồng/cọc/trả phòng; chỉ số/hoá đơn/thu tiền/bàn giao/chốt quỹ; thu chi/duyệt/cam kết/ví/lương/lợi nhuận; cài đặt/danh mục/tổ chức/vật tư/sale phòng/quay số/việc/báo cáo; ma trận quyền qua API); quét tĩnh toàn bộ `src/` (1.497 file, 1.113 lời gọi `.from()/.rpc()`), catalog 722 hàm EXECUTE được, 351 bảng có `organization_id`; review code mới dải `1c616829..3b899acc`. |
| **Cách làm** | Mã nguồn build `3b899acc` (= production lúc kiểm). Môi trường **TEST đồng bộ lại từ production ngày 11/10**; app thử là bản build trỏ TEST chạy loopback, trình duyệt chặn mọi request không thuộc app local/TEST — quét route đo được **0 request ra production**. Ba nhóm đọc tĩnh (S1 ranh giới công ty, S2 mẫu lỗi client, S3 review code mới) chỉ **đọc catalog/đếm gộp production bằng `npm run db:query` (chỉ đọc)**, không ghi, không gọi REST. Dữ liệu thử đặt tên có `AUDIT1110`. Các mục P0/P1 mới đã qua **phản biện độc lập** (đọc thân hàm production + đếm dữ liệu production chỉ-đọc + đo lại trên TEST khi yên); kết quả đã áp vào bảng này (xem mục 7). |
| **Đợt trước** | Đợt 07/10 (139 mục, đã commit): [README](../2026-10-07-kiem-thu-test-env/README.md) · [A1](../2026-10-07-kiem-thu-test-env/A1.md) · [A2](../2026-10-07-kiem-thu-test-env/A2.md) · [A3](../2026-10-07-kiem-thu-test-env/A3.md) · [A4](../2026-10-07-kiem-thu-test-env/A4.md) · [A5](../2026-10-07-kiem-thu-test-env/A5.md) · [A6](../2026-10-07-kiem-thu-test-env/A6.md) · [Phản biện](../2026-10-07-kiem-thu-test-env/PHAN-BIEN.md) · plan [sửa lỗi](../../superpowers/plans/2026-10-07-sua-loi-sau-kiem-thu-test.md). Gộp vào đây theo mã 07/10; mục mới có mã `K11-xx`. |

**Nhóm kiểm 11/10 (mã dùng ở cột Bằng chứng):** S1 ranh giới công ty + quyền máy chủ (tĩnh) · S2 mẫu lỗi phía client (tĩnh) · S3 review tính năng mới · G2 quét route × vai (mã Q-xx) · A hợp đồng/giữ chỗ/cọc/lock tạm/trả phòng · B chỉ số/hoá đơn/thu tiền/bàn giao/chốt quỹ · C thu chi/duyệt/cam kết/ví/lương/lợi nhuận · D cài đặt/danh mục/tổ chức/vật tư/sale phòng/quay số/việc/báo cáo · E ma trận quyền qua API.

**Mức:** P0 tiền sai/mất, lộ dữ liệu, lách quyền khai thác được · P1 chức năng hỏng/sai số liệu/lỗ quyền chưa khai thác · P2 UX/nhãn gây hiểu nhầm, lỗi phụ · P3 dọn dẹp. Khi nguồn bất đồng, lấy mức cao nhất có bằng chứng và ghi chú ở mục 7. **Trạng thái:** ĐÃ SỬA 11/10 · ĐÃ SỬA trước 11/10 · ĐANG SỬA · CÒN · tái hiện 11/10 (07/10 và 11/10 thấy lại — bằng thao tác TEST, hoặc đọc source/catalog nếu ghi 'đọc') · CÒN · chưa thử lại (07/10, 11/10 chưa động tới; mặc định còn vì S2 xác nhận 62 commit từ 07/10 không sửa lỗi 07/10) · MỚI 11/10 · CẦN CHỦ CHỐT · KHÔNG LỖI / ĐÚNG THIẾT KẾ.

## 1. Kết luận và thống kê

- Hợp nhất **211 mục**: 139 mục của đợt 07/10 (đã cập nhật trạng thái) + 72 mục mới `K11-xx` (đợt 11/10, sau khử trùng từ ~110 mã phát hiện của 9 báo cáo). Còn mở: **184** (P0/P1 còn mở: **25**).
- Đã sửa: **4** (PR #154: K11-01, K11-03; PR #156: N-A6-11, K11-02 — đã áp DB, app đã phát hành 2bf14a00) + **2** từ trước (L54 bởi PR #140; L09). Đang sửa: **0**. Không phải lỗi/đúng thiết kế: **21** (gồm 3 mục bác bỏ sau phản biện: K11-57, K11-35, K11-72).
- **Phản biện độc lập 11/10** (đọc thân hàm production, đếm dữ liệu production chỉ-đọc): bác bỏ K11-57 (C-01 — đúng cấu hình `all_buildings`), K11-35 (Q-02 — TEST quá tải), K11-72 (S2-12 — đo sai); hạ P1→P2: K11-04 (F5), K11-63 (D-02), K11-64 (D-03), K11-18 (D-06), K11-65 (D-07, bỏ phần đọc nhầm /apartments), K11-40 (A-01); giữ P1: K11-34, K11-37, K11-05, K11-62, N-A1-03 (tiềm ẩn).
- Trong 62 commit từ 07/10 tới `3b899acc` không có commit nào sửa lỗi 07/10 (chỉ sale-phong, ví công ty, Gmail, Zalo, CI) ⇒ 07/10 CÒN gần như nguyên; thêm lớp lỗi MỚI chủ yếu ở **quyền máy chủ** (hàm DEFINER thiếu kiểm quyền, ghi thẳng bảng tiền) và **tính năng ra từ 08–10/10** (ví công ty chết với người không phải super admin).
- Hai mẫu lỗi mới đáng quét hệ thống: **G7** RPC nhận lô ném cho cả lô khi một phần tử ngoài phạm vi (làm quản lý mất bảng lương); **G9** Zod chặt với `timestamptz::text` (làm sập `/quayso/admin`, họ lỗi 'Zod receipt' 30/09).

### 1.1 Mức × trạng thái

| Mức | ĐÃ SỬA 11/10 | ĐÃ SỬA trước 11/10 | ĐANG SỬA | CÒN · tái hiện 11/10 | CÒN · chưa thử lại | MỚI 11/10 | CẦN CHỦ CHỐT | KHÔNG LỖI / ĐÚNG THIẾT KẾ | Tổng | Còn mở |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| P0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **2** | 0 |
| P1 | 2 | 1 | 0 | 20 | 0 | 5 | 0 | 0 | **28** | 25 |
| P2 | 0 | 0 | 0 | 24 | 42 | 30 | 3 | 0 | **99** | 99 |
| P3 | 0 | 0 | 0 | 0 | 36 | 24 | 0 | 0 | **60** | 60 |
| Không phải lỗi | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 21 | **22** | 0 |
| **Tổng** | **4** | **2** | **0** | **44** | **78** | **59** | **3** | **21** | **211** | **184** |

### 1.2 Theo nhóm gốc

| Nhóm gốc | Tổng | Còn mở | P0/P1 còn mở | Ghi chú |
|---|---:|---:|---:|---|
| G1 — org / ranh giới công ty | 7 | 5 | 1 | N-A6-11 + K11-02 đã sửa DB (PR #156, app đã phát hành 2bf14a00); N-A5-06, K11-07 còn |
| G2 — quyền máy chủ ≠ giao diện | 30 | 28 | 7 | mở rộng 11/10: hàm DEFINER thiếu kiểm quyền (K11-05 P1), ghi thẳng bảng tiền (K11-24); K11-57 đã bác bỏ |
| G3 — bảng tenants/deposits cũ | 11 | 11 | 2 | S2 xác nhận không commit nào sửa từ 07/10; InvoicePrintPage đã đúng |
| G4 — OVERDUE / 'còn nợ' | 5 | 5 | 1 | dữ liệu OVERDUE đổi theo ngày ai mở trang Hoá đơn (không cron) |
| G5 — chạy từ trình duyệt | 3 | 3 | 1 | thêm: nhánh lương dự phòng ghi từ trình duyệt |
| G6 — cài đặt / tính năng 'ma' | 11 | 11 | 0 | D-13: công tắc theo tài khoản, hiển thị trái cờ công ty |
| G7 — RPC ném cả lô khi một phần tử ngoài phạm vi (MỚI) | 1 | 1 | 1 | nhóm mới: quét mọi RPC nhận lô |
| G8 — hiệu năng (MỚI) | 4 | 3 | 0 | đa số đo trên TEST Nano; cần đo lại trên production |
| G9 — đọc dữ liệu sai lặng lẽ: Zod chặt, cắt trang, nuốt lỗi (MỚI) | 10 | 10 | 4 | họ 'Zod receipt' 30/09 còn tái phát (D-01) |
| G10 — dữ liệu / trạng thái lệch cần soát tay (MỚI) | 9 | 9 | 0 | A-01, D-07, các mục dữ liệu 07/10 |
| Không thuộc nhóm gốc chung | 120 | 98 | 8 |  |


### 1.3 P0/P1 còn mở, xếp theo ưu tiên sửa (tiền / lộ dữ liệu / tính toàn vẹn trước, rồi chức năng hỏng) — 25 mục

| # | Mã | Mức | Trạng thái | Vì sao ưu tiên | Cỡ sửa |
|---:|---|---|---|---|---|
| 1 | **N-A2-07** | P1 | CÒN · tái hiện 11/10 | tiền biến khỏi sổ thật khi nhận bàn giao vào sổ ảo; đã chứng minh | S |
| 2 | **K11-24** | P1 | MỚI 11/10 | người có invoices.edit PATCH payments.amount thẳng (chưa ghi thử) | M |
| 3 | **K11-05** | P1 | MỚI 11/10 | tạo phiếu hoàn/giữ chỗ hoàn cho hoá đơn toà ngoài phạm vi; đặt đủ trần thì chặn hoàn thật; đã chứng minh | S |
| 4 | **L02** | P1 | CÒN · tái hiện 11/10 | tách quyền terminate/transfer/renew chỉ ở giao diện; 4 hàm thanh lý cũ còn mở | S–M |
| 5 | **N-A4-02** | P1 | CÒN · tái hiện 11/10 | người một toà ghi được bản ghi cấp công ty ở 8 bảng | M |
| 6 | **N-A1-05** | P1 | CÒN · tái hiện 11/10 | quyết toán xoá nợ làm tròn âm thầm; khác số trên màn xác nhận | S–M |
| 7 | **N-A1-03** | P1 | CÒN · tái hiện 11/10 | tiềm ẩn (production hiện 0 giữ chỗ): lần bỏ/hoàn cọc đầu tiên sẽ kẹt phòng, không giữ chỗ mới được | M |
| 8 | **L12** | P1 | CÒN · tái hiện 11/10 | nút Cọc ở Khách hẹn khoá phòng ngoài tầm nhìn, không gỡ được | S (ẩn nút) + M |
| 9 | **K11-37** | P1 | MỚI 11/10 | ví công ty chết với người không phải super admin (tác động production hôm nay nhỏ: 3 ví đều của super admin) | S |
| 10 | **K11-34** | P1 | MỚI 11/10 | quản lý không xem được lương của mình từ 30/09 (production: 23/49 phiếu tháng 9 ngoài phạm vi) | S–M |
| 11 | **N-A3-01** | P1 | CÒN · tái hiện 11/10 | báo cáo Lợi nhuận hỏng từ 30/09, chặn 'Chi lợi nhuận' | S |
| 12 | **L13e** | P1 | CÒN · tái hiện 11/10 | ghi chỉ số sai kỳ/chồng số, báo thành công | S–M |
| 13 | **N-A4-04** | P1 | CÒN · tái hiện 11/10 | công nợ tổng thiếu OVERDUE (chỉ thấy ~39% nợ) | S–M |
| 14 | **L36** | P1 | CÒN · tái hiện 11/10 | lịch thanh toán cắt 1.000 dòng cũ, sai theo thời gian | M |
| 15 | **N-A6-06** | P1 | CÒN · tái hiện 11/10 | báo cáo Khuyến mại sai số lượng và tổng | S–M |
| 16 | **L30** | P1 | CÒN · tái hiện 11/10 | thẻ thống kê hoá đơn = 0 cho Chủ công ty (production: 0 staff_assignments) | S–M |
| 17 | **N-A5-06** | P1 | CÒN · tái hiện 11/10 | Sale Phòng/trang công khai sai tập phòng; lộ giá+cọc phòng đã thuê cho ẩn danh | M |
| 18 | **L01** | P1 | CÒN · tái hiện 11/10 | đổi mật khẩu không cần mật khẩu hiện tại | S |
| 19 | **L11** | P1 | CÒN · tái hiện 11/10 | nhắc nợ/hết hạn chạy từ trình duyệt, chỉ nhắc người tạo bản ghi, bỏ sót OVERDUE (nhịp phát hiện tại khớp lịch hạn — K11-72 đã bác bỏ "ngừng phát") | M–L |
| 20 | **L13d** | P1 | CÒN · tái hiện 11/10 | import chỉ số chưa từng chạy; không có UI duyệt chỉ số | S–M |
| 21 | **N-A2-01** | P1 | CÒN · tái hiện 11/10 | form Thêm chỉ số trống tên công tơ → dễ nhập nhầm | S |
| 22 | **N-A1-UI-01** | P1 | CÒN · tái hiện 11/10 | chi tiết toà sai tab Hợp đồng/Hoá đơn | S–M |
| 23 | **L32** | P1 | CÒN · tái hiện 11/10 | khách 'N/A' ở 4 báo cáo BĐS và file xuất | M |
| 24 | **N-A6-S01** | P1 | CÒN · tái hiện 11/10 | không tạo/sửa được tài sản | S |
| 25 | **K11-62** | P1 | MỚI 11/10 | /quayso/admin hỏng trên production từ 30/09 (chưa ai bị chặn: 2 sự kiện đã quay) | S |

## 2. Danh sách hợp nhất (đã khử trùng)

Mỗi dòng gom mọi nguồn thấy cùng một lỗi (ví dụ **K11-34** = Q-01 = C-02; **N-A5-06** = 07/10 N-A5-06 + D-04; **N-A6-11** = S1-F2 = S2-15/16 = D-09 = E-05). Sắp theo nhóm gốc rồi mã.

### P0 (2)

| Mã (gộp nguồn) | Trạng thái | Nhóm | Hậu quả cho người dùng | Chỗ sửa | Bằng chứng |
|---|---|---|---|---|---|
| **N-A6-11** | ĐÃ SỬA 11/10 | G1 | Vật tư, kho, hotline, cấu hình gạch nợ và nhiều bảng khác lưu organization_id trống; công ty khác đọc/sửa/xoá được dòng đó (đã chứng minh đọc chéo sang công ty DEMO với vật tư và nhóm việc). Phạm vi mở rộng thành 35 bảng ghi từ client. Production hiện 0 dòng NULL ở bảng nghiệp vụ (chưa lộ), nhưng mọi dòng tạo mới sẽ lộ. | Hook thiếu withOrg: useMaterials.ts:88, useMaterialCategories.ts:33, useMaterialPurchases.ts:41,48,91, useMaterialAdjustments.ts:31,38, useAssetWarehouses.ts:48, useHotlines.ts:42, useAutoDebtConfig.ts:48, useAreas.ts:93,201, useShareholders.ts, useProfitManagers.ts, useJobGroups.ts:38, useServices.ts, useIncomeExpenseTemplates.ts:87, useSalaryConfig.ts, useLeadActivities.ts; policy *_org_boundary còn nhánh IS NULL. ĐÃ SỬA bởi PR #156: migration 20261011042329 đã áp production 11/10 12:37 (NOT NULL + trigger điền org + bỏ nhánh NULL + hook gửi org, commit 70a213e7) — đã áp DB, app đang chờ CI/promote (đang phát hành) | 07/10 README mục 3; 11/10 S1-F2, S2-15, S2-16, D-09, E-05 |
| **K11-01** | ĐÃ SỬA 11/10 | G2 | monthly_building_profit (SECURITY DEFINER) cho anon/PUBLIC gọi được và rơi về 'super admin đầu tiên' khi người gọi không có toà: trả thu/chi/lợi nhuận KQKD theo toà của công ty đầu tiên cho người chưa đăng nhập. | REVOKE anon/PUBLIC + bỏ nhánh fallback (không còn caller trong src); 20260703162000_monthly_building_profit_tenant_aware.sql:23-29; scripts/definer-acl-baseline.json:52. ĐÃ SỬA bởi PR #154 (commit d2ea1dcc, đã áp production 11/10) | 11/10 S1-F1, E-11 (TEST sau vá: anon=false); plan 02/09 FR011-C01 (P2 'còn mở') |


### P1 (28)

| Mã (gộp nguồn) | Trạng thái | Nhóm | Hậu quả cho người dùng | Chỗ sửa | Bằng chứng |
|---|---|---|---|---|---|
| **K11-02** | ĐÃ SỬA 11/10 | G1 | 'Gỡ dấu công ty': người có quyền sửa dòng đặt được organization_id = NULL trên dòng của mình (policy ranh giới có WITH CHECK '… IS NULL', không trigger bất biến org) → dòng thoát khỏi ranh giới mọi công ty (đã chứng minh trên phòng). | 122 policy *_org_boundary bỏ nhánh IS NULL + trigger khoá organization_id trên 258 bảng; autofill_org_strict chỉ chạy BEFORE INSERT. ĐÃ SỬA bởi PR #156 (migration 20261011042329 áp production 11/10 12:37; app đang chờ CI/promote) | 11/10 S1-F3, E-06 (thật trên TEST) |
| **N-A5-06** | CÒN · tái hiện 11/10 | G1 | Sale Phòng và trang công khai /phongtrong lấy tập phòng theo MỘT chủ sở hữu cố định, không theo công ty/phạm vi: Chủ công ty thấy 0 phòng, quản lý/đối tác thấy cả toà ngoài phạm vi, link chia sẻ trả 0 toà, trang thiếu toà do người khác tạo; ẩn danh còn thấy giá thuê + cọc của phòng ĐÃ THUÊ. (07/10 xếp P2, 11/10 mở rộng nên P1.) | get_public_available_rooms / get_my_available_rooms lọc buildings.user_id → lọc theo công ty của token + phạm vi; bỏ rent_price/deposit_amount của phòng đã thuê khỏi payload công khai (Q6) | 07/10 A5; 11/10 D-04 (thật), S1-F8 |
| **K11-03** | ĐÃ SỬA 11/10 | G2 | approve_meter_reading(uuid) và bulk_approve_meter_readings(uuid[]) (DEFINER) không kiểm quyền/toà/org: người đăng nhập bất kỳ duyệt được chỉ số của công ty khác nếu biết id. | REVOKE EXECUTE FROM authenticated (không còn caller, src dùng _v1). ĐÃ SỬA bởi PR #154 (đã áp production 11/10); plan 12/08 security-remediation:517 đã đề ra từ trước | 11/10 S1-F4 |
| **K11-05** | MỚI 11/10 | G2 | Mọi thành viên công ty tạo được phiếu chi 'Hoàn tiền hoá đơn' (UNAPPROVED) và giữ chỗ hoàn HELD cho hoá đơn bất kỳ trong công ty, kể cả toà ngoài phạm vi; đặt đủ trần hoàn (trừ vào paid_amount) thì CHẶN hoàn thật của hoá đơn đó, và phiếu chi chưa duyệt tính vào KQKD, chặn chốt kỳ khi còn chờ. Phiếu vẫn phải duyệt nên chưa tự ra tiền; cần biết uuid hoá đơn nên không P0. | create_invoice_refund_obligation_v2 chỉ gọi ie_compat_actor_v2 (membership ACTIVE) → thêm quyền hoàn tiền + phạm vi toà; app_private.reserve_invoice_refund_obligation_v2; caller useInvoicePayments.ts:137; gỡ được qua decide_owned_income_expense_v2('cancel') (cần income_expenses.approve) | 11/10 S1-F6, E-01 (thật trên TEST) → PHAN-BIEN-1110 #4b (GIỮ P1) |
| **K11-24** | MỚI 11/10 | G2 | (Chưa thử ghi) Người có invoices.edit PATCH được payments.amount thẳng qua REST, không qua RPC thu tiền; payments còn cho DELETE từ client (phía client thừa vì phiếu huỷ đã có reversed_at). Hoá đơn/invoice_items cũng ghi thẳng từ trình duyệt. | RLS payments_insert/update/delete_rbac (has_perm_full_scope('invoices',…)); usePayments.ts:241, income-expenses/batch.ts:397, statusMutations.ts:437, useUploadPaymentReceipt.ts:52; useInvoices.ts:808,859,975,1002,1027,1192,1249,1310,1480 | 11/10 S2 mục 6 (đọc source + policy, CHƯA ghi thử) |
| **K11-37** | MỚI 11/10 | G2 | Ví công ty không dùng được cho mọi người trừ super admin: company_wallet_snapshot trả 403 'company_wallet_permission: organization' dù là Chủ công ty ACTIVE; tab Công ty treo 'Chưa tải được', và mỗi lần mở /finance/personal-wallet bắn thêm 403 + toast (cả tab Cá nhân). | 20261008164757_company_wallets…sql:77,103,166: hàm SECURITY INVOKER kiểm EXISTS trên organization_memberships nhưng bảng chỉ có policy SELECT cho super admin → dùng SECURITY DEFINER hoặc my_org_ids(); ẩn tab/không tự tải khi không có quyền | 11/10 C-03, Q-05 (thật) → PHAN-BIEN-1110 #3 (GIỮ P1, tác động production hôm nay nhỏ: 3 ví công ty đều của super admin; người khác có ví cá nhân mở /finance/personal-wallet ăn 403 + toast; test companyWallet/migration.test.ts:22 tự tạo policy mà production không có nên che lỗi); S1 §5 và S3 đọc tĩnh KHÔNG thấy lỗi này |
| **L02** | CÒN · tái hiện 11/10 | G2 | Người bị CẤM contracts.terminate nhưng có contracts.edit vẫn thanh lý/chuyển phòng/gia hạn được qua API (UI chỉ ẩn nút); 4 hàm thanh lý cũ không còn màn gọi vẫn mở cho người đăng nhập. Hôm nay 0 người bị ảnh hưởng; thành P0 khi tách vai. | app_private.assert_contract_exit_writer_v1 + transfer_room/transfer_contract/apply_contract_notice_transition_v1/renew_contract; REVOKE terminate_contract_move_out, terminate_contract_forfeit (+ 2 bản _with_credit_v1) | 07/10 A1 + PHAN-BIEN; 11/10 S1-F7 (đọc lại thân hàm, chưa gọi thử) |
| **L30** | CÒN · tái hiện 11/10 | G2 | Thẻ thống kê Hoá đơn ra 0 cho Chủ công ty (mọi 12 thẻ), Quản Lý Tòa thiếu 1 toà, DEMO 7/8 người thấy 0 — vì phạm vi tính qua staff_assignments chứ không qua RBAC. | get_invoice_statistics_v2 dùng app_private.buildings_for_v3('invoices.view'); rà các RPC báo cáo khác còn dùng staff_assignments | 07/10 A2 + PHAN-BIEN; 11/10 B-07 (thật; quản lý cùng trang có số) + PHAN-BIEN-1110 #11 (Chủ công ty nhận toàn 0, production 0 staff_assignments: L30 CÒN nguyên) |
| **N-A2-07** | CÒN · tái hiện 11/10 | G2 | Nhận bàn giao tiền mặt vào SỔ ẢO: bên giao bị trừ (POSTED), bên nhận không ghi sổ, tiền biến khỏi sổ thật; người đa công ty còn chọn được sổ công ty khác. Đã chứng minh lại 11/10. | confirm_cash_handover (20260813010000…:95-100) từ chối is_virtual và sổ khác tổ chức; HandoverSheet.tsx:109-114,304-316 receiveBooks lọc is_virtual | 07/10 A2 + PHAN-BIEN; 11/10 B-09 (thật trên TEST), S1-F7 |
| **N-A4-02** | CÒN · tái hiện 11/10 | G2 | Người chỉ được giao MỘT toà tạo/sửa/xoá được bản ghi cấp công ty (building_id NULL) ở 8 bảng; 48 bảng có policy ghi chỉ dùng hàm này, 38 bảng không có điều kiện toà. | can_access_org_entity (= is_super_admin() OR has_any_scope_v3) → đòi phạm vi toàn công ty ở nhánh NULL | 07/10 A4; 11/10 S1-F7 (catalog) |
| **L12** | CÒN · tái hiện 11/10 | G3 | Nút 'Cọc' ở Khách hẹn ghi bảng deposits cũ: khoá phòng ngoài tầm nhìn (phòng thành RESERVED, biến khỏi sale), chặn cả giữ chỗ lẫn ký HĐ; không màn nào gỡ được; lỗi hiện 'Chưa xác định được nguyên nhân'. | ConvertLeadDialog.tsx:151-162; room_has_holding_deposit; reservation_room_blockers_v1; assert_room_reservation_legacy_sources_v1; useDeposits.ts:274,315,353,388; financeReports.ts:152-178 | 07/10 A1 + PHAN-BIEN; 11/10 A (thật), S2-07a, D (cùng gốc) |
| **L32** | CÒN · tái hiện 11/10 | G3 | 4 báo cáo BĐS (Khuyến mại, Cho thuê mới, Bỏ trả, Sắp hết hạn) hiện khách 'N/A' cho 100% hợp đồng, cả file xuất; cùng lỗi ở xuất Excel Hợp đồng/Hoá đơn/Thanh toán. | realEstateReports.ts:361,715,788,855; exportDatasetRegistry.ts:81-98,110,147 → contract_customers!contract_customers_contract_id_fkey(customer:customers!…_customer_id_fkey) | 07/10 A6 + PHAN-BIEN; 11/10 D-12 (thật), S2-05 |
| **N-A4-04** | CÒN · tái hiện 11/10 | G4 | 'Công nợ tổng', biểu đồ Công nợ và cảnh báo 'Hoá đơn quá hạn' bỏ hoá đơn OVERDUE: chỉ thấy khoảng 39% nợ; cảnh báo quá hạn lại chỉ liệt kê hoá đơn CHƯA bị gắn quá hạn. | get_dashboard_summary; DebtChart.tsx:35; useDashboard.ts:248-252; notificationScheduler.ts:114,176 → một định nghĩa 'còn nợ' = APPROVED, PARTIAL_PAID, OVERDUE | 07/10 A4 + README; 11/10 S2-01 (source + đếm production) |
| **L11** | CÒN · tái hiện 11/10 | G5 | Nhắc việc chạy TỪ TRÌNH DUYỆT khi có người mở Bảng tin desktop, chỉ nhắc người tạo bản ghi (Chủ công ty nhận 0), chèn trùng, nội dung 'của undefined', nhắc nợ bỏ OVERDUE. (Phần 'nhắc nợ/hết hạn đã ngừng phát' của S2-12 bị BÁC BỎ: bộ nhắc chỉ gửi khi còn đúng 7/3/1 ngày tới hạn, đợt gần nhất không còn gì để nhắc.) | useScheduledNotifications.ts; notificationScheduler.ts (mọi truy vấn bỏ error: 24,45,68,104,129,166,188,247,271; insert 80,310); invoiceHelpers.ts:27,73,172,211 → cron máy chủ theo khuôn dispatch_lifecycle_reminders_v1, UNIQUE (user,loại,ref,ngày VN) | 07/10 A6 + PHAN-BIEN; 11/10 S2-12 (đọc source; kết luận 'đã ngừng' bị bác bỏ ở PHAN-BIEN-1110 #12 — còn đúng: chạy trong trình duyệt, nuốt lỗi, chỉ quét hoá đơn có user_id = người đang mở app), Q-06 |
| **K11-34** | MỚI 11/10 | G7 | Quản lý không xem được bảng lương của chính mình ('Chưa tải được bảng lương', cả /finance/salary và /finance/my-salary, desktop+mobile) từ 30/09; bảng lương chủ 'Xem dưới vai trò' quản lý cũng hỏng. RPC ném cho CẢ lô khi MỘT phiếu nguồn hoa hồng nằm ở toà ngoài phạm vi (người giữ sổ thấy phiếu mọi toà qua policy fund_member). | read_rent_support_salary_parts_v1 (20260930112705…:~797): bỏ qua/đánh NEEDS_REVIEW thay vì RAISE; rentSupportSalary.ts:12 gửi cả lô | 11/10 Q-01, C-02 (thật trên TEST) → PHAN-BIEN-1110 #1 (GIỮ P1; thân hàm production y hệt; số TEST trùng production). Production: quản lý A tháng 9 thấy 49 phiếu nguồn, 23 ngoài phạm vi; tháng 10 8 phiếu, 5 ngoài phạm vi; quản lý B tháng 9 43 phiếu, 19 ngoài (tháng 10 0 ngoài nên xem được) |
| **K11-62** | MỚI 11/10 | G9 | /quayso/admin luôn hiện 'Không mở được trang quản trị sự kiện' dù RPC trả ok:true — hỏng trên production từ 30/09 (40/40 mốc thời gian trong dữ liệu thật sai dạng); chưa ai bị chặn vì cả 2 sự kiện đã quay, sự kiện mới sẽ không quản trị được; trang công khai của đội đã nộp giấy tờ có thể vỡ (chưa đo). | src/lib/luckyReadModels.ts:7-8 (proof.at: timestamp), publicFeedback.ts:32-36; hàm SQL trả timestamptz::text (khoảng trắng, không có T) nên Zod datetime({offset:true}) từ chối; họ lỗi 'Zod receipt' 30/09 | 11/10 D-01 (thật) → PHAN-BIEN-1110 #5 (GIỮ P1; prod lucky_event_teams.proofs 40/40 sai dạng, do lucky_save_payout_v1 ghi now()::text) |
| **L36** | CÒN · tái hiện 11/10 | G9 | Lịch thanh toán cắt 1.000 dòng CŨ nhất: các phòng hiện sai 'đã lên HĐ đến' (dừng ở 31/08), không có cột tiền, lọc phòng không chạy, tính cả hoá đơn đã thu. | financeReports.ts:25-44 (usePaymentScheduleReport) → RPC gộp theo phòng (kỳ lớn nhất, còn nợ), ô phòng thật, cột tiền | 07/10 A2 + PHAN-BIEN; 11/10 D-12, S2-10a |
| **N-A1-UI-01** | CÒN · tái hiện 11/10 | G9 | Chi tiết toà: tab Hợp đồng/Hoá đơn sai (limit 50 áp trước khi lọc; nhiều toà hiện cùng một danh sách 50 hoá đơn, cột Khách hàng '-'). | usePropertyDetailQueries.ts:93-99 (!inner + lọc máy chủ + count thật) | 07/10 A1-ui; 11/10 D-05 (thật), S2-10b |
| **N-A3-01** | CÒN · tái hiện 11/10 | G9 | Báo cáo Lợi Nhuận → tab Tổng quan (và Chốt LN tháng kiểu cũ) báo 'Chưa tải được lợi nhuận và cấu hình phân bổ' — hỏng từ 30/09; chặn luôn 'Chi lợi nhuận'. | src/lib/profitReadModels.ts:18 disposition() nhận LEGACY_RETAINED_UNALLOCATED (+ kiểu, nhãn 'Giữ lại (chốt kiểu cũ)') | 07/10 A3 + README; 11/10 C-04 (tái hiện, 18 dòng LEGACY_RETAINED_UNALLOCATED) |
| **L01** | CÒN · tái hiện 11/10 | — | Đổi mật khẩu không kiểm 'Mật khẩu hiện tại': nhập sai vẫn đổi được (desktop + mobile). | useProfile.ts:166-171 (signInWithPassword trước updateUser); ProfilePage.tsx; AccountMobilePage.tsx. Q4: KHÔNG bật Secure password change | 07/10 A4; 11/10 D-10 (thật) |
| **L13d** | CÒN · tái hiện 11/10 | — | Import chỉ số .xlsx chưa bao giờ chạy được (hàm cũ tìm công tơ theo user_id người gọi): 'Nhập xong: 0 thành công' nhưng tiêu đề vẫn 'Hoàn tất'; và không có UI duyệt/bỏ duyệt/duyệt hàng loạt chỉ số dù RPC _v1 đúng. | bulk_create_meter_readings (REVOKE) → bulk_create_meter_readings_v1 tra mã công tơ trong phạm vi toà; useMeterReadings.ts:429; thêm menu hàng 'Duyệt/Bỏ duyệt' + thanh hàng loạt | 07/10 A2 + PHAN-BIEN; 11/10 B-04, B-05 (thật) |
| **L13e** | CÒN · tái hiện 11/10 | — | Ghi chỉ số: ô 'Tháng chốt' bị bỏ qua, số đầu lấy từ bản ghi NGÀY SAU, ghi trùng công tơ + kỳ nhưng báo thành công (07/10 xếp P2, 11/10 thấy chồng số thật nên nâng P1). | meterReadingValidation.ts:23; chỉ số liền trước theo ngày; bắt Ngày chốt nằm trong Tháng chốt; chỉ mục một phần (không UNIQUE trần vì có chỉ số chốt trả phòng) | 07/10 A2 (P2); 11/10 B-03 (thật) |
| **L54** | ĐÃ SỬA trước 11/10 | — | Script promote chỉ chấm CI của SHA đích nên commit đỏ nằm giữa lọt lên production (7/13 lần promote 05–07/10 mang theo push đỏ/huỷ). | scripts/promote-to-production.mjs, .github/workflows/ci-gates.yml: promote chỉ nhận aggregate phủ dải production..đích (evidenceCoversProduction), không huỷ run trên main, --sha tự giải, tự chờ Vercel. ĐÃ SỬA bởi PR #140 (merge 07/10 23:21); lần promote kế tiếp phải cho CI chạy lại dải production..main | 07/10 A5 + README mục 3; plan 07/10 mục 0.5 |
| **N-A1-03** | CÒN · tái hiện 11/10 | — | Sau 'Xử lý bỏ cọc' (và cả Hoàn cọc) giữ chỗ + claim vẫn sống: phòng về AVAILABLE nhưng biến khỏi danh sách sale và trang công khai, và không tạo được giữ chỗ mới (500/55000). Lối thoát duy nhất là bấm tay 'Hủy giữ chỗ', UI không nhắc. | settle_reservation_deposit_v1 / reservation_pay_refund_v1 đóng giữ chỗ + claim cùng giao dịch; reservation_room_blockers_v1 thêm claim LIVE; ReservationSettlementDialog.tsx:80 | 07/10 A1 + PHAN-BIEN; 11/10 A (tái hiện, nặng hơn 07/10) → PHAN-BIEN-1110 #13 (GIỮ P1, tiềm ẩn: production hiện 0 giữ chỗ/0 claim nên chưa phòng nào kẹt; mã production không đóng giữ chỗ nên lần bỏ/hoàn cọc đầu tiên sẽ kẹt như TEST) |
| **N-A1-05** | CÒN · tái hiện 11/10 | — | Quyết toán trả phòng thu lại phần làm tròn của hoá đơn ĐÃ TRẢ ĐỦ: tiền nợ ghi khác số trên màn xác nhận, phần lệch bị xoá nợ âm thầm (không phiếu thu/chi đỡ lưng). | vòng lặp trong terminate_contract_move_out_impl (20260915074638…:627-646) bỏ hoá đơn PAID; useContracts.ts:1086-1087 dùng chung một danh sách nợ | 07/10 A1 + PHAN-BIEN; 11/10 A (tái hiện) |
| **N-A2-01** | CÒN · tái hiện 11/10 | — | Form Thêm chỉ số: cột 'Tên công tơ' trống, ô nhập không có nhãn, không có cột phòng (80DS3 tháng 11: 20 dòng chỉ có số đầu) → dễ nhập nhầm công tơ. | meterReadingFormUtils.ts:11-19,102-105 đọc code/room_name; MeterReadingForm.tsx:573 | 07/10 A2 + PHAN-BIEN; 11/10 B-01 (thật) |
| **N-A6-06** | CÒN · tái hiện 11/10 | — | Báo cáo Khuyến mại đếm gần như mọi hợp đồng là 'có giảm giá' và tổng giảm = 0 (từng dòng '-0'). | realEstateReports.ts:722,744 chỉ tính jsonb_typeof='object', giảm ≠ 0, đọc months × amount_per_month | 07/10 A6 + PHAN-BIEN; 11/10 D-12 (thật) |
| **N-A6-S01** | CÒN · tái hiện 11/10 | — | Không tạo/sửa được tài sản: bắt buộc 'Loại tài sản' mà danh mục rỗng; bấm 'Tạo tài sản' không có toast/lỗi, DB không có dòng. | CreateAssetDialog.tsx:27,58; EditAssetDialog.tsx:27,65,107 (Zod optional, gửi null — đừng gửi 'none') | 07/10 A6 + PHAN-BIEN; 11/10 D-11 (thật), S2-09 |


### P2 (99)

| Mã (gộp nguồn) | Trạng thái | Nhóm | Hậu quả cho người dùng | Chỗ sửa | Bằng chứng |
|---|---|---|---|---|---|
| **K11-07** | MỚI 11/10 | G1 | Nhóm lương v5 và thông báo dùng 'super admin đầu tiên' làm chủ mọi công ty: thông báo và luật thưởng của nhân viên công ty khác chảy về một tài khoản. | award_job_bonus, request_paid_leave, v5_appeal, report_device_issue, salary_work_ledger, get_salary_progress_v5, set_salary_v5_config, v5_apply_lock_adjustments | 11/10 S1-F9 (đọc thân hàm); trùng nhóm FR009/FR011 plan 02/09 |
| **N-A2-06** | CÒN · chưa thử lại | G1 | Người dùng thuộc 2 công ty không tạo được phiên bàn giao (23502). | create_cash_handover lấy org từ sổ nguồn | 07/10 A2 + PHAN-BIEN |
| **N-A4-03** | CÒN · chưa thử lại | G1 | Super admin (2 công ty) không lưu được bất kỳ cài đặt nào (23502) → bán kính nghiệm thu của cả đội không đổi được. | useSettings.ts:182-185,365-367,469-471 gửi organization_id | 07/10 A4 + PHAN-BIEN; 11/10 S1 §2 (settings nay có trigger điền org — chưa thử người đa công ty) |
| **N-A6-12** | CÒN · chưa thử lại | G1 | Super admin không tạo được phiếu xuất vật tư (23502). | useMaterialUsages.ts:107; S1: material_usages nay có trigger điền org | 07/10 A6; 11/10 S1 §2 (chưa thử lại) |
| **K11-04** | MỚI 11/10 | G2 | (Hạ P1→P2 sau phản biện) Người đăng nhập bất kỳ, kể cả công ty khác, chèn được ghi chú rác (NOTE/CANCELLED_NOTE/MANUAL_LOG, tên người ghi là thật) vào chuỗi audit băm của phiếu khi biết uuid; không đổi tiền/trạng thái, không xoá được vì chuỗi append-only; phản hồi P0002 vs 204 còn là 'máy dò' uuid tồn tại. | log_income_expense_action chỉ đòi auth.uid(): thêm kiểm membership org của phiếu + quyền xem/sửa phiếu; caller hợp lệ statusMutations.ts:450 | 11/10 S1-F5, E-02 (thật trên TEST) → PHAN-BIEN-1110 #4a (hạ P2) |
| **K11-06** | MỚI 11/10 | G2 | get_my_available_rooms() không kiểm sale_phong.view hay phạm vi: ai có staff_assignments (kể cả đối tác không có quyền sale) gọi được và nhận cả danh sách phòng + trường sale_bonus_note (ghi chú thưởng sale nội bộ); chủ sở hữu lấy LIMIT 1 không ORDER BY. (Bất đồng mức: S1 xếp P2, E xếp P1/P2 vì mới chứng minh cấu trúc — trường sale_bonus_note rỗng trên TEST.) | get_my_available_rooms (3 migration 202610): thêm kiểm sale_phong.view + phạm vi toà; bỏ owner LIMIT 1 (gộp với N-A5-06) | 11/10 S1-F8, E-03 (thật, cấu trúc) |
| **K11-08** | MỚI 11/10 | G2 | Policy reservation_hold_deadlines_select = true: thành viên công ty nào cũng đọc hạn giữ chỗ (hold_until) và mức cọc mục tiêu của mọi phiếu giữ chỗ, không theo toà/quyền. | pg_policy reservation_hold_deadlines_select (migration 22/08) → theo buildings_for_v3 | 11/10 S1-F10, E-04 (chỉ policy, bảng rỗng trên TEST) |
| **K11-09** | MỚI 11/10 | G2 | Chủ công ty xem báo cáo Lợi nhuận/Cổ đông trống một cách im lặng ('Chưa có cổ đông', toàn 0): REST trả 0 dòng cho chủ công ty vì policy theo user_id, trong khi super admin thấy dữ liệu. Nhóm cấu hình theo auth.uid()=user_id (cổ đông, quản lý lợi nhuận, lương quản lý, thưởng, ngày lễ) cũng ghi không kèm org nên 'Chủ công ty' không thấy dòng mới. | policy shareholders/building_shareholders/profit_managers/profit_monthly… thêm nhánh my_company_owner_org_ids_v1; hook ghi kèm org | 11/10 S1-F11, C-05 (thật) |
| **K11-26** | MỚI 11/10 | G2 | useProfile.ts update(data) trên profiles: authenticated có quyền UPDATE mọi cột (organization_id, is_active, subscription_plan, subscription_expires_at, employee_code, department, job_title) — người dùng tự đổi gói/trạng thái/mã nhân viên. UI chỉ sửa họ tên/SĐT/ảnh; subscription_plan hiện không dùng để chặn tính năng nào. user_subscriptions insert/update (useSubscription.ts:79,106,134) cần kiểm RLS không cho tự cấp. | REVOKE UPDATE cột nhạy cảm của profiles, giữ cột hồ sơ; useProfile.ts:91 | 11/10 S2 mục 6.7-6.8 (đọc source + policy, chưa ghi thử) |
| **K11-27** | CẦN CHỦ CHỐT | G2 | Sửa giá thuê/loại/nội thất/tình trạng phòng (Sale Phòng, Cài đặt hiển thị) ghi thẳng bảng rooms: UI kiểm quyền sale_phong.*, RLS kiểm rooms.edit theo toà → người có rooms.edit nhưng không có quyền sale đổi được giá qua API; người chỉ có quyền sale bị RLS từ chối. | useSaveRoomListSheet.ts:79, useRooms.ts:129,144,181, sale-phong/*; policy rooms_update_rbac (buildings_for_v3('rooms.edit')) — cần chốt quyền nào quyết định (Q13) | 11/10 S2 mục 6.4 (đọc source, chưa đối chiếu thật) |
| **K11-36** | MỚI 11/10 | G2 | /settings/finance/cam-ket-chi qua được guard thu_tien.collect nhưng RPC chỉ cho chủ: quản lý và đối tác thấy 'Chưa tải được' + 2×403. (Chủ công ty vào được.) | guard route ≠ quyền get_spend_engine_status_v1 (42501): đồng bộ guard với RPC | 11/10 Q-04 (thật); C xác nhận Chủ công ty không còn lỗi |
| **K11-53** | MỚI 11/10 | G2 | Chi tiết sổ quỹ của quản lý không giữ sổ: 'Số dư hiện tại: 0' (thực khác 0; danh sách hiện '—'), 'Chưa tải được phân quyền sổ' (403 get_cashbook_access_admin_v2 'cashbooks.share required'), nhưng vẫn hiện nút Chỉnh sửa/Xoá. | trang chi tiết sổ quỹ: ẩn số dư/nút theo quyền, không hiện 0 khi không đọc được | 11/10 B-10 (thật) |
| **K11-59** | CẦN CHỦ CHỐT | G2 | Người giữ sổ (quản lý) thấy phiếu của MỌI toà đi qua sổ mình giữ (danh sách Thu chi, tổng Thu cả toà ngoài phạm vi) vì nhánh select_fund_member vượt phạm vi toà. Đây cũng là gốc của K11-34. | policy income_expenses_select_fund_member — chốt có chủ ý không (Q12) | 11/10 C-08 (thật) |
| **L04** | CÒN · chưa thử lại | G2 | Màn Trung tâm tài chính: người không xem được báo cáo vẫn đổi được phân loại vai trò tài chính của cả công ty (qua quyền cấp riêng categories.* còn sót). | RPC dùng ie_type_rule_editor_ok_v1; route gác reports_finance.analysis; thu hồi quyền cấp riêng (Q11) | 07/10 A3 + PHAN-BIEN |
| **L05** | CÒN · chưa thử lại | G2 | Nút Xuất báo cáo BĐS/tài chính không kiểm reports_*.export. | canExport cho ExportButtons | 07/10 A4 |
| **L06** | CÒN · chưa thử lại | G2 | Trang CRUD cài đặt luôn hiện Thêm/Sửa/Xoá dù máy chủ chặn đúng. | permissionModule cho CategoryCrudPage | 07/10 A4 |
| **L07** | CÒN · chưa thử lại | G2 | dashboard.view_finance không ẩn thẻ tiền; route '/' không kiểm dashboard.view. | Dashboard cards + HomeRoute | 07/10 A4 |
| **L13c** | CÒN · chưa thử lại | G2 | Chỉ số đã duyệt vẫn sửa/xoá được (kể cả nhân viên qua API), không nối lại chuỗi. | chặn sửa chỉ số đã lên hoá đơn; useMeterReadings.ts:318,382,552, useInvoices.ts:1577,1682 | 07/10 A2; 11/10 S2 mục 6.5 |
| **N-A4-01** | CÒN · chưa thử lại | G2 | Nút 'Toà đang phụ trách' khi thêm ngoại lệ quyền lại lưu phạm vi TOÀN CÔNG TY. | phân quyền | 07/10 A4 |
| **N-A5-01** | CÒN · chưa thử lại | G2 | reverse_invoice_payment_v3 còn cho authenticated gọi, khoá org trước khi kiểm quyền. | REVOKE EXECUTE FROM authenticated (không còn call site) | 07/10 A5 |
| **N-A6-08** | CÒN · chưa thử lại | G2 | Quyền 'Hoàn thành công việc' (tasks.complete) không được kiểm ở đâu: ai có tasks.edit đều hoàn thành được và được chấm công. (Hạ P1→P2: không lách phạm vi; chờ Q1.) | jobs_update_rbac (20260725200000…:341-344) / RPC hoàn thành việc; cấp tasks.complete cho Quản Lý Tòa TRƯỚC | 07/10 A6 + PHAN-BIEN |
| **K11-17** | MỚI 11/10 | G3 | tenant_name của phiếu thu chi luôn null; nhánh 'tìm theo tên khách' tra bảng tenants rỗng nên không bao giờ thêm điều kiện (im lặng). | hooks/income-expenses/queries.ts:303,387-395,444,847,916; detailRead.ts:84,210-240 → contract_customers/customers | 11/10 S2-06 (đọc source); cùng gốc G3 |
| **K11-18** | MỚI 11/10 | G3 | (Hạ P1→P2 sau phản biện) Báo cáo Tài chính → 'Danh sách tiền cọc' luôn Tổng 0 / 0 bản ghi vì đọc bảng deposits cũ (0 dòng) trong khi hàng trăm hợp đồng đang hiệu lực giữ tiền cọc thật. Tài liệu 04-coc-giu-cho §2.1/§5.6 đã ghi báo cáo này là legacy (nguồn đúng là /deposits): lỗi thật, đã biết — nên ẩn hoặc trỏ về /deposits. | src/hooks/reports/financeReports.ts:144-178 và get_deposits_report_summary (FROM public.deposits) → ẩn/trỏ về /deposits hoặc đọc deposit_paid của HĐ + room_reservations (cùng gốc N-A6-04, L12) | 11/10 D-06 (thật), S2-07a → PHAN-BIEN-1110 #8 (hạ P2) |
| **L29** | CÒN · tái hiện 11/10 | G3 | Hộp Ghi nhận thanh toán trống 'Khách hàng:'. | RecordPaymentDialog.tsx:830-831 | 07/10 A2; 11/10 B-13 (thật) |
| **L31** | CÒN · tái hiện 11/10 | G3 | Hộp chi tiết phòng ở Sơ đồ toà trống 'Khách hàng:'. | RoomDetailDialog.tsx:70 | 07/10 A1-ui; 11/10 S2-05 (đọc source) |
| **N-A1-UI-02** | CÒN · tái hiện 11/10 | G3 | Chi tiết căn hộ/toà đọc bảng tenants cũ: 'Căn hộ chưa có khách hàng' / tab 'Khách hàng (0)' với phòng đang thuê. (D-05 xếp P1 khi gộp với N-A1-UI-01; 07/10 xếp P2 vì lối vào hiếm — thành P1 ngay khi sửa L20/L73.) | usePropertyDetailQueries.ts:73,78,83,93,99; link khách /tenants/ → /customers/:id (:358,424) | 07/10 A1-ui + PHAN-BIEN; 11/10 D-05 (thật), S2-05 |
| **N-A6-02** | CÒN · tái hiện 11/10 | G3 | 'Công việc chưa xử lý' đọc bảng issues (0 dòng) thay vì jobs. | useDashboard.ts:310,476 | 07/10 A6; 11/10 S2-09 (đọc source) |
| **N-A6-04** | CÒN · tái hiện 11/10 | G3 | 'Tổng quan đặt cọc' đếm bảng deposits cũ → luôn 0 (cùng gốc K11-18). | useDeposits.ts; gộp 1.4 | 07/10 A6; 11/10 D-06, S2-07a |
| **N-A6-14** | CÒN · tái hiện 11/10 | G3 | Thông báo hết hạn HĐ và nhắc nợ thiếu tên khách ('của undefined'); /notifications hiện chữ 'undefined'. | notificationScheduler.ts:50,111,173; invoiceHelpers.ts:148 → contract_customers | 07/10 A6; 11/10 Q-06 (thật), S2-05 |
| **K11-14** | MỚI 11/10 | G4 | OVERDUE chỉ được gắn khi AI ĐÓ mở trang Hoá đơn trên trình duyệt (không có cron mark_overdue_invoices_v1) và chỉ cho hoá đơn APPROVED chưa thu trong toà người mở sửa được; PARTIAL_PAID quá hạn không bao giờ thành OVERDUE. Số 'quá hạn' đổi theo việc ai mở trang ngày nào; nhánh dự phòng còn UPDATE status='OVERDUE' thẳng từ client. | useInvoices.ts:1446-1500 (useCheckOverdueInvoices; gọi duy nhất ở InvoicesPage.tsx:165, UPDATE thẳng :1480) → cron máy chủ mark_overdue_invoices_v1 (gộp Đợt 2.2/1.5) | 11/10 S2-02, B-08 (cron.job chỉ có 6–8 job, không có); mở rộng L11/N-A4-04 |
| **K11-15** | MỚI 11/10 | G4 | Nhãn 'Quá hạn' sai: hoá đơn ĐÃ HUỶ/NHÁP còn 'nợ' vẫn gắn 'Quá hạn' (trang công khai gửi khách có thể hiện khung đỏ 'đã quá hạn thanh toán' cho hoá đơn đã huỷ — chưa kiểm RPC công khai có trả hoá đơn huỷ không); hoá đơn hết hạn đúng ngày đã báo 'Quá hạn' từ 07:00 giờ VN (new Date('YYYY-MM-DD') là UTC). | InvoiceDetailView.tsx:267; InvoiceDetailMobile.tsx:124-128; PublicContractInvoicePage.tsx:221-224,421 (loại CANCELLED/DRAFT, so sánh theo ngày VN) | 11/10 S2-03 (đọc source) |
| **L49** | CÒN · tái hiện 11/10 | G4 | Biểu đồ Công nợ không lọc theo toà. | DebtChart.tsx:35 | 07/10 A6; 11/10 S2-01 (đọc source) |
| **K11-25** | MỚI 11/10 | G5 | Nhánh dự phòng lương chạy ngay trong trình duyệt: upsert salary_monthly status 'LOCKED' với gross/take_home TÍNH Ở TRÌNH DUYỆT, chèn income_expenses/payments nhiều bảng không giao dịch; RLS cho phép mọi người có quyền ghi bảng làm đúng việc đó. Chỉ chạy khi RPC canonical trả tín hiệu dự phòng (tháng ≤ 08 chạy legacy). | useManagerSalary.ts:885,905-930,1160-1330 → bỏ nhánh dự phòng hoặc đưa vào RPC | 11/10 S2 mục 6.3 (đọc source) |
| **N-A6-09** | CÒN · tái hiện 11/10 | G5 | Hoàn thành công việc không bắt ảnh/GPS ở máy chủ (PATCH thẳng jobs → COMPLETED được). | RPC hoàn thành việc kiểm tasks.complete + ảnh/GPS (cùng N-A6-08, Q1) | 07/10 A6; 11/10 D-15 (thật) |
| **L14** | CÒN · tái hiện 11/10 | G6 | Công tắc 'Tự động sinh hoá đơn kỳ tiếp' không có tác dụng; FAQ vẫn hứa. | GeneralSettingsPage.tsx / useSettings.ts (Q2: ẩn hoặc gắn nhãn 'chưa hoạt động') | 07/10 A2; 11/10 D-13 (thật) |
| **L15** | CÒN · tái hiện 11/10 | G6 | Các công tắc Cài đặt chung lưu theo TÀI KHOẢN, không chỗ nào đọc; cờ thật ở bảng tổ chức không có màn ghi — tab Hoá đơn hiện 'Tự động duyệt hoá đơn' TẮT cho mọi tài khoản trong khi cờ công ty đang BẬT (hiển thị trái thực tế). | nối công tắc vào organization_invoice_settings (chỉ chủ sửa); useSettings.ts; useInvoiceConfig/usePaymentConfig/useContractConfig/useNotificationConfig/useCodeGenerationConfig không ai dùng | 07/10 A2, A4; 11/10 D-13 (thật), S2 mục 7 |
| **L16** | CÒN · chưa thử lại | G6 | Định mức bậc thang không được dùng khi tính hoá đơn (bậc giá lưu đúng nhưng không áp). | Q2; docs he-thong/02 | 07/10 A6; 11/10 D (bậc giá lưu đúng) |
| **L17** | CÒN · tái hiện 11/10 | G6 | Gạch nợ tự động chỉ có màn cấu hình (Thêm/Sửa/Xoá), không có phần chạy và không ghi 'chưa hoạt động'. | Q2 | 07/10 A6; 11/10 D-13 (thật) |
| **L22** | CÒN · chưa thử lại | G6 | Hộp Thêm mẫu không đưa được mẫu vào tab 'Mẫu chữ ký'/'HĐ đặt cọc'. | Q2; /settings/signatures ghi 'chưa kết nối' (D) | 07/10 A4 |
| **L25** | CÒN · chưa thử lại | G6 | Chat Zalo 'Đã chạy 0 lượt hôm nay' gán cứng. | component Zalo chat | 07/10 A6 |
| **L47** | CÒN · tái hiện 11/10 | G6 | Màn giữ chỗ: Nhà cung cấp, Loại tài sản, Lịch sử di chuyển/sửa chữa, TK ngân hàng, Danh mục chung 'Tính năng đang phát triển'; Chữ ký ghi 'chưa kết nối'. | Q2 (ẩn hoặc làm thật) | 07/10 A6; 11/10 D-13 (6 màn) |
| **L57** | CÒN · chưa thử lại | G6 | docs/he-thong/02 và 08 mô tả sai định mức bậc thang / gạch nợ. | Đợt D | 07/10 A6 |
| **N-A2-02** | CÒN · tái hiện 11/10 | G6 | Ô 'Công tơ chưa chốt trong tháng' vô tác dụng (= số đã duyệt dù form báo 0 chưa chốt). | ghi-chi-so | 07/10 A2; 11/10 B-06 (thật) |
| **K11-38** | MỚI 11/10 | G8 | Một số trang/RPC chậm trên TEST: hợp đồng chi tiết ~18 s, /refund-log ~15 s (trang gần trống), /deposits 13–76 s, /assets và /materials mobile ~11 s, báo cáo LN 16 s, tạo phiếu thu chi 10–28 s (có 57014, thử lại OK), ghi nhận thanh toán đầu tiên treo >27 s một lần. KHÔNG tái hiện '/invoices 32 s' (B đo 5,8 s). TEST là máy Nano chung nhiều nhóm — cần đo lại trên production. | EXPLAIN các RPC chậm; useCheckOverdueInvoices (K11-14); tải 585 tài sản nhúng; read_income_expense_details_v1, create_income_expense_v1; liên quan L53 | 11/10 Q-07, B-16, C-09, D-16, A-08 (thật, nhiễu vì tải TEST) |
| **K11-39** | MỚI 11/10 | G8 | Mỗi lần tải /deposits gọi trùng RPC: get_held_deposit_summary ×4, get_refund_forfeit_summary ×4, get_reservation_deposit_summary ×4, get_reservation_settlements_v1 ×3, get_reservation_settlement_summary_v1 ×3; tạo giữ chỗ 22 s kèm ≈25 RPC đọc; form HĐ có lúc báo 'Chưa tải đủ nguồn hợp đồng' do tải chậm. | gộp/dedupe truy vấn ở trang /deposits và sau mutation (invalidate quá rộng) | 11/10 A-08 (thật) |
| **L53** | CÒN · chưa thử lại | G8 | Rủi ro hiệu năng: production không timeout với 1 người dùng; biên tải mỏng (get_my_permissions_v2 max 7,8 s, HĐ phân trang max 7,7 s, get_contract_stats max 7,9 s vs giới hạn 8 s). | get_my_permissions_v2, useContracts.ts:316-321 (count=exact + embed), get_contract_stats; đo lại pg_stat_statements | 07/10 A5, A6; liên quan K11-38 |
| **K11-22** | MỚI 11/10 | G9 | Tìm kiếm hợp đồng/hoá đơn/thu chi theo tên khách, SĐT, tên phòng bỏ error ở bước tra id: lỗi → danh sách rỗng, chỉ còn khớp mã HĐ, trả KẾT QUẢ SAI không báo lỗi; thêm .limit(200) khách và .limit(500) liên kết nên gõ từ phổ biến cắt mất hợp đồng. | useContracts.ts:267-290; useInvoices.ts:237-248; income-expenses/queries.ts:387 | 11/10 S2-11 (đọc source) |
| **L28** | CÒN · chưa thử lại | G9 | Chỉ số TLY ghi kiểu nuốt lỗi (WHEN OTHERS THEN NULL); số cuối ở 'Thu thêm' không thành mốc trả phòng. Lỗi bị nuốt đã che một hoá đơn thanh lý tính theo số không khớp công tơ + một chỉ số ghi ngày tương lai ⇒ cần soát tay dữ liệu. | _termination_apply_extra_charges (20260627000001…:85-99); soát dữ liệu = plan 1.10 | 07/10 A1 + PHAN-BIEN |
| **N-A1-01** | CÒN · tái hiện 11/10 | G9 | Lỗi 55000 rõ ràng của máy chủ khi giữ chỗ bị chặn bị app thay bằng 'Chưa xác định được nguyên nhân…'. | friendlyError / hộp lỗi giữ chỗ | 07/10 A1; 11/10 A (thật) |
| **K11-40** | MỚI 11/10 | G10 | (Hạ P1→P2: dữ liệu, đúng 1 phòng trên production) Phòng 158PVC/502 có trạng thái AVAILABLE nhưng có hợp đồng ACTIVE: /rooms hiện 'Trống' sai (sale list và /apartments vẫn đúng vì ưu tiên HĐ). Không có phòng OCCUPIED nào thiếu HĐ. | sửa một dòng qua luồng có vết + tìm đường ghi tay làm lệch (rooms.status ghi thẳng; cần change_log); trigger/ràng buộc status với HĐ ACTIVE | 11/10 A-01 (thật) → PHAN-BIEN-1110 #10 (hạ P2) |
| **K11-65** | MỚI 11/10 | G10 | (Hạ P1→P2, giữ MỘT phần sau phản biện) Bảng tin đếm số phòng thuê/trống sai vì get_dashboard_summary đếm hợp đồng ACTIVE không lọc deleted_at: cộng 2 HĐ đã xoá mềm vẫn ACTIVE (thuê 282 thay vì 280, trống 3 thay vì 5). Các màn khác đúng theo HĐ; chênh còn lại giữa báo cáo/danh sách chỉ là khác định nghĩa (danh sách tách phòng sắp hết hạn) — không phải lỗi. Phần '/apartments Tổng phòng 4' trong báo cáo D là đọc nhầm thứ tự thẻ. | get_dashboard_summary: thêm deleted_at IS NULL (gộp 2.3 cùng N-A6-03); ghi rõ định nghĩa trên từng màn (Q14) | 11/10 D-07 → PHAN-BIEN-1110 #9 (giữ một phần, hạ P2) |
| **K11-28** | MỚI 11/10 | — | Ngày 1 hàng tháng trước 07:00 giờ VN, form Ghi chỉ số và bộ lọc 'kỳ' mặc định rơi về THÁNG TRƯỚC (new Date().toISOString().slice(0,7) là UTC); hai trang đặt hằng ở cấp module nên giữ tháng cũ nếu tab mở xuyên tháng. | MeterReadingForm.tsx:128,137,158,176,193; MeterReadingsPage.tsx:35; MeterReadingsMobilePage.tsx:18; useMeterReadings.ts:275 (neo múi giờ VN như lib/collect.ts:227) | 11/10 S2-17 (đọc source) |
| **K11-30** | MỚI 11/10 | — | Báo chi nhanh (trang Ví): mọi câu có chữ 'thẻ' (thẻ từ thang máy, thẻ tạm trú, thẻ cào, thẻ xe) bị coi là thẻ tín dụng; ví thẻ được chọn sẵn và, với tin nhiều khoản, áp cho MỌI dòng — phiếu chi có thể ghi vào sổ thẻ tín dụng nếu người dùng bấm xác nhận. | src/lib/quickEntry/payment.ts:28-29 (inferPaymentKind), compose.ts:262-268: chỉ nhận 'thẻ' đi kèm động từ thanh toán hoặc cụm 'thẻ tín dụng/thẻ SP'; loại thẻ từ/cào/xe/tạm trú | 11/10 S3-F1 (chạy regex bằng node) |
| **K11-41** | MỚI 11/10 | — | Sau thanh lý, lịch sử HĐ ghi 'net quyết toán' khác phiếu chi thật và 'Chưa hoàn khách' chỉ tính phần cọc: ba con số khác nhau cho cùng khoản trả khách. | hợp nhất cách ghi net quyết toán / số còn hoàn (liên quan N-A1-05, 1.2) | 11/10 A-02 (thật) |
| **K11-42** | MỚI 11/10 | — | contract_terminations ghi termination_type=NORMAL cho ca EARLY_RETURN; cột early_termination_fee thực chất chứa tiền điện + vệ sinh; prorated_days=0 — sai ngữ nghĩa nếu báo cáo đọc các cột này. | terminate_contract_move_out_impl / contract_terminations | 11/10 A-03 (thật) |
| **K11-43** | MỚI 11/10 | — | Form 'Tạo hợp đồng' từ thẻ giữ chỗ đã gắn khách thật không điền khách ('Chưa chọn khách hàng nào'); thẻ 'Sẵn sàng ký HĐ' vẫn in tên gợi nhớ cũ. | RoomReservationPanel / form tạo HĐ từ giữ chỗ | 11/10 A-04 (thật) |
| **K11-44** | MỚI 11/10 | — | Xem trước hoá đơn đầu hiện 'Tiền thuê tháng đầu (1 ngày)' khi để trống 'Đến ngày', nhưng khi ký máy chủ từ chối 'Tháng đầu tiên phải tính đủ đến hết tháng' (sau 2 bước xác nhận). | xem trước hoá đơn đầu của form HĐ: mặc định Đến ngày = hết tháng | 11/10 A-05 (thật) |
| **K11-45** | MỚI 11/10 | — | Ký bản nháp bắt buộc bước in .docx; khi mẫu thiếu byte ở storage thì toast 'Không thể xử lý bản nháp' và người dùng kẹt không ký được. (TEST thiếu mẫu là môi trường, nhưng thông báo không nói mẫu mất.) | bước in .docx khi ký nháp: báo rõ 'mẫu hợp đồng thiếu' + cho đường ký không mẫu (chỉ ở production nếu mẫu mất) | 11/10 A-06 (thật, một phần môi trường) |
| **K11-46** | CẦN CHỦ CHỐT | — | Thanh lý: hoàn ngày không ở tính theo /30 trong khi hoá đơn tháng cùng hợp đồng tính theo số ngày thực (21/31) → lệch giữa hai cách tính (ghi nhận, có thể là thiết kế). | terminate_contract_move_out_impl 'Cơ sở tháng' /30 vs hoá đơn tháng đầu theo ngày thực (quan sát 07/10: nhãn '(30 ngày)' mà tính theo ngày thật) — chờ Q15 | 11/10 A-07 (thật) |
| **K11-52** | MỚI 11/10 | — | Form Thêm chỉ số: ô 'Phòng' không đánh dấu bắt buộc và mặc định 'Tất cả phòng' liệt kê 20 công tơ, nhưng Lưu báo 'Vui lòng chọn phòng' → thực tế chỉ ghi được từng phòng một. | meterReadingValidation.ts:23 (room_id min(1)) vs UI mặc định 'Tất cả phòng' | 11/10 B-02 (thật) |
| **K11-58** | MỚI 11/10 | — | /income-expense/voucher/:id luôn đề 'Chi tiết phiếu thu' kể cả phiếu CHI. | VoucherDetailPage.tsx:394 cứng chữ 'phiếu thu' | 11/10 C-07 (thật) |
| **K11-63** | MỚI 11/10 | — | (Hạ P1→P2 sau phản biện: hỏng từ 03/2026 mà không ai báo; 15 loại có sẵn vẫn giao việc được) Không tạo và không sửa được 'Loại công việc': ô 'Bộ phận thực hiện' bắt buộc nhưng bảng departments rỗng và không có màn tạo bộ phận; mở sửa loại có sẵn rồi Lưu cũng không đóng. | TaskTypeFormDialog.tsx:362-395; useJobTypes.ts:120 (chỉ đọc departments) → bỏ bắt buộc hoặc thêm màn bộ phận | 11/10 D-02 (thật) |
| **K11-64** | MỚI 11/10 | — | (Hạ P1→P2 sau phản biện: Enter ở ô 'Tên loại' vẫn lưu, thu nhỏ trang cũng được; production chưa ai sửa loại thu chi từ 04/10) Hộp 'Sửa loại thu chi' cao hơn màn, không cuộn: nút Lưu nằm ngoài khung nhìn ở mọi chiều cao thử (1000/800/700 px) — không lưu được bằng chuột. Hộp 'Thêm' thì vừa màn. | IncomeExpenseTypesPage.tsx:221 (DialogContent sm:max-w-[480px] thiếu max-h/overflow-y-auto); components/ui/dialog.tsx:55 | 11/10 D-03 (thật) |
| **K11-66** | MỚI 11/10 | — | Cài đặt → Tầng → Thêm tầng: 403 RLS floors + toast 'Không đủ quyền…' (sai nghĩa với Chủ công ty). Form không có ô toà trong khi floors.building_id NOT NULL → không ai tạo được tầng. | useFloors.ts:70-71 (insert không building_id); thêm ô toà | 11/10 D-08 (thật) |
| **L10** | CÒN · tái hiện 11/10 | — | Tài liệu quy-trinh-ban-giao sai: máy chủ chỉ nhận người cùng đội + tài khoản hệ thống, KHÔNG nhận vai Chủ công ty; 11/10 xác nhận hành vi (chủ không cùng đội nên không nhận được). | docs/huong-dan-su-dung/01-bat-dau/quy-trinh-ban-giao (~54, 61); chờ Q3 | 07/10 A2; 11/10 B (quan sát) |
| **L13a** | CÒN · tái hiện 11/10 | — | Không chặn trùng chỉ số cùng công tơ + kỳ (thật chỉ 11 nhóm trùng, 59 nhóm khác là chỉ số chốt trả phòng — đúng thiết kế). | chỉ mục một phần loại dòng TLY/mốc + bắt Ngày chốt trong Tháng chốt (KHÔNG UNIQUE trần) | 07/10 A2 + PHAN-BIEN; 11/10 B-03 |
| **L18** | CÒN · chưa thử lại | — | /my-day lỗi toàn màn khi công ty chưa bật luật ngày công v5 (chỉ DEMO bị); cũng là trang dự phòng khi bấm thông báo thiếu quyền. (Phản biện hạ P1→P2.) | get_salary_v5_config trả configured:false hoặc Zod nhận null (useMyDay.ts:18,24); tách QueryRegion MyDayPage.tsx:197 | 07/10 A6 + PHAN-BIEN |
| **L19** | CÒN · chưa thử lại | — | Link 'Mở phiếu' ở hộp Hoàn trả khách → 404. | href /income-expense/voucher/:id | 07/10 A2 |
| **L20** | CÒN · chưa thử lại | — | Link /rooms/<id> (khối dọn/sửa, nút mắt) đưa về danh sách, mất id. | route /rooms/:id giữ id | 07/10 A1-ui |
| **L21** | CÒN · chưa thử lại | — | Trang CT01 không có thanh bên; nút quay lại về danh sách khách. | layout trang CT01 | 07/10 A1-ui |
| **L24** | CÒN · chưa thử lại | — | Ô nhập nhanh công việc không nhận toà chưa có mã (đường tạo việc duy nhất). | parser nhập nhanh | 07/10 A6 |
| **L26** | CÒN · chưa thử lại | — | Form Toà nhà báo lỗi đỏ khi chỉ đang tải. | form Toà nhà | 07/10 A1-ui |
| **L27** | CÒN · chưa thử lại | — | Ghi chú thanh lý bỏ cọc ghi '(chờ duyệt)' dù đã tự duyệt. | terminate…forfeit notes | 07/10 A1 |
| **L33** | CÒN · chưa thử lại | — | Báo cáo Bỏ trả: cột Lý do in nguyên ghi chú quyết toán dài, chữ bị cắt. | cắt + mở rộng | 07/10 A6 |
| **L34** | CÒN · chưa thử lại | — | Sổ quỹ theo ngày: số dư đầu không cộng số dư đầu kỳ của sổ (tiềm ẩn). | cashbook_opening_balance_v2 cộng initial_amount | 07/10 A3 + PHAN-BIEN |
| **L35** | CÒN · chưa thử lại | — | Dòng tiền: cột 'Doanh thu/Chi phí/Lợi nhuận' thực là tiền vào/ra (gồm cọc). | đổi nhãn | 07/10 A3 |
| **L37** | CÒN · chưa thử lại | — | Tỷ lệ chi phí: mô tả 'hoá đơn đã duyệt' nhưng cộng phiếu thu. | đổi nhãn/nguồn | 07/10 A3 |
| **L39** | CÒN · chưa thử lại | — | Trung tâm tài chính: 73 dòng cấu hình báo đỏ đẩy bảng theo toà xuống cuối. | UI Trung tâm tài chính | 07/10 A3 |
| **L41** | CÒN · tái hiện 11/10 | — | Mã thô RESERVED/OCCUPIED/AVAILABLE hiện ở hộp sơ đồ và cột Trạng thái của file xuất 'Căn hộ trống' (+5 cách gọi trạng thái phòng). | src/lib/roomStatus.ts bảng nhãn chung | 07/10 A1-ui; 11/10 D-17(d) |
| **L44** | CÒN · chưa thử lại | — | Form sửa toà trống Tỉnh/TP với 14/19 toà (so khớp tên tuyệt đối). | normalizeProvinceName; thống nhất 2 form sửa toà | 07/10 A1-ui |
| **L71** | CÒN · chưa thử lại | — | Chuyển phòng khác toà: máy chủ chặn đúng nhưng mã 42501 → UI báo 'Không đủ quyền' cả với super admin; UI cho chọn mọi toà. | khoá ô toà; mã 55000; friendlyError.ts:86-89 | 07/10 A1 + PHAN-BIEN |
| **L73** | CÒN · chưa thử lại | — | Không có lối vào trang chi tiết toà/căn hộ từ hai danh sách. | link từ bảng Toà nhà/Căn hộ (sau N-A1-UI-02) | 07/10 A1-ui |
| **N-A1-02** | CÒN · tái hiện 11/10 | — | Bỏ cọc giữ chỗ ghi cặp bút toán vào sổ ảo CŨ NHẤT của công ty (sổ tiền thối của một nhân viên) thay vì sổ cấn trừ nội bộ. | reservation_internal_account_v1 chọn theo mục đích | 07/10 A1 + PHAN-BIEN; 11/10 A (thật) |
| **N-A1-04** | CÒN · tái hiện 11/10 | — | Thẻ 'Đang giữ chỗ' ở /deposits đếm cả phiếu đã xử lý (bỏ cọc/hoàn). | lọc theo trạng thái xử lý | 07/10 A1; 11/10 A (thật) |
| **N-A1-06** | CÒN · tái hiện 11/10 | — | HĐ đã thanh lý vẫn hiện 'Còn thiếu … tiền cọc' (sau cấn trừ). | tính thiếu cọc bỏ HĐ TERMINATED | 07/10 A1; 11/10 A (thật) |
| **N-A1-UI-03** | CÒN · chưa thử lại | — | Nút 'Quản lý căn hộ' ở chi tiết toà mất bộ lọc toà. | route kèm building | 07/10 A1-ui |
| **N-A2-03** | CÒN · chưa thử lại | — | Lọc Phòng ở danh sách Ghi chỉ số không lọc. | bộ lọc phòng | 07/10 A2 |
| **N-A2-04** | CÒN · tái hiện 11/10 | — | Thẻ thống kê Ghi chỉ số đếm theo user_id (80DS3 thẻ '21 đã duyệt/21 chưa chốt' vs bảng 22; mobile '98/100'; get_meter_reading_stats = 0 cho Chủ công ty). | get_meter_reading_stats theo phạm vi toà | 07/10 A2; 11/10 B-06 (thật) |
| **N-A2-05** | CÒN · chưa thử lại | — | Hộp Tạo hoá đơn lẻ ghi 'nháp, chờ duyệt' nhưng tạo ra APPROVED. | đổi nhãn/hành vi | 07/10 A2 |
| **N-A3-02** | CÒN · chưa thử lại | — | Lập phiếu vào sổ đã chốt: app báo câu chung chung; Báo chi nhanh còn chọn sẵn sổ đã chốt. | quy tắc lỗi 'kỳ đã khoá' | 07/10 A3 |
| **N-A3-04** | CÒN · tái hiện 11/10 | — | Phiếu chi vượt/ngoài cam kết nằm 'Chờ duyệt' nhưng KHÔNG tạo yêu cầu duyệt: /approvals báo 0 dù hàng chục phiếu chờ (tài liệu nói ngược). | tạo approval_request cho phiếu OVER/NO_COMMITMENT (Q7) | 07/10 A3; 11/10 C-06 (thật) |
| **N-A4-08** | CÒN · tái hiện 11/10 | — | Hộp 'Chào mừng — Bước 1/5 Tạo toà nhà' (onboarding chủ mới) hiện cho nhân viên chỉ xem và cho đối tác có 13 phạm vi. (07/10 P3; 11/10 Q-03 xếp P2.) | điều kiện hiện onboarding: chỉ chủ/super admin chưa có toà | 07/10 A4 (P3); 11/10 Q-03 (thật) |
| **N-A5-04** | CÒN · chưa thử lại | — | Danh mục phạm vi phân quyền vẫn liệt kê toà/sổ đã xoá; 'Chọn tất cả' gán luôn phạm vi rác. | lọc xoá mềm, giữ phạm vi đang gán (gắn nhãn '(đã xoá)') | 07/10 A5 + PHAN-BIEN |
| **N-A5-05** | CÒN · chưa thử lại | — | Nút 'Reset DEMO' trên site docs dùng snapshot tháng 7 và bí mật dùng chung nhúng trong bundle JS docs. | gỡ nút + khoá hàm (Q5) | 07/10 A5 |
| **N-A6-01** | CÒN · chưa thử lại | — | Bảng tin lọc theo toà nhưng cảnh báo và hoạt động vẫn toàn công ty. | get_dashboard_summary _v2; useDashboard.ts:226-228,382-384 | 07/10 A6 + PHAN-BIEN |
| **N-A6-03** | CÒN · chưa thử lại | — | Thẻ 'hợp đồng mới' không lọc toà và không bỏ HĐ đã xoá. | get_dashboard_summary _v2 | 07/10 A6 |
| **N-A6-05** | CÒN · tái hiện 11/10 | — | Thêm dịch vụ chọn 'Không chọn' định mức → POST /services 400 22P02 (gửi chữ 'none'); hộp không đóng, không toast lỗi. | CreateServiceDialog.tsx:98,254 ('none' → null) | 07/10 A6; 11/10 D-14 (thật) |
| **N-A6-07** | CÒN · chưa thử lại | — | Báo cáo Bỏ trả xếp mọi HĐ là 'thanh lý sớm' (thật nhiều HĐ đúng/sau hạn). | realEstateReports.ts | 07/10 A6 |
| **N-A6-13** | CÒN · chưa thử lại | — | Chủ công ty không đọc được hồ sơ thành viên → cột 'Người tạo' trống. | policy profiles cho chủ công ty cùng org | 07/10 A6 |


### P3 (60)

| Mã (gộp nguồn) | Trạng thái | Nhóm | Hậu quả cho người dùng | Chỗ sửa | Bằng chứng |
|---|---|---|---|---|---|
| **K11-10** | MỚI 11/10 | G2 | Hàm tạo/ghi cho mọi người đăng nhập, không kiểm quyền (tự thân không chéo công ty): create_public_room_token, ensure_room_deposit_type, adopt_voucher_attachments_as_evidence_v2, create_finance_evidence_upload_intent_v2 (chỉ cần membership). | thêm kiểm quyền theo hàm | 11/10 S1-F12 |
| **K11-11** | MỚI 11/10 | G2 | Hàm nội bộ anon EXECUTE được: _collector_thu_account, _termination_pick_account (trả uuid sổ), bulk_create_meter_readings (không ghi được vì auth.uid() NULL), seed_default_settings, generate_next_code, generate_code, sandbox_org_ids() (lộ uuid org sandbox). Các hàm can_*/is_*/staff_* trả false/rỗng cho anon. | REVOKE anon; scripts/definer-acl-baseline.json (đang allowlist) | 11/10 S1-F13, E-10 |
| **K11-13** | MỚI 11/10 | G2 | lucky_admin_org_v1: bất kỳ thành viên OWNER/STAFF ACTIVE nào là 'quản trị sự kiện' quay số, org chọn theo is_demo rồi id. Không dính tiền. | kiểm vai quản trị sự kiện | 11/10 S1-F15 |
| **K11-49** | MỚI 11/10 | G2 | Hộp Hoàn tiền cọc và ô Sổ quỹ ghi cọc liệt kê cả sổ ảo ('Cấn trừ thanh lý (nội bộ)', 'CỌC giữ hộ khách'); máy chủ chặn đúng (403) nhưng UI nên lọc — cùng họ N-A2-07. | lọc is_virtual ở mọi ô chọn sổ (làm cùng 0.3) | 11/10 A-11 |
| **K11-19** | MỚI 11/10 | G3 | Mã chết gài sẵn bẫy: nhập HĐ từ Excel (ContractImportExportDialog) ghi contracts.tenant_id = customers.id → vi phạm FK mọi dòng + UPDATE rooms thẳng; hiện không thể mở (setImportDialogOpen không bao giờ true). Cũng: useEstimateTerminationCosts (bỏ error → nợ = 0), calculateLateFee, 5 hook cài đặt không ai dùng. | xoá hoặc viết lại: ContractImportExportDialog.tsx:178-185 (mount ContractsPage.tsx:620), useContracts.ts:1526, invoiceHelpers.ts:228, useSettings (useInvoiceConfig…) | 11/10 S2-08, S2-14, S2 mục 7 |
| **K11-16** | MỚI 11/10 | G4 | 'Chưa thanh toán' gồm cả DRAFT (và CANCELLED khi chọn xem tất cả); badge hoá đơn gần nhất đỏ với mọi trạng thái ≠ PAID. | useInvoices.ts:201-203; RoomDetailDialog.tsx:265 | 11/10 S2-04 |
| **L23** | CÒN · chưa thử lại | G6 | Logo công ty lưu theo tài khoản, không dùng ở đâu (bản in hoá đơn không có logo). | GeneralSettingsPage.tsx:660-662; logo theo công ty (Q2) | 07/10 A4; D chưa thử lại |
| **N-A1-UI-04** | CÒN · chưa thử lại | G6 | Nút Dạng lưới/Tìm kiếm ở danh sách toà/căn hộ vô tác dụng. | gỡ hoặc nối | 07/10 A1-ui |
| **K11-20** | MỚI 11/10 | G9 | Hộp thông báo cắt im lặng 200 dòng; danh sách phiên bàn giao cắt 50 và đếm 'cần thao tác' chỉ trong 50 phiên mới nhất. | useNotifications.ts:107; useCashHandovers.ts:114 | 11/10 S2-10c |
| **K11-21** | MỚI 11/10 | G9 | Sắp chạm trần 1.000 dòng: báo cáo BĐS rooms/contracts không phân trang; useExcelInvoiceData.ts:49 kéo MỌI HĐ ACTIVE của công ty rồi lọc toà ở client (296 → 1.000 là cắt, ngay trong luồng lập hoá đơn); ContractImportExportDialog customers. | fetchAllRows hoặc .eq room.building_id: realEstateReports.ts:38,62,73,352,449,705,777,844; useExcelInvoiceData.ts:49 | 11/10 S2-10d |
| **K11-23** | MỚI 11/10 | G9 | record_payment_gps bỏ error có chủ ý: khi lỗi, tick/thưởng V5 mất không dấu vết. | lib/v5PaymentGps.ts:31 (ghi log) | 11/10 S2-13 |
| **A3-luong-dh** | CÒN · chưa thử lại | G10 | Quy tắc lương điều hành 'LN 10%' của quản lý đã xoá. | chủ quyết | 07/10 A3 |
| **L59** | CÒN · chưa thử lại | G10 | Scope toà rp17-… sót ở DEMO. | N-A5-04 | 07/10 A5 |
| **L60** | CÒN · chưa thử lại | G10 | 3 dịch vụ DEMO thiếu loại phí. | điền fee_type/pricing_type/unit/code | 07/10 A5 |
| **L61** | CÒN · chưa thử lại | G10 | Tài khoản DEMO 'chủ nhà' thiếu sổ tiền mặt riêng. | tạo sổ | 07/10 A5 |
| **L63** | CÒN · chưa thử lại | G10 | Fixture lương hhqlfixture tự giữ mãi. | spec .e2e-fleet dọn theo note | 07/10 A5 |
| **L76** | CÒN · chưa thử lại | G10 | Toà 'Test'/'Chung' đã xoá còn scope. | N-A5-04 | 07/10 A5 |
| **N-A4-06** | CÒN · chưa thử lại | G10 | 3 mẫu HĐ type NULL không vào hộp in (production). | gán type='lease_contract' sau khi đo lại production | 07/10 A4 |
| **K11-12** | MỚI 11/10 | — | Không giới hạn thử mã: get_public_available_rooms(p_token) (token 6 ký tự, alphabet 57 ≈ 3,4e10) không có rate-limit/probe như get_public_latest_invoice_by_code; lucky_checkin_v1/lucky_save_payout_v1 (anon theo mã đội) cũng vậy. Khả năng đoán thấp, chưa khai thác; chưa đo entropy mã lucky. | thêm probe/giới hạn theo IP | 11/10 S1-F14 |
| **K11-29** | MỚI 11/10 | — | LifecycleTimeline todayISO() dùng UTC (trong khi lib/collect.ts:227 đã neo giờ VN). | components/thu-tien/room-lifecycle/LifecycleTimeline.tsx:24 | 11/10 S2-18 |
| **K11-31** | MỚI 11/10 | — | Script Gmail: lỗi heartbeat 409/4xx bị nuốt; khi chủ dán bản script khác cho cùng nguồn mà bản cũ chưa gỡ trigger, bản cũ vẫn gửi mỗi phút và tốn hạn mức, không chỗ nào báo 'bản này đã bị thay'. | src/lib/bank-events/gmailScript.ts baoSong_ (dòng 176-179) / guiBaoSong_ | 11/10 S3-F2 (đọc code) |
| **K11-32** | MỚI 11/10 | — | bank-event-ingest (verify_jwt=false) đọc thân 64KB, kiểm sự kiện, SHA-256, mã hoá AES-GCM rồi mới biết khoá sai (RPC 28000 → 401): kẻ ngoài gửi khoá giả gây tải Edge + 1 truy vấn DB/yêu cầu, không rò dữ liệu. | supabase/functions/bank-event-ingest/index.ts:9-24 (kiểm digest trước hoặc giới hạn tốc độ) | 11/10 S3-F3 (đọc code) |
| **K11-33** | MỚI 11/10 | — | Đồng bộ mốc trả phòng im lặng khi không có phiên đăng nhập (IF v_actor IS NULL THEN RETURN false): nếu một đường FINALIZED chạy bằng service role/cron thì mốc vẫn MISSING dù đã có số cuối. Hiện chưa xảy ra. | 20261008025958_contract_meter_boundary_final_reading_sync.sql:33 | 11/10 S3-F4 (đọc code + đếm production) |
| **K11-47** | MỚI 11/10 | — | Lỗi nghiệp vụ trả HTTP 500 (SQLSTATE 55000) thay vì 4xx: create_room_reservation_v1, đề xuất chốt quỹ trùng. Nút 'Quay lại' của wizard chốt sổ là type=submit. | đổi mã lỗi; wizard chốt sổ | 11/10 A-09, B-11 |
| **K11-48** | MỚI 11/10 | — | Chip phòng Sale mobile/tổng hợp hiện nhãn dạng 'a·b' cho phòng L04 (chỉ lấy chữ số trong tên phòng), dễ nhầm với 104/204/304. | chip phòng sale-phong | 11/10 A-10 |
| **K11-50** | MỚI 11/10 | — | Ngày dạng ISO trong thẻ nháp, hộp 'Xác nhận đã ký' và danh sách phiếu trong form; ô chọn căn hộ ở 'Cọc' từ Khách hẹn liệt kê hàng trăm phòng toàn công ty không kèm tên toà ('302' ×N). (Họ N-A1-07, N-A3-07.) | formatDate VN; ô chọn phòng kèm toà | 11/10 A-12 |
| **K11-51** | MỚI 11/10 | — | KPI mobile /deposits: ĐANG GIỮ + CÒN THIẾU ≠ CẦN THU (chênh khoản cọc nợ gộp vào hoá đơn đầu của HĐ mới). Nghi đúng thiết kế — nên thêm chú thích. | chú thích KPI | 11/10 A-13 |
| **K11-54** | MỚI 11/10 | — | Hoá đơn: dòng khoản không cộng ra tổng (subtotal lẻ trăm, tổng làm tròn xuống nghìn); trang chi tiết và trang in không có dòng làm tròn, bản in hiện cả 'Tạm tính' lẫn 'Tổng cộng' khác nhau. | thêm dòng làm tròn (liên quan N-A2-08) | 11/10 B-12 |
| **K11-55** | MỚI 11/10 | — | /thanh-toan: ô 'Mã nước' của hàng NCC tự lưu khi rời ô (save_utility_account), không xác nhận — gõ nhầm là đổi mã nước thật. | thêm xác nhận/nút Lưu | 11/10 B-14 |
| **K11-56** | MỚI 11/10 | — | Định dạng tiền kiểu 'nghìn' lạ: các thẻ /invoices ghi hậu tố 'K' ('0K', số lớn kèm K), /thu-tien ghi 'Thiếu …K' cạnh số đầy đủ ở cột bên. | formatter thẻ thống kê | 11/10 B-07 (phần định dạng), B-15 |
| **K11-60** | MỚI 11/10 | — | Ô 'Từ tháng/Đến tháng' của form Thêm phiếu hiện 'October 2026' (tiếng Anh); nghi cùng gốc N-A6-16 (html lang=en). | lang/locale ô chọn tháng | 11/10 C-10 |
| **K11-61** | MỚI 11/10 | — | Bảng lương: desktop 'Tổng lương vận hành' / mobile 'Tổng quỹ thực chi' khác nhau; mobile cho quản lý ra số âm (khấu trừ tiền phòng chỉ hiện ở mobile), người đọc dễ hiểu lệch. | thống nhất nhãn và khấu trừ giữa desktop/mobile | 11/10 C-11 |
| **K11-67** | MỚI 11/10 | — | Nhóm vụn: (a) hộp Sửa loại thu chi mở ngay sau điều hướng báo 'Chưa tải đủ nhóm loại thu chi' rồi tự hết; (b) nút sửa/xoá ở auto-debt, warehouses, hotlines là icon không aria-label; (c) service_quotas.updated_at không đổi sau sửa/xoá mềm; (d) /quayso/admin của quản lý cũng 'Không mở được…' (đúng chặn quyền nhưng cùng câu lỗi chung); (e) 'Cho… Toàn tổ chức thừa' trong Phân quyền chưa giải nghĩa. Rủi ro phụ thuộc dịch vụ ngoài: địa chỉ hành chính lấy từ provinces.open-api.vn. | xem D-17 | 11/10 D-17, G2 (mục loại) |
| **L40a** | CÒN · chưa thử lại | — | 'Đã thu/Đã chi' của báo cáo sổ quỹ lọc approval_status='APPROVED' (đã duyệt) chứ không phải đã ghi sổ (tiềm ẩn). | cashbook_settlement_report: tách 'đã duyệt' và 'đã chi' hoặc lọc POSTED | 07/10 A3 |
| **L40b** | CÒN · chưa thử lại | — | 'Đã ứng/đã chia' (cổ đông, lương điều hành) lọc APPROVED (tiềm ẩn). | useShareholderProfit.ts:256-281,307-331 | 07/10 A3 |
| **L42** | CÒN · chưa thử lại | — | Tên báo cáo lệch giữa menu, tiêu đề và breadcrumb ('Tài khoản theo ngày' / 'Sổ quỹ theo ngày', 'Chu kỳ Thu — Bàn giao'). | Sidebar.tsx:207, FinanceReportsPage.tsx:56,64, Breadcrumbs.tsx:62-63,72 | 07/10 A3 |
| **L45** | CÒN · chưa thử lại | — | Còn thương hiệu 'iHomeCRM' ở Trung tâm mạng. | NetworkCenterShell.tsx:70,75, NetworkCenterStates.tsx, dto.ts:749,814, AccountMobilePage.tsx:325 | 07/10 A6 |
| **L46** | CÒN · chưa thử lại | — | Lý do miễn trừ registry lỗi thời (Trung tâm mạng). | registry.ts:206-208 gán userDoc | 07/10 A6 |
| **L48** | CÒN · chưa thử lại | — | asset_categories vs asset_types: RLS dùng assets.* lệch settingsRoutes. | thống nhất | 07/10 A6 |
| **L51** | CÒN · chưa thử lại | — | Mã chết RenewedBadge (chỉ test import). | xoá + gỡ strict-islands | 07/10 A1-ui |
| **L55** | CÒN · chưa thử lại | — | TS 'process' trong docs-site/middleware.ts (chỉ lỗi kiểu). | declare const process | 07/10 A5 |
| **N-A1-07** | CÒN · chưa thử lại | — | Huỷ giữ chỗ không hỏi xác nhận; in UUID/ISO. | huỷ giữ chỗ | 07/10 A1 |
| **N-A1-UI-05** | CÒN · chưa thử lại | — | Nhãn hoá đơn thô. | nhãn | 07/10 A1-ui |
| **N-A2-08** | CÒN · chưa thử lại | — | Hoá đơn PAID sau làm tròn vẫn hiện 'còn nợ'. | hiển thị trừ phần làm tròn (liên quan K11-54) | 07/10 A2 |
| **N-A2-09** | CÒN · chưa thử lại | — | Ô tìm hoá đơn không nhận tên phòng chữ (chỉ mã dạng số/MB/G/L). | tìm hoá đơn | 07/10 A2 |
| **N-A2-10** | CÒN · chưa thử lại | — | Đơn giá điện mặc định cố định ở hộp Điều chỉnh hoá đơn. | hộp Điều chỉnh | 07/10 A2 |
| **N-A3-03** | CÒN · chưa thử lại | — | Nút Mở lại/Huỷ duyệt hiện trên phiếu đã khoá kỳ. | ẩn theo trạng thái khoá | 07/10 A3 |
| **N-A3-06** | CÒN · chưa thử lại | — | Nút Xoá ví hiện cả khi ví đã có giao dịch. | ẩn | 07/10 A3 |
| **N-A3-07** | CÒN · chưa thử lại | — | Ngày dạng ISO ở khung chốt sổ. | formatDate | 07/10 A3 |
| **N-A3-08** | CÒN · chưa thử lại | — | Phiếu thiếu/thừa quỹ gán toà tạo sớm nhất (toà ảo 'Chung'). | gán toà | 07/10 A3 |
| **N-A4-05** | CÒN · chưa thử lại | — | Tạo tài khoản ở /admin/users thiếu email, không có khoá/xoá. | admin users | 07/10 A4 |
| **N-A4-07** | CÒN · chưa thử lại | — | Trang tổng báo cáo BĐS hiện ô không có quyền. | ẩn theo quyền | 07/10 A4 |
| **N-A5-02** | CÒN · chưa thử lại | — | Allowlist gate có 3 mục 'ma'. | gỡ; gate hiểu DROP FUNCTION | 07/10 A5 |
| **N-A6-10** | CÒN · chưa thử lại | — | Sửa Mô tả việc không hiện. | form việc | 07/10 A6 |
| **N-A6-15** | CÒN · chưa thử lại | — | Ô chọn HĐ 280 dòng; items lưu chuỗi JSON. | ô chọn HĐ | 07/10 A6 |
| **N-A6-16** | CÒN · chưa thử lại | — | Thẻ html lang đặt en (ngôn ngữ trang). | index.html | 07/10 A6 |
| **N-A6-S04** | CÒN · chưa thử lại | — | Nút bị chặn trông như bấm được. | style disabled | 07/10 A6 |
| **N-A6-S05** | CÒN · chưa thử lại | — | Bảng tràn. | layout | 07/10 A6 |
| **N-A6-S06** | CÒN · chưa thử lại | — | Nhật ký Trung tâm mạng in mã thô. | Network Center | 07/10 A6 |
| **N-A6-S07** | CÒN · chưa thử lại | — | Build TEST thiếu cờ Trung tâm mạng (VITE_NETWORK_CENTER_MODE). | build TEST | 07/10 A6 |


### Không phải lỗi / đúng thiết kế / đã loại (22)

| Mã (gộp nguồn) | Trạng thái | Nhóm | Hậu quả cho người dùng | Chỗ sửa | Bằng chứng |
|---|---|---|---|---|---|
| **K11-35** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | G8 | BÁC BỎ sau phản biện (P3 theo dõi): Partner mở Bảng tin gặp 57014 ở G2 là do TEST quá tải khi 5 nhóm chạy song song; đo lại lúc yên chỉ 243 ms (nguội 2,6 s), production cùng cấu hình và EXPLAIN nhẹ. Phụ: Chủ công ty nhận toàn 0 chính là L30 (còn nguyên). | — (theo dõi get_invoice_statistics_v2 cùng L30) | 11/10 Q-02 → PHAN-BIEN-1110 #11 |
| **K11-57** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | BÁC BỎ sau phản biện: quản lý tạo được phiếu chi tự duyệt + ghi sổ ở toà ngoài phạm vi là đúng cấu hình, không phải lỗi. create_income_expense_v1 CÓ kiểm toà (authorize_income_expense_on_building) và cho qua khi người dùng có quyền 'Ghi thu chi cho MỌI toà nhà' (income_expenses.all_buildings, có chủ đích, có tài liệu 08-thu-chi-so-quy §4.13) cùng self_approve_within_limit. Còn lại là câu hỏi cho chủ (Q12) và là lý do form hiện nhiều toà hơn phạm vi. | — (gốc 'theo người giữ sổ' trong báo cáo C là sai; permissionPages.ts:330) | 11/10 C-01 → PHAN-BIEN-1110 #2 (đọc thân hàm production, đếm staff_assignments) |
| **K11-68** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | /customers/new và /customers/:id/edit 'Chưa tải được địa chỉ hành chính' trên server kiểm cục bộ: CSP của server cục bộ chặn provinces.open-api.vn; CSP production cho phép, API sống (HTTP 200). Chỉ còn rủi ro phụ thuộc dịch vụ ngoài (P3). | — | 11/10 G2 |
| **K11-69** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Partner bị đưa về '/' ở các trang cài đặt và /quayso/admin của Partner báo 42501 'không có quyền': đúng guard/đúng thiết kế (chậm 14–25 s là do Bảng tin lúc TEST quá tải, K11-35/K11-38). | — | 11/10 G2 |
| **K11-70** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | 1.362 lỗi CSP khi quét trang: CSP của server kiểm cục bộ (ảnh R2/CDN), không áp cho production. '/khong-ton-tai' và chốt quỹ id giả → 'Không tìm thấy': đúng. | — | 11/10 G2 |
| **K11-71** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | '/invoices 32 s mới yên' (Chủ công ty) KHÔNG tái hiện: B đo 5,8 s (217 request); mobile 5–10 s. Phần hiệu năng còn lại xem K11-38. | — | 11/10 B (không tái hiện), Q-07 |
| **K11-72** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | S2-12 'nhắc nợ/hết hạn đã ngừng phát': bác bỏ sau phản biện (đo sai) — bộ nhắc chỉ gửi khi còn đúng 7/3/1 ngày tới hạn hoá đơn (30/15/7 ngày tới hết HĐ), đợt gần nhất không còn gì để nhắc. Chỉ còn rủi ro thiết kế (P3): chạy trong trình duyệt, nuốt lỗi, chỉ quét hoá đơn do người đang mở app tạo — đã nằm trong L11. | — | 11/10 S2-12 → PHAN-BIEN-1110 #12 |
| **L03** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | /chi-tieu không gác ở route vì phục vụ 2 nhóm quyền; trang tự kiểm, máy chủ chặn ghi. | — | 07/10 A4 |
| **L08** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | /phongtrong token 'demo' là trang thương hiệu của chính công ty; phần sai xem N-A5-06. | — | 07/10 A5 |
| **L09** | ĐÃ SỬA trước 11/10 | — | 2 hàm đã vá ở 20261007003604; 4 hàm còn lại đúng thiết kế; gate ACL xanh. | — | 07/10 A5 |
| **L13b** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Chỉ số nhập bằng form duyệt ngay (auto-approve có chủ ý). | — | 07/10 A2 |
| **L38** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | KQKD dồn tích theo phiếu đã duyệt; lệch thực tế bằng không. | — | 07/10 A3 |
| **L43** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Ô ngày gốc theo ngôn ngữ trình duyệt (xem N-A6-16, K11-60). | — | 07/10 A6 |
| **L50** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | 'Chốt số' lấy số dư hôm nay, có chú thích cố ý. | — | 07/10 A2 |
| **L52** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | 'Easter egg' có chú thích; đề xuất hiện theo quyền (Q9). | — | 07/10 A3 |
| **L56** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Không tái hiện: corpus Copilot khớp 27 userDoc. | — | 07/10 A5 |
| **L62** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Tài khoản hệ thống trong DEMO phục vụ E2E Copilot. | — | 07/10 A5 |
| **L68** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Phiếu khoá cả khi phiên bàn giao đang chờ (chặt hơn tài liệu). | — | 07/10 A2 |
| **L69** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Ký từ nháp bắt buộc đủ chỉ số (chỉ sửa câu gợi ý 'để trống'). | — | 07/10 A1 |
| **L70** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Phiếu thu tiền hoá đơn APPROVED + POSTED ngay. | — | 07/10 A2 |
| **L72** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Không tái hiện: luồng thu chọn sổ đúng. | — | 07/10 A2 |
| **L74** | KHÔNG LỖI / ĐÚNG THIẾT KẾ | — | Không tái hiện: thông báo nhắc chốt sổ có sinh. | — | 07/10 A2 |


## 3. Câu hỏi cần chủ chốt (gộp Q1–Q11 của plan 07/10 với câu mới Q12–Q17)

| # | Câu hỏi | Mặc định đề xuất | Mục liên quan | Nguồn |
|---|---|---|---|---|
| Q1 | Bật kiểm contracts.terminate/transfer/renew và tasks.complete ở máy chủ | Bật. Hợp đồng: cả 5 vai có contracts.edit đều có đủ 3 khoá nên không ai mất quyền. Công việc: cấp tasks.complete cho vai Quản Lý Tòa ở cả 2 công ty TRƯỚC khi bật | L02, N-A6-08, N-A6-09 | 07/10 |
| Q2 | Cài đặt/tính năng 'ma' (L14, L15, L16, L17, L22, L23, L47) và công tắc Cài đặt chung lưu theo TÀI KHOẢN hay CÔNG TY | Ẩn hoặc gắn nhãn 'chưa hoạt động' ngay; công tắc 'tự duyệt hoá đơn' nối vào cờ cấp công ty (chỉ chủ sửa) và hiển thị đúng cờ đó (11/10 D-13: màn đang hiện TẮT trong khi cờ công ty BẬT); còn lại chỉ làm khi chủ chọn | L14–L17, L22, L23, L47, N-A2-02, K11-19 | 07/10 + 11/10 D-13 |
| Q3 | Bàn giao tiền mặt: cho nộp cho Chủ công ty (vai RBAC), không chỉ tài khoản hệ thống? | Có — người nhận hợp lệ = cùng đội hoặc có quyền nhận bàn giao cấp công ty (11/10 B xác nhận chủ công ty không cùng đội nên hiện không nhận được) | L10, N-A2-07 | 07/10 + 11/10 B |
| Q4 | Đổi mật khẩu: bật thêm Secure password change của Supabase Auth? | KHÔNG bật (tài khoản đăng nhập bằng email giả không nhận mã OTP); chỉ xác thực mật khẩu hiện tại trong app | L01 | 07/10 |
| Q5 | Nút 'Reset DEMO' trên site docs | Gỡ nút và khoá hàm | N-A5-05 | 07/10 |
| Q6 | Trang công khai /phongtrong: toà theo công ty của token và bỏ giá/cọc của phòng đã thuê? | Có cả hai (11/10 D-04 xác nhận ẩn danh vẫn thấy giá+cọc 70/74 phòng đã thuê) | N-A5-06, K11-06 | 07/10 + 11/10 D-04 |
| Q7 | Phiếu chi vượt cam kết tạo yêu cầu duyệt giao cho chủ (hiện ở /approvals)? | Có | N-A3-04 | 07/10 + 11/10 C-06 |
| Q8 | Bỏ hẳn bảng deposits cũ khỏi luồng | Có — production 0 dòng deposits/leads/tenants | L12, N-A6-04, K11-18 | 07/10 |
| Q9 | Tab 'Chốt LN tháng', 'Cổ đông', 'Lương của tôi' ẩn sau 3 lần bấm | Hiện theo quyền (Lương của tôi luôn hiện) | L52 | 07/10 |
| Q10 | Quyết toán đã thu lại phần làm tròn (N-A1-05): bù cho phiếu cũ? | Chỉ sửa từ nay, không lập chứng từ điều chỉnh cho phiếu cũ (mỗi phiếu nhỏ) | N-A1-05 | 07/10 |
| Q11 | Thu hồi 8 quyền cấp riêng categories.* toàn công ty còn sót của 2 quản lý? | Thu hồi (ghi lý do vào nhật ký phân quyền) | L04 | 07/10 |
| Q12 | Vai Quản Lý Tòa có nên giữ quyền 'Ghi thu chi cho MỌI toà nhà' (income_expenses.all_buildings) và tự duyệt trong ngưỡng (self_approve_within_limit) không? (C-01 đã bác bỏ thành đúng cấu hình; quyền này cũng là lý do form hiện nhiều toà hơn phạm vi). Kèm C-08: người giữ sổ thấy phiếu mọi toà đi qua sổ mình giữ | Giữ nguyên quyền all_buildings + tự duyệt trong ngưỡng (có chủ ý, có tài liệu 08-thu-chi-so-quy §4.13). Về C-08: giữ nhánh select_fund_member cho thủ quỹ đối soát nhưng báo cáo/tổng và RPC lương KHÔNG dùng nó (sửa bằng K11-34) | K11-57 (đã bác bỏ), K11-59, K11-34 | 11/10 C-01, C-08 + PHAN-BIEN-1110 #2 |
| Q13 | Quyền nào quyết định đổi giá/loại/nội thất/tình trạng phòng: rooms.edit (RLS) hay quyền sale_phong.*? | Chuyển việc ghi các cột này sang RPC kiểm quyền sale + phạm vi toà; RLS rooms.edit giữ cho các cột còn lại | K11-27, K11-40 | 11/10 S2 mục 6.4 |
| Q14 | Định nghĩa chuẩn 'phòng trống' / 'lấp đầy' và báo cáo cọc đọc từ đâu? | Giữ các định nghĩa hiện có (chênh giữa các màn chủ yếu là khác định nghĩa, không phải lỗi) nhưng ghi rõ trên từng màn; chỉ sửa Bảng tin lọc HĐ đã xoá mềm. Báo cáo cọc legacy: ẩn hoặc trỏ về /deposits (nguồn đúng theo tài liệu 04-coc-giu-cho) | K11-65, K11-18 | 11/10 D-06, D-07 + PHAN-BIEN-1110 #8, #9 |
| Q15 | Hoàn ngày không ở khi thanh lý tính /30 hay theo số ngày thực của tháng như hoá đơn? (A-07) | Theo ngày thực của tháng như hoá đơn (hai cách tính trong cùng hợp đồng gây tranh chấp); nếu điều khoản HĐ ghi 30 ngày thì giữ /30 và đổi hoá đơn tháng đầu cho khớp | K11-46 | 11/10 A-07 |
| Q16 | Ví công ty: ai được dùng — mọi thành viên ACTIVE hay chỉ chủ/người được cấp? | Theo code đã ghi: thành viên ACTIVE xem/tạo, ghi theo chủ ví + quyền sổ quỹ; chỉ sửa lỗi 403 (K11-37), không đổi mô hình | K11-37 | 11/10 Q-05, C-03 |
| Q17 | Chủ công ty có phải xem được cổ đông / lợi nhuận phân bổ / quản lý lợi nhuận của công ty mình? | Có — policy thêm nhánh my_company_owner_org_ids_v1 | K11-09 | 11/10 C-05, S1-F11 |

Nhắc: phần lớn câu có mặc định — trả lời 'đồng ý hết trừ Qx' là đủ. Mục có trạng thái CẦN CHỦ CHỐT trong bảng: K11-27, K11-46, K11-59.

## 4. Đề xuất đợt sửa hợp nhất

Giữ khung Đợt 0/1/2/3/4/D của plan 07/10; mục mới chèn đúng chỗ. Cỡ (thang thô): S ≤ 1 ngày công, M 1–3, L > 3. Luật thi hành chung (mỗi gốc một PR, test đỏ→xanh, TEST trước, `migrate:forward`, review chéo cho tiền/quyền/migration) giữ nguyên như plan 07/10 mục 1.

### Đợt 0 — chặn rủi ro (làm ngay)

| WP | Nội dung | Mục | Trạng thái | Cỡ |
|---|---|---|---|---|
| 0.0 | REVOKE monthly_building_profit + approve_meter_reading/bulk (PR #154) | K11-01, K11-03 | ĐÃ SỬA 11/10 | — |
| 0.1 | Ranh giới công ty: 35 bảng NOT NULL + trigger điền org + bỏ nhánh NULL; trigger khoá organization_id (258 bảng); hook gửi org. Sau merge: chạy lại D-09/E-05/E-06 trên TEST và xác minh N-A2-06, N-A4-03, N-A6-12 | N-A6-11, K11-02, N-A2-06, N-A4-03, N-A6-12 | ĐÃ SỬA 11/10 (migration 20261011042329 đã áp production 12:37, PR #156; app đang chờ CI/promote). Còn: xác minh N-A2-06, N-A4-03, N-A6-12 sau khi app lên | L (xong DB; chờ phát hành app) |
| 0.2 | Tách quyền hợp đồng ở máy chủ (terminate/transfer/renew) + REVOKE 4 hàm thanh lý cũ | L02 | CHƯA LÀM (chờ Q1) | S–M |
| 0.3 | confirm_cash_handover từ chối sổ ảo/sổ khác công ty; mọi ô chọn sổ lọc sổ ảo | N-A2-07, K11-49 | CHƯA LÀM — đã chứng minh, làm trước | S |
| 0.4 | Đổi mật khẩu kiểm mật khẩu hiện tại | L01 | CHƯA LÀM | S |
| 0.5 | Promote chấm CI cả dải | L54 | ĐÃ SỬA (PR #140) | — |
| 0.6 | REVOKE reverse_invoice_payment_v3, hàm anon nội bộ; thêm kiểm quyền cho 4 hàm 'chỉ cần đăng nhập' | N-A5-01, K11-10, K11-11 | CHƯA LÀM | S |
| 0.7 | Thêm kiểm quyền/phạm vi vào create_invoice_refund_obligation_v2 (P1: quyền hoàn tiền + toà) và log_income_expense_action (P2) | K11-04, K11-05 | CHƯA LÀM (mới 11/10) | S–M |
| 0.8 | Siết RLS ghi tiền: payments (bỏ DELETE, chặn PATCH amount), invoices; REVOKE UPDATE cột nhạy cảm của profiles. Phải thử ghi thật trên TEST trước | K11-24, K11-26 | CHƯA LÀM (mới 11/10, chưa thử ghi) | M |

### Đợt 1 — tiền và số liệu sai

| WP | Nội dung | Mục | Trạng thái | Cỡ |
|---|---|---|---|---|
| 1.1 | Báo cáo LN nhận LEGACY_RETAINED_UNALLOCATED | N-A3-01 | CHƯA LÀM — làm đầu tiên | S |
| 1.1b | RPC lương không ném cả lô: read_rent_support_salary_parts_v1 bỏ qua/NEEDS_REVIEW phiếu ngoài phạm vi; quét mọi RPC nhận lô (G7) | K11-34 | CHƯA LÀM (mới 11/10) | S–M |
| 1.1c | Ví công ty: SECURITY DEFINER/my_org_ids, không tự tải khi không quyền | K11-37 | CHƯA LÀM (mới 11/10) | S |
| 1.2 | Quyết toán: bỏ hoá đơn PAID khỏi vòng gom nợ; thống nhất net quyết toán và ngữ nghĩa contract_terminations; cách tính ngày (Q15) | N-A1-05, K11-41, K11-42, K11-46 | CHƯA LÀM | M |
| 1.3 | Bỏ cọc/hoàn cọc đóng giữ chỗ + claim; sổ nội bộ chọn theo mục đích; thẻ đếm; hiện đúng lỗi 55000 | N-A1-03, N-A1-02, N-A1-04, N-A1-06, N-A1-01 | CHƯA LÀM | M |
| 1.4 | Ẩn nút Cọc ở Khách hẹn → dùng create_room_reservation_v1; bỏ nhánh deposits; báo cáo cọc đọc đúng nguồn (Q8, Q14) | L12, N-A6-04, K11-18 | CHƯA LÀM | M |
| 1.5 | Một định nghĩa 'còn nợ' có OVERDUE; thống kê hoá đơn theo RBAC; nhãn Quá hạn đúng; (gộp 2.2 cho cron OVERDUE). L30 còn nguyên: Chủ công ty nhận toàn 0 | N-A4-04, L30, K11-14, K11-15, K11-16 | CHƯA LÀM | M |
| 1.6 | Lịch thanh toán RPC gộp; Khuyến mại; chi tiết toà !inner + count; lập hoá đơn không kéo HĐ cả công ty | L36, N-A6-06, N-A1-UI-01, K11-21 | CHƯA LÀM | M |
| 1.7 | Nhánh NULL building_id đòi phạm vi công ty; nút 'Toà đang phụ trách'; RPC hoàn thành việc (Q1) | N-A4-02, N-A4-01, N-A6-08, N-A6-09 | CHƯA LÀM | M |
| 1.8 | Chỉ số: import v1 + form đúng cột + UI duyệt + Tháng chốt/Ngày chốt + chống trùng + chặn sửa chỉ số đã lên hoá đơn | L13d, N-A2-01, L13e, L13a, L13c, K11-52 | CHƯA LÀM | M |
| 1.9 | Cho bỏ trống loại tài sản; /my-day không ném | N-A6-S01, L18 | CHƯA LÀM | S–M |
| 1.10 | Soát dữ liệu (đọc production, sửa qua luồng có vết): hoá đơn thanh lý tính sai + chỉ số ngày tương lai; phòng AVAILABLE có HĐ ACTIVE (1 phòng production) và tìm đường ghi tay | L28, K11-40 | CHƯA LÀM | M |
| 1.11 | Chức năng hỏng nhỏ mới: Zod timestamp quay số; bộ phận cho Loại công việc; hộp Sửa loại thu chi cuộn được; Thêm tầng | K11-62, K11-63, K11-64, K11-66 | CHƯA LÀM (mới 11/10) | S ×4 |
| 1.12 | Sale Phòng/trang công khai theo công ty + phạm vi; kiểm sale_phong.view; bỏ giá/cọc phòng đã thuê (Q6) | N-A5-06, K11-06 | CHƯA LÀM | M |

### Đợt 2 — gốc chung

| WP | Nội dung | Mục | Trạng thái | Cỡ |
|---|---|---|---|---|
| 2.1 | Bỏ phụ thuộc bảng tenants (G3): helper khách đại diện qua contract_customers (ghi rõ FK); xuất Excel; thu chi tenant_name | L32, L29, L31, N-A1-UI-02, N-A6-14, K11-17 | CHƯA LÀM | M |
| 2.2 | Nhắc việc + gắn OVERDUE chạy ở máy chủ (cron), người nhận theo quyền; bỏ chèn từ trình duyệt | L11, K11-14 | CHƯA LÀM | M–L |
| 2.3 | Bảng tin đúng phạm vi + get_dashboard_summary lọc HĐ đã xoá mềm (Q14) | N-A6-01, N-A6-02, N-A6-03, L49, L07, K11-65 | CHƯA LÀM | M |
| 2.4 | Quét hệ thống: RPC nhận lô (G7) và Zod nhận timestamptz::text (G9) | K11-34, K11-62 | CHƯA LÀM (mới 11/10) | S–M |

### Đợt 3 — P2 còn lại (nhiều PR nhỏ theo khu)

| WP | Nội dung | Mục | Trạng thái | Cỡ |
|---|---|---|---|---|
| 3.a | Quyền giao diện/máy chủ | L04, L05, L06, N-A4-07, N-A5-04, N-A6-13, N-A4-08, K11-36, K11-53, K11-27, K11-59, K11-08, K11-09, K11-07, K11-25 | CHƯA LÀM (Q11, Q12, Q13, Q17) | M–L |
| 3.b | Hợp đồng/cọc/giữ chỗ | L41, L71, L27, L20, L21, L26, L44, L73, N-A1-UI-03, K11-43, K11-44, K11-45 | CHƯA LÀM | M |
| 3.c | Chỉ số/hoá đơn/thu | N-A2-02, N-A2-03, N-A2-04, N-A2-05, L19, L14, L15, K11-28 | CHƯA LÀM (Q2) | M |
| 3.d | Sổ quỹ/báo cáo tài chính | L34, L35, L37, L39, N-A3-02, N-A3-04, K11-58 | CHƯA LÀM (Q7) | M |
| 3.e | Vận hành/tìm kiếm/nhập nhanh | L24, L25, N-A6-05, N-A6-07, L16, L17, L22, L47, L33, K11-22, K11-30 | CHƯA LÀM (Q2) | M |
| 3.f | Bảo mật nhỏ/công khai | N-A5-05 | CHƯA LÀM (Q5) | S |
| 3.g | Hiệu năng (đo lại trên production trước) | L53, K11-38, K11-39 | CHƯA LÀM | M |

### Đợt 4 — P3, dữ liệu, tooling

Toàn bộ P3 còn mở (60 mục): K11-10, K11-11, K11-12, K11-13, K11-16, K11-19, K11-20, K11-21, K11-23, K11-29, K11-31, K11-32, K11-33, K11-47, K11-48, K11-49, K11-50, K11-51, K11-54, K11-55, K11-56, K11-60, K11-61, K11-67, L42, N-A1-07, N-A1-UI-05, N-A3-07, N-A2-09, N-A2-10, N-A6-16, N-A6-S06, L45, N-A1-UI-04, N-A3-03, N-A3-06, N-A6-S04, N-A6-S05, N-A4-07, N-A6-10, N-A6-15, N-A2-08, N-A3-08, N-A4-05, L23, L40a, L40b, L51, L46, L48, L55, N-A5-02, N-A6-S07, L59, L60, L61, L63, L76, N-A4-06, A3-luong-dh.
Nhóm: nhãn/định dạng/nút thừa; logic nhỏ; dữ liệu DEMO/fixture (L59, L60, L61, L63, L76, N-A4-06 trên production sau khi đo lại, A3-luong-dh do chủ quyết); mã chết/tooling (L46, L48, L51, L55, N-A5-02, N-A6-S07, K11-19). Cỡ chung: M (3–4 ngày công).

### Đợt D — tài liệu (song song)

| WP | Nội dung | Mục | Trạng thái | Cỡ |
|---|---|---|---|---|
| D1/D2 | Sửa tài liệu theo plan 07/10 mục 7; thêm: người nhận bàn giao (sau Q3), ví công ty, lock tạm/cọc tên gợi nhớ nếu có trang liên quan, báo cáo tiền cọc (sau 1.4) | L10, L57 | CHƯA LÀM | 1–2 ngày rải |

**Thứ tự đề xuất:** 0.3 → 0.4 → 0.6 → 0.7 (đều S, đã chứng minh); sau khi app PR #156 lên production thì chạy lại D-09/E-05/E-06 và xác minh N-A2-06, N-A4-03, N-A6-12; 1.1/1.1b/1.1c (S, mất chức năng hằng ngày) ngay sau; 0.8 sau khi thử ghi thật trên TEST; các WP 1.x còn lại theo bảng ưu tiên 1.3. Ước lượng thô (cùng thang với plan 07/10, một người, 0.1 đã xong phần DB): Đợt 0 ≈ 3–5 ngày công, Đợt 1 ≈ 10–13, Đợt 2 ≈ 5–7, Đợt 3 ≈ 9–12, Đợt 4 ≈ 3–5, Đợt D ≈ 1–2 — tổng ≈ 31–44 ngày công (plan 07/10 là 26–35; phần tăng đến từ hàm DEFINER thiếu kiểm quyền, ghi thẳng bảng tiền, ví công ty/lương và các chức năng hỏng nhỏ mới).

## 5. Phần chưa phủ được (làm ở lượt kiểm sau)

| Khu | Chưa phủ |
|---|---|
| Hợp đồng/cọc | Duyệt + chi phiếu 'Trả khách thanh lý' (cần ảnh chứng từ + vai người giữ sổ); chuyển phòng (không còn phòng trống thật để thử); sửa HĐ ('Cập nhật'); xoá nháp; in HĐ trên trang chi tiết; nhượng HĐ 5 bước (từ 07/10); mobile Quick-deposit trên /sale-phong; thử tạo cọc vào sổ ảo ở form Tạo cọc |
| Chỉ số/hoá đơn/thu | Tạo hoá đơn kỳ; sửa dòng 'Điều chỉnh' + duyệt điều chỉnh; ghi chú hoá đơn; xuất Excel hoá đơn; thu hàng loạt (Mode Excel) và thu nhanh /thu-tien; OVERDUE trên trang chi tiết hoá đơn (K11-15); trang biên bản chốt /closure/:id; Đối soát (cashbook_reconciliations rỗng); vai Chủ công ty trên mobile; thực nghiệm 'không có cron' trên production |
| Thu chi/lương/LN | Phiếu theo lô (Phiếu tổng); import; phiếu lặp; ví cá nhân (tạo giao dịch/mục tiêu); /chi-tieu lưu thật; công tắc/luật hạng mục ở Cam kết chi; trả lương hàng loạt; nghỉ phép; nhóm lương TOTAL_GROUP; chốt LN thật + mở chốt; business-performance đối chiếu số; huỷ duyệt (Super Admin); 'Từ chối & huỷ đề nghị' chốt sổ; 'Chi lợi nhuận' (còn bị N-A3-01 chặn); L40(c), đo lệch L35/L37; /approvals có yêu cầu thật |
| Chưa kết luận (cần soi nguồn) | Preview chốt LN 09/2026 của 950NK lệch truy vấn thô (lệch cả thu lẫn chi) — chưa đọc _profit_close_preview_core_v2; 12 hoá đơn PAID có paid_amount ≠ tổng payment chưa đảo  — nghi trừ tín dụng khách; RPC công khai có trả hoá đơn đã huỷ không (K11-15); nguồn dòng hotline 10/10; /reports/finance/ban-giao hiện toàn 0 cho Chủ công ty trong khi cash-book có thu chi (chưa rõ ý đồ) |
| Cài đặt/danh mục/vật tư/sale | Sửa tài sản có sẵn (nút sửa không bấm được bằng selector); phiếu xuất/kiểm kê vật tư; tạo xe; quay số (tạo sự kiện, quay — bị K11-62 chặn); Mẫu biểu (cần tải .docx); /settings/finance/fixed-fees (chỉ mở); /admin/users bằng super admin; thử lại L22/L23; xuất Excel báo cáo tài chính (Lịch thanh toán không có nút xuất); đối chiếu số tổng một-một từng báo cáo tài chính (mới đối chiếu: cọc, lấp đầy, khuyến mại, lịch thanh toán) |
| Quyền/API | Nội dung thật của sale_bonus_note và reservation_hold_deadlines (TEST không có dữ liệu mẫu); company_wallet_mutate, create_cash_handover, propose_cashbook_closing_v1 kết luận không rõ (lỗi validate chặn trước bước kiểm quyền) — cần payload đúng hoàn toàn; profit_close_*; hotlines/mẫu thu chi NULL-org bằng tài khoản khác ngoài tài khoản DEMO; hàm LANGUAGE khác plpgsql/sql và edge function chưa quét; RLS chi tiết bảng zalo_*; edge bank-event-ingest/admin (S1); khai thác ghi thật cho các mục S1 chưa thử (F2 với bảng còn lại, F6 đã thử, F4 trên TEST) |
| Code mới 07→11/10 (S3) | exportRoomListImage.ts (canvas), room-list-image.js worker, MobileDisplaySettings từ dòng ~330, GmailSetup/BankEventsPage UI, MainActivity/GatewaySettings Android, extension tạm trú, tài liệu docs/; chưa chạy Gmail thật; parser bank-events-parse là heuristic chỉ hiển thị |
| Phạm vi kiểm | Quét route chỉ 19 trang × 2 vai ở mobile 390 (desktop 117 route × 4 vai); không quét Copilot (chủ dặn); hiệu năng đo trên TEST (máy Nano chung, nhiễu) — cần đo lại trên production bằng pg_stat_statements; TEST thiếu byte ảnh/mẫu HĐ nên không kiểm in .docx, upload ảnh thật |

Luồng ĐÃ kiểm đạt (để khỏi lặp lại):

- Lock tạm 6 giờ (tạo/gỡ, ẩn khỏi trang công khai, quyền theo vai) và giữ chỗ tên gợi nhớ → bỏ cọc/hoàn cọc → gắn khách thật → tạo HĐ → ký → hoá đơn đầu → gia hạn → trả phòng quyết toán sau → quyết toán: số liệu trong DB khớp (A).
- Thu đủ/thu một phần/đổi hình thức thu/đảo thu hoá đơn; bàn giao tiền mặt (lập, xác nhận, huỷ hai bên); chốt quỹ wizard (đề xuất/xác nhận/huỷ, chặn trùng, chặn vai sai); duyệt/bỏ duyệt hoá đơn RPC; phí kỳ /thanh-toan; mobile 390 không tràn ngang (B).
- Tạo phiếu chi/thu (ngưỡng tự duyệt, vượt cam kết chờ duyệt), duyệt, chi từ sổ + ảnh, sửa phiếu chờ duyệt, huỷ/đảo/mở lại, chi tiết + in; ví công ty bằng super admin; chốt kỳ lương + mở khoá (C).
- Cài đặt chung (5 tab), 14 màn danh mục, thêm→sửa→xoá auto-debt/kho/hotline/định mức/mẫu in/công tơ/loại thu chi; tổ chức (vai, ngoại lệ có lý do, mời thành viên); khách hẹn, vật tư + phiếu nhập, việc, link Sale Phòng, Excel 'Căn hộ trống/Cho thuê' khớp màn (D).
- Ma trận quyền ngoài phạm vi: 9 RPC ghi và PATCH REST trực tiếp bị chặn đúng; đọc chéo công ty DEMO = 0 dòng ở 6 bảng × 3 vai; anon enum 25 hàm không lộ dữ liệu (E).
- Quét 489 lượt route × vai: 0 request ra ngoài TEST (G2). Review code mới 07→11/10: lock tạm, cọc tên gợi nhớ, public_room_settings, chỉ số trả phòng, ví công ty, biên nhận Android, Zalo canh gác, realtime finance đạt (S3).

## 6. Lưu ý vận hành

- Dữ liệu thử của đợt 11/10 đặt tên `AUDIT1110` trên TEST và sẽ mất khi `test-env:sync` lần sau; một số dòng không dọn được vì thiết kế (chuỗi audit băm chỉ ghi thêm, phiếu luồng hoàn tiền) — vô hại, chỉ nằm trên TEST.
- Không có thông tin xác thực nào trong tài liệu này.
- Mọi kết luận 'CÒN · tái hiện' bằng thao tác nêu rõ ở cột Bằng chứng; mục chỉ đọc source/catalog được ghi '(đọc …)'.

## 7. Bất đồng giữa các nguồn và cách xử lý

- Phản biện độc lập 11/10 (PHAN-BIEN-1110) thắng báo cáo nhóm khi bất đồng: C-01/K11-57 sai gốc (quyền all_buildings là tính năng có chủ ý), Q-02/K11-35 do TEST quá tải (đo lại 243 ms; production cùng cấu hình), S2-12 đo sai (bộ nhắc chỉ gửi khi còn đúng 7/3/1 ngày). Hạ mức: F5→P2, D-02→P2, D-03→P2, D-06→P2, D-07→P2 (bỏ phần '/apartments Tổng phòng 4' vì đọc nhầm thứ tự thẻ; giữ phần Bảng tin đếm 2 HĐ xoá mềm còn ACTIVE), A-01→P2 (1 phòng production). Giữ P1: Q-01/C-02, C-03, F6, D-01, N-A1-03 (tiềm ẩn); L30 còn nguyên.
- Mức bất đồng còn lại: K11-06 (S1 P2 / E P1–P2 — mới chứng minh cấu trúc), N-A5-06 (07/10 P2 / D-04 P1), N-A4-08 (07/10 P3 / Q-03 P2), L13e (07/10 P2 / B-03 P1), N-A1-UI-02 (07/10 P2 / D-05 P1 khi gộp), K11-37 (Q-05 P2 / C-03 P1 — phản biện giữ P1), K11-01 (plan 02/09 P2 / S1 P0). Bảng đã lấy MỨC CAO NHẤT có bằng chứng.
- Ví công ty: S1 §5 và S3 (đọc tĩnh) kết luận 'không phát hiện lỗi', nhưng C-03/Q-05 chạy thật thấy 403 cho mọi người trừ super admin. Tin kết quả chạy thật; bài học: review tĩnh không thay được thử bằng JWT thật.
- N-A6-11: S1 dự đoán hotlines và mẫu thu chi lộ chéo qua can_access_org_entity, E-05 thử thật thì tài khoản DEMO đọc 0 dòng hai bảng này (chỉ vật tư và nhóm việc lộ); areas bị RLS 403 ngay (S1 nói tạo được). Giữ N-A6-11 là P0 vì lộ chéo đã chứng minh ở 2 bảng.
- '/invoices 32 s mới yên' (Q-07) KHÔNG tái hiện (B đo 5,8 s); các số chậm khác đo lúc TEST đông — chỉ xem là nghi vấn hiệu năng (K11-38), không phải lỗi đã xác nhận.
- Số OVERDUE khác nhau giữa hai đợt (07/10: 86 hoá đơn; 11/10 production: 65) vì OVERDUE chỉ được gắn khi có người mở trang Hoá đơn (K11-14) — bản thân đó là bằng chứng của lỗi.
- S1 ghi các trigger điền org 'đã vá từ 07/10' cho material_usages/settings/public_room_settings, nhưng chính trigger strict ném 23502 với người đa công ty là gốc N-A4-03/N-A6-12 của 07/10: chưa ai thử lại hai mục này trên TEST.
- E-11 và S1-F1: TEST đã có bản vá (anon=false) trong khi S1 đo production HEAD 3b899acc còn mở — khớp thứ tự PR #154 (vá TEST/prod sau khi đo).
- Q-04: C xác nhận Chủ công ty không còn lỗi ở /settings/finance/cam-ket-chi; chỉ quản lý và đối tác bị.
