# Kiểm thử thật trên TEST + thống kê và kiểm lại toàn bộ lỗi — 07/10/2026

> **Trạng thái phát hành:** đợt này KHÔNG đổi code, schema hay dữ liệu production. Production chỉ bị đọc
> (`BEGIN READ ONLY … ROLLBACK`). Mọi thao tác ghi chạy trên môi trường TEST (`ihomecrm-test`, bản sao production
> đồng bộ lúc 17:51 07/10). Plan sửa: [`docs/superpowers/plans/2026-10-07-sua-loi-sau-kiem-thu-test.md`](../../superpowers/plans/2026-10-07-sua-loi-sau-kiem-thu-test.md).

## 1. Phạm vi và cách làm

| Hạng mục | Chi tiết |
|---|---|
| Mã nguồn | `1c616829` (= `main` = `production` lúc kiểm) |
| Dữ liệu | TEST đồng bộ lại từ production bằng `npm run test-env:check -- --sync`: 5/5 bước ĐẠT (sync 603 s, snapshot, JWT/RLS, Chrome, mã nguồn không đổi). Biên nhận: `%USERPROFILE%/ihomecrm-backups/test-env-checks/2026-10-07T10-51-45-516Z/` |
| App thử | Bản build `1c616829` cấu hình TEST, chạy loopback; trình duyệt thử CHẶN mọi request không phải app local/TEST (0 request lọt ra production) |
| Tài khoản | Chính: tài khoản hệ thống (super admin) theo yêu cầu. Phụ để thử quyền: `nguyentam` (Chủ công ty), `joey`/`nathan`/`bosshuy` (Đội thu tiền), `demo.*` (org DEMO), tài khoản fixture `audit0710a` (đã chặn đăng nhập sau khi thử) |
| Nhóm thử | A1 Hợp đồng–cọc–thanh lý · A2 Hoá đơn–chỉ số–thu tiền–bàn giao · A3 Thu chi–sổ quỹ–chốt–lương–lợi nhuận · A4 Quyền–tài khoản–cài đặt · A5 Production chỉ-đọc + tooling + DEMO · A6 Vận hành–báo cáo BĐS. Mỗi nhóm một toà riêng |
| Kiểm lại | (1) Mỗi nhóm tự phản biện trước khi kết luận; (2) điều phối tự đối chiếu source + thân hàm/dữ liệu production cho L01, L54, N-A4-02, N-A4-04, N-A6-11, N-A3-01, N-A1-UI-01; (3) hai agent phản biện độc lập cố bác bỏ MỌI mục P0/P1 còn lại + 10 mẫu P2 — kết quả ở [PHAN-BIEN.md](PHAN-BIEN.md): **0 mục bị bác bỏ**, 4 mục đổi mức, 1 mục sửa số liệu |
| Báo cáo gốc từng nhóm | [A1](A1.md) ([kiểm UI](A1-ui.md)) · [A2](A2.md) · [A3](A3.md) · [A4](A4.md) · [A5](A5.md) · [A6](A6.md) · [Phản biện](PHAN-BIEN.md) |
| Bằng chứng (ảnh, nhật ký mạng, SQL) | `C:\Users\Nguyen Tam\ihomecrm-backups\audits\2026-10-07-kiem-thu-test-env\` — NGOÀI repo vì ảnh chụp chứa dữ liệu thật của bản sao TEST (đã xoá mật khẩu/token khỏi nhật ký). Đường dẫn `A#/…` trong báo cáo gốc tính từ thư mục đó |

**Mức:** P0 = tiền sai/mất, lộ dữ liệu, lách quyền đang khai thác được · P1 = chức năng hỏng/sai số liệu/lỗ quyền chưa ai khai thác · P2 = UX/nhãn gây hiểu nhầm, lỗi phụ · P3 = dọn dẹp/mã chết/dữ liệu.
**Kết luận:** XÁC NHẬN · KHÔNG TÁI HIỆN · ĐÃ SỬA · ĐÚNG THIẾT KẾ · CHỈ DỮ LIỆU · CHƯA KIỂM ĐƯỢC.

## 2. Thống kê

| Phân loại | Số mục | Ghi chú |
|---|---|---|
| **P0** | **1** | N-A6-11 (ranh giới công ty) |
| **P1** | **19** | 6 về tiền/sổ/chỉ số, 7 về số liệu báo cáo sai, 4 về quyền/tài khoản/phát hành, 2 chức năng hỏng |
| **P2** | **67** | gồm L10 (tài liệu sai) và L53 (rủi ro hiệu năng, không tái hiện lỗi) |
| **P3** | **37** | gồm 6 mục chỉ là dữ liệu |
| Không phải lỗi | 16 | 11 đúng thiết kế, 1 đã sửa (L09), 4 không tái hiện (L53 đếm cả ở P2) |
| **Tổng mục đã kết luận** | **139** | 74 mục từ danh mục giả thuyết ban đầu + 65 lỗi mới phát hiện khi thử thật |
| Luồng con chưa kiểm được | 13 | mục 7 — do hết thời gian phiên hoặc bị chính lỗi đã xác nhận chặn |

Theo nhóm nguyên nhân gốc (dùng để chia đợt sửa trong plan):

| Gốc | Nội dung | Mục tiêu biểu |
|---|---|---|
| G1 | Bản ghi tạo không gắn `organization_id` / người dùng đa công ty không ghi được | N-A6-11, N-A2-06, N-A4-03, N-A6-12 |
| G2 | Máy chủ kiểm quyền khác giao diện (thiếu kiểm hoặc chỉ kiểm ở giao diện) | L02, N-A4-02, N-A6-08, L04, L05, L06, L07, N-A4-01, N-A5-01 |
| G3 | Còn đọc bảng `tenants` cũ (bảng rỗng; 444/444 HĐ có `tenant_id` NULL) | L32, N-A1-UI-02, L31, L29, N-A6-14 + 26 chỗ nhúng trong `src/` |
| G4 | "Còn nợ" lọc thiếu `OVERDUE` (hoá đơn quá hạn biến mất) | N-A4-04, L11 (nhắc nợ chỉ bắt 9/95), `DebtChart`, `useDashboard` |
| G5 | Chức năng chạy từ trình duyệt thay vì máy chủ | L11 (nhắc việc), N-A6-09 (hoàn thành việc) |
| G6 | Tính năng/cài đặt "ma" (có màn, không có tác dụng) | L14, L15, L16, L17, L22, L23, L47, N-A2-02, N-A1-UI-04 |

## 3. Lỗi đã xác nhận — P0 và P1 (đã qua phản biện)

| ID | Lỗi | Mức | Kiểm lại | Gốc (rút gọn) | Đợt sửa |
|---|---|---|---|---|---|
| N-A6-11 | Vật tư, phiếu nhập/kiểm kê kho, kho tài sản, hotline, cấu hình gạch nợ được lưu với `organization_id` trống ⇒ tài khoản công ty khác (cả `demo.*` phát cho người đọc docs) đọc/sửa/xoá được. Production hiện 0 dòng lộ; mọi dòng tạo mới sẽ lộ | P0 | Điều phối, trên production: policy `materials_org_boundary` (RESTRICTIVE) cho qua `organization_id IS NULL`, cột cho NULL, không trigger gắn công ty; hook không gửi org | Hook thiếu `organization_id`; policy ranh giới chấp nhận NULL | 0 |
| L02 | Người bị CẤM `contracts.terminate` nhưng có `contracts.edit` vẫn thanh lý được qua API (UI chỉ ẩn nút); chuyển phòng/nhượng/gia hạn cũng chỉ kiểm `contracts.edit`; 4 hàm thanh lý cũ không còn màn gọi vẫn mở cho người dùng đăng nhập (thanh lý thẳng, bỏ qua hồ sơ trả phòng) | P1 (P0 khi tách vai) | Phản biện: GIỮ, hạ P0→P1 — production hôm nay 0 người bị ảnh hưởng (mọi vai có `edit` đều có `terminate`); 0/56 hàm thanh lý/chuyển kiểm `terminate` | `assert_contract_exit_writer_v1` + wrapper chỉ kiểm `contracts.edit` | 0 |
| N-A2-07 | Nhận bàn giao vào SỔ ẢO: bên giao bị trừ 2 triệu (POSTED), bên nhận không ghi sổ ⇒ tiền biến khỏi sổ thật; người đa công ty còn chọn được sổ của công ty khác | P1 (sát P0) | Phản biện: GIỮ — thân hàm production trùng; production 0/17 phiên vào sổ ảo (chưa xảy ra) | `confirm_cash_handover` không chặn `is_virtual`/sổ khác tổ chức; UI liệt kê sổ ảo | 0 |
| L01 | Đổi mật khẩu không kiểm "Mật khẩu hiện tại" (nhập sai vẫn đổi được), desktop + mobile | P1 | Điều phối: `useChangePassword` chỉ nhận mật khẩu mới; `currentPassword` không được gửi | `src/hooks/useProfile.ts:166-171` | 0 |
| L54 | Script promote chỉ chấm CI của SHA đích ⇒ commit đỏ nằm giữa lọt production (7/13 lần promote 05–07/10 mang theo push đỏ/huỷ) | P1 | Điều phối: `validAggregateForRun` chỉ đòi `snapshot.head === sha`, lệnh push đẩy cả dải | `scripts/promote-to-production.mjs:114-117,156-157,314` | 0 |
| N-A3-01 | Báo cáo Lợi Nhuận → tab Tổng quan (và Chốt LN của tháng chốt kiểu cũ) báo "Chưa tải được…" — hỏng từ 30/09 | P1 | Điều phối: production có 18 dòng `LEGACY_RETAINED_UNALLOCATED` (17 dòng đã chốt T05/2026); `disposition()` ném lỗi với giá trị này | `src/lib/profitReadModels.ts:18` | 1 |
| N-A1-05 | Quyết toán trả phòng thu lại phần làm tròn của các hoá đơn ĐÃ TRẢ ĐỦ ⇒ nợ thực khác số trên màn xác nhận | P1 (số tiền nhỏ) | Phản biện: GIỮ — rủi ro hiện tại ≈ 93.666 đ (88 hoá đơn PAID còn chênh trên 65 HĐ); lịch sử đã thu thừa 25.202 đ qua 41 phiếu | vòng lặp trong `terminate_contract_move_out_impl` (bản cuối `20260915074638…:627-646`) | 1 |
| N-A1-03 | Xử lý bỏ cọc giữ chỗ xong, giữ chỗ + claim vẫn "sống" ⇒ phòng "Trống" nhưng không ai giữ chỗ/ký được | P1 | Phản biện: GIỮ — production chưa có claim treo (0 giữ chỗ) | `settle_reservation_deposit_v1`/`reservation_pay_refund_v1` không đóng giữ chỗ | 1 |
| L12 | Nút "Cọc" ở Khách hẹn ghi bảng `deposits` cũ ⇒ khoá phòng ngoài tầm nhìn, chặn cả giữ chỗ và ký HĐ; không màn nào gỡ được | P1 | Phản biện: GIỮ — production `leads`/`deposits`/`tenants` 0 dòng ⇒ chưa phòng nào bị khoá | `ConvertLeadDialog.tsx:151-162` | 1 |
| N-A4-04 | "Công nợ tổng" bỏ toàn bộ hoá đơn QUÁ HẠN (production 86 hoá đơn / 309,7 triệu) | P1 | Điều phối: `get_dashboard_summary` trên production lọc `status IN ('APPROVED','PARTIAL_PAID')`; cùng mẫu ở `DebtChart.tsx:35`, `useDashboard.ts:248`, `notificationScheduler.ts:114,176` | lọc trạng thái thiếu OVERDUE (G4) | 1 |
| L30 | Thẻ thống kê Hoá đơn ra 0 cho Chủ công ty; 1 Quản Lý Tòa thiếu 1 toà; DEMO 7/8 người thấy 0 | P1 | Phản biện: GIỮ — đếm trên production | `get_invoice_statistics_v2` tính phạm vi qua `staff_assignments` | 1 |
| L36 | Lịch thanh toán cắt 1.000 dòng ⇒ 273/285 phòng hiện sai "đã lên HĐ đến"; không cột tiền; lọc phòng không chạy; tính cả hoá đơn đã thu | P1 | Phản biện: GIỮ — production 1.698 hoá đơn trong cửa sổ, sai càng ngày càng tăng | `src/hooks/reports/financeReports.ts:25-44` | 1 |
| N-A6-06 | Báo cáo Khuyến mại: đếm 276 HĐ "có giảm giá" (thật: 5), tổng 0 đ (thật: ~5,9 triệu) | P1 | Phản biện: GIỮ — đếm trên production | `realEstateReports.ts:722,744` | 1 |
| N-A1-UI-01 | Chi tiết toà: tab Hợp đồng/Hoá đơn sai (44TL hiện 4 HĐ thay vì 27; 47/50 hoá đơn của toà khác) | P1 | Điều phối: `.limit(50)` + lọc trên bảng nhúng không `!inner` | `usePropertyDetailQueries.ts:93-99` | 1 |
| N-A4-02 | Người chỉ được giao MỘT toà tạo/sửa/xoá được bản ghi cấp công ty (`building_id` NULL) ở 8 bảng | P1 | Điều phối, trên production: nhánh NULL dùng `can_access_org_entity` = `has_any_scope_v3` (bất kỳ phạm vi) | RLS 8 bảng (G2) | 1 |
| L13d | Import chỉ số dùng hàm legacy tìm công tơ theo `user_id` người gọi ⇒ Import chưa bao giờ chạy được trên production | P1 | Phản biện: GIỮ — 274/274 công tơ đứng tên 1 tài khoản; 0 chỉ số UNAPPROVED trong 120 ngày | `bulk_create_meter_readings` (2025) | 1 |
| N-A2-01 | Form Thêm chỉ số: cột "Tên công tơ" trống, không có cột phòng (đọc sai tên cột, từ 28/05) ⇒ dễ nhập nhầm công tơ | P1 | Phản biện: GIỮ | `meterReadingFormUtils.ts:11-19,102-105` | 1 |
| N-A6-S01 | Không tạo/SỬA được tài sản (bắt buộc "Loại tài sản" mà danh mục rỗng; màn Loại tài sản là trang giữ chỗ) | P1 | Phản biện: GIỮ — production 585/585 tài sản không loại, `asset_categories` 0 dòng | `CreateAssetDialog.tsx:27`, `EditAssetDialog.tsx:27` | 1 |
| L32 | 4 báo cáo BĐS (Khuyến mại, Cho thuê mới, Bỏ trả, Sắp hết hạn) hiện khách "N/A" cho 100% hợp đồng (cả file xuất) | P1 | Phản biện: GIỮ — production 444/444 HĐ `tenant_id` NULL | `realEstateReports.ts:361,715,788,855` (G3) | 2 |
| L11 | 4 bộ nhắc việc chạy TỪ TRÌNH DUYỆT khi có người mở Bảng tin desktop, chỉ nhắc người tạo bản ghi (Chủ công ty nhận 0), chèn trùng; nhắc nợ quá hạn chỉ bắt 9/95 hoá đơn, 17 hoá đơn chưa từng được nhắc; nội dung "của undefined" | P1 | Phản biện: GIỮ + xác nhận bổ sung của điều phối về `OVERDUE` | `useScheduledNotifications.ts`, `notificationScheduler.ts` (G4, G5) | 2 |

## 4. Lỗi đã xác nhận — P2

| ID | Lỗi | Kiểm lại | Đợt |
|---|---|---|---|
| L18 | `/my-day` lỗi toàn màn khi công ty chưa bật luật ngày công v5 (chỉ org DEMO) — cũng là trang dự phòng khi bấm thông báo thiếu quyền | Phản biện: hạ P1→P2 | 1 |
| N-A6-08 | Quyền "Hoàn thành công việc" (`tasks.complete`) không được kiểm ở đâu — ai có `tasks.edit` đều hoàn thành + được chấm công | Phản biện: hạ P1→P2 (không lách phạm vi; chờ Q1) | 1 |
| N-A1-UI-02 | Chi tiết căn hộ/toà đọc bảng `tenants` cũ ⇒ "Căn hộ chưa có khách hàng" với phòng đang thuê | Phản biện: hạ P1→P2; thành P1 ngay khi sửa L20/L73 ⇒ sửa cùng lúc | 2 |
| L04 | Màn Trung tâm tài chính: người không xem được báo cáo vẫn đổi được phân loại vai trò tài chính cả công ty | Phản biện: GIỮ — joey/nathan qua nhờ quyền cấp riêng `categories.*` toàn công ty còn sót từ đợt chuyển đổi 07–08 | 3 |
| L05 | Nút Xuất báo cáo BĐS không kiểm `reports_real_estate.export` (cùng mẫu `reports_finance.export`) | — | 3 |
| L06 | Trang CRUD cài đặt luôn hiện Thêm/Sửa/Xoá; máy chủ chặn đúng | — | 3 |
| L07 | `dashboard.view_finance` không ẩn thẻ tiền; `/` không kiểm `dashboard.view` | — | 2 |
| L10 | Tài liệu `quy-trinh-ban-giao` sai (câu do đợt đồng bộ docs 07/10 thêm): danh sách người nhận chỉ gồm cùng đội + super admin; máy chủ KHÔNG nhận vai "Chủ công ty" ⇒ nhân viên không bàn giao được cho chủ thật | — | D (+ Q3) |
| L13a | Không chặn trùng chỉ số cùng công tơ + kỳ (production: 11 nhóm trùng thật; 59 nhóm khác là chỉ số chốt trả phòng — đúng thiết kế) | Phản biện: GIỮ, sửa số liệu (69→11) | 3 |
| L13c | Chỉ số đã duyệt vẫn sửa/xoá được (kể cả nhân viên qua API), không nối lại chuỗi | — | 3 |
| L13e | Chỉ số đầu lấy sai khi ghi lùi ngày (chồng 106 kWh trên dữ liệu thật) | — | 3 |
| L14 | Công tắc "Tự động sinh hóa đơn kỳ tiếp" không có tác dụng; FAQ vẫn hứa | — | 3 (Q2) |
| L15 | Các công tắc Cài đặt chung (Thu chi, Hợp đồng, Hoá đơn, 2 nhắc thông báo) lưu theo tài khoản, không chỗ nào đọc; cờ thật ở bảng tổ chức không có màn ghi | — | 3 (Q2) |
| L16 | Định mức bậc thang không được dùng khi tính hoá đơn | — | 3 (Q2) |
| L17 | Gạch nợ tự động chỉ có màn cấu hình, không có phần chạy | — | 3 (Q2) |
| L19 | Link "Mở phiếu" ở hộp Hoàn trả khách → 404 | — | 3 |
| L20 | Link `/rooms/<id>` (khối dọn/sửa, nút mắt) đưa về danh sách, mất id | — | 3 |
| L21 | Trang CT01 không có thanh bên; nút quay lại về danh sách khách | — | 3 |
| L22 | Hộp Thêm mẫu không đưa được mẫu vào tab "Mẫu chữ ký"/"HĐ đặt cọc" | — | 3 (Q2) |
| L24 | Ô nhập nhanh công việc không nhận toà chưa có mã (đường tạo việc duy nhất) | — | 3 |
| L25 | Chat Zalo "Đã chạy 0 lượt hôm nay" gán cứng | — | 3 |
| L26 | Form Toà nhà báo lỗi đỏ khi chỉ đang tải | — | 3 |
| L27 | Ghi chú thanh lý bỏ cọc ghi "(chờ duyệt)" dù đã tự duyệt | — | 3 |
| L28 | Chỉ số TLY ghi kiểu nuốt lỗi; số cuối ở "Thu thêm" không thành mốc trả phòng | Phản biện: GIỮ — lỗi bị nuốt đã che **INV-2026-00937** (tính theo số không khớp công tơ) + một chỉ số ghi ngày tương lai 31/10/2026 ⇒ cần soát tay | 1 (soát dữ liệu) / 3 |
| L29 | Hộp Ghi nhận thanh toán trống "Khách hàng:" | — | 2 |
| L31 | Hộp chi tiết phòng ở Sơ đồ toà trống "Khách hàng:" | — | 2 |
| L33 | Báo cáo Bỏ trả: cột Lý do in nguyên ghi chú quyết toán dài, chữ bị cắt | — | 3 |
| L34 | Sổ quỹ theo ngày: số dư đầu không cộng số dư đầu kỳ của sổ (tiềm ẩn: production chưa có sổ đang dùng nào có đầu kỳ ≠ 0) | Phản biện: GIỮ | 3 |
| L35 | Dòng tiền: cột "Doanh thu/Chi phí/Lợi nhuận" thực là tiền vào/ra (gồm cọc) | — | 3 |
| L37 | Tỷ lệ chi phí: mô tả "hóa đơn đã duyệt" nhưng cộng phiếu thu | — | 3 |
| L39 | Trung tâm tài chính: 73 dòng cấu hình báo đỏ đẩy bảng theo toà xuống cuối | — | 3 |
| L41 | Hộp sơ đồ in mã thô `RESERVED`/`OCCUPIED` (+ 5 cách gọi trạng thái phòng, P3) | — | 3 |
| L44 | Form sửa toà trống Tỉnh/TP với 14/19 toà (so khớp tên tuyệt đối) | — | 3 |
| L47 | Màn giữ chỗ: Nhà cung cấp, Loại tài sản, Lịch sử di chuyển/sửa chữa ở Cài đặt (P2); TK ngân hàng, Chữ ký, Danh mục chung, Xuất/Nhập phương tiện, ô kho tài sản (P3) | — | 3 (Q2) |
| L49 | Biểu đồ Công nợ không lọc theo toà | — | 2 |
| L53 | Production không timeout với 1 người dùng; timeout ngày 06/10 do chính đợt chụp ảnh docs chạy song song. Biên tải mỏng: `get_my_permissions_v2` max 7,8 s, HĐ phân trang max 7,7 s, `get_contract_stats` max 7,9 s (giới hạn 8 s) | — | 3 (hiệu năng) |
| L57 | `docs/he-thong/02-…` (và `08-…:37,112`) mô tả sai định mức bậc thang / gạch nợ | — | D |
| L71 | Chuyển phòng khác toà: máy chủ chặn đúng nhưng trả mã 42501 ⇒ UI báo "Không đủ quyền" cả với super admin; UI cho chọn mọi toà | Phản biện: GIỮ | 3 |
| L73 | Không có lối vào trang chi tiết toà/căn hộ từ hai danh sách | — | 3 |
| N-A1-01 | Lỗi máy chủ rõ ràng khi giữ chỗ bị chặn bị app thay bằng "Chưa xác định được nguyên nhân" | — | 3 |
| N-A1-02 | Bỏ cọc giữ chỗ ghi cặp bút toán vào sổ ảo CŨ NHẤT công ty (production: sổ tiền thối "Hiển Thối" của một nhân viên) | Phản biện: GIỮ | 1 |
| N-A1-04 | Thẻ "Đang giữ chỗ" ở /deposits đếm cả phiếu đã xử lý | — | 3 |
| N-A1-06 | HĐ đã thanh lý vẫn hiện "Còn thiếu … tiền cọc" | — | 3 |
| N-A1-UI-03 | Nút "Quản lý căn hộ" ở chi tiết toà mất bộ lọc toà | — | 3 |
| N-A2-02 | Ô "Công tơ chưa chốt trong tháng" vô tác dụng | — | 3 |
| N-A2-03 | Lọc Phòng ở danh sách Ghi chỉ số không lọc | — | 3 |
| N-A2-04 | Thẻ thống kê Ghi chỉ số đếm theo `user_id` | — | 3 |
| N-A2-05 | Hộp Tạo hoá đơn lẻ ghi "nháp, chờ duyệt" nhưng tạo ra APPROVED | — | 3 |
| N-A2-06 | Người dùng thuộc 2 công ty không tạo được phiên bàn giao (23502) | Phản biện: GIỮ | 0 (gộp N-A6-11) |
| N-A3-02 | Lập phiếu vào sổ đã chốt: app báo câu chung chung; Báo chi nhanh còn chọn sẵn sổ đã chốt | — | 3 |
| N-A3-04 | Phiếu chi vượt cam kết "Chờ duyệt" nhưng KHÔNG tạo yêu cầu duyệt ⇒ `/approvals` rỗng (tài liệu nói ngược) | — | 3 (Q7) + D |
| N-A4-01 | Nút "Toà đang phụ trách" khi thêm ngoại lệ quyền lại lưu phạm vi TOÀN CÔNG TY | — | 1 |
| N-A4-03 | Super admin (2 công ty) không lưu được bất kỳ cài đặt nào (23502) ⇒ bán kính nghiệm thu (geofence) của cả đội không đổi được qua giao diện | Phản biện: GIỮ, hệ quả thật hơn báo cáo gốc | 0 (gộp N-A6-11) |
| N-A5-01 | `reverse_invoice_payment_v3` còn cho `authenticated` gọi, khoá org trước khi kiểm quyền | — | 0 |
| N-A5-04 | Danh mục phạm vi phân quyền vẫn liệt kê toà/sổ đã xoá ("Test", "Chung", `rp17-…`, DEMO 72/72 phạm vi sổ "ZFleet…"); "Chọn tất cả" gán luôn phạm vi rác | Phản biện: GIỮ, rộng hơn báo cáo gốc | 3 |
| N-A5-05 | Nút "Reset DEMO" trên site docs: dùng snapshot tháng 7 (DEMO hiện tại sẽ bị thay) + bí mật dùng chung nhúng trong bundle JS docs | — | 3 (Q5) |
| N-A5-06 | `/phongtrong` lọc toà theo NGƯỜI TẠO thay vì công ty ⇒ bỏ sót toà 45/3 Trần Thái Tông; payload còn trả giá/cọc của 85 phòng đã thuê | — | 3 (Q6) |
| N-A6-01 | Bảng tin lọc theo toà nhưng cảnh báo, hoạt động vẫn toàn công ty (phần "khách hẹn" trong bằng chứng là dữ liệu thử TEST) | Phản biện: GIỮ | 2 |
| N-A6-02 | "Công việc chưa xử lý" đọc bảng `issues` (0 dòng) thay vì `jobs` | — | 2 |
| N-A6-03 | Thẻ "hợp đồng mới" không lọc toà/không bỏ HĐ đã xoá | — | 2 |
| N-A6-04 | "Tổng quan đặt cọc" đếm bảng `deposits` cũ ⇒ luôn 0 | — | 2 |
| N-A6-05 | Thêm dịch vụ chọn "Không chọn" định mức ⇒ lỗi 400 (gửi chữ `"none"`) | — | 3 |
| N-A6-07 | Báo cáo Bỏ trả xếp mọi HĐ là "thanh lý sớm" (58/145 thực ra đúng/sau hạn) | — | 3 |
| N-A6-09 | Hoàn thành công việc không bắt ảnh/GPS ở máy chủ (PATCH thẳng được) | — | 1 (cùng N-A6-08) |
| N-A6-12 | Super admin không tạo được phiếu xuất vật tư (23502) | — | 0 (gộp N-A6-11) |
| N-A6-13 | Chủ công ty không đọc được hồ sơ thành viên ⇒ cột "Người tạo" trống | — | 3 |
| N-A6-14 | 598/598 thông báo hết hạn HĐ "của undefined", 475/475 nhắc nợ thiếu tên khách | — | 2 (cùng L11) |

## 5. Lỗi đã xác nhận — P3 (dọn dẹp, nhãn, mã chết, dữ liệu)

| Nhóm | ID |
|---|---|
| Nhãn/định dạng | L42 (tên báo cáo lệch), N-A1-07 (huỷ giữ chỗ không hỏi, in UUID/ISO), N-A1-UI-05 (nhãn hoá đơn thô), N-A3-07 (ngày ISO ở khung chốt sổ), N-A2-09 (tìm hoá đơn không nhận tên phòng chữ), N-A2-10 (đơn giá điện mặc định 3.500 ở hộp Điều chỉnh), N-A6-16 (`<html lang="en">`), N-A6-S06 (nhật ký Trung tâm mạng in mã thô), L45 (còn thương hiệu "iHomeCRM" ở Trung tâm mạng) |
| Nút/màn thừa | N-A1-UI-04 (nút Dạng lưới/Tìm kiếm vô tác dụng), N-A3-03 (nút Mở lại/Huỷ duyệt trên phiếu đã khoá kỳ), N-A3-06 (nút Xoá ví đã có giao dịch), N-A6-S04 (nút bị chặn trông như bấm được), N-A6-S05 (bảng tràn), N-A4-07 (trang tổng BC BĐS hiện ô không có quyền), N-A4-08 (hộp "Chào mừng" cho nhân viên chỉ xem), N-A6-10 (sửa Mô tả việc không hiện), N-A6-15 (ô chọn HĐ 280 dòng, `items` lưu chuỗi JSON) |
| Logic nhỏ | N-A2-08 (hoá đơn PAID sau làm tròn vẫn hiện "còn nợ"), N-A3-08 (phiếu thiếu/thừa quỹ gán toà tạo sớm nhất), N-A4-05 (tạo tài khoản ở /admin/users thiếu email, không có khoá/xoá), L23 (logo công ty không dùng ở đâu, lưu theo tài khoản), L40(a)(b) (số "Đã thu/Đã chi/Đã chia" theo phiếu đã duyệt) |
| Mã chết/tooling | L51 (`RenewedBadge`), L46 (lý do miễn trừ registry lỗi thời), L48 (`asset_categories` vs `asset_types`), L55 (TS `process` trong middleware docs), N-A5-02 (allowlist gate có mục "ma"), N-A5-03 (gate/pg_dump chạy thẳng production giờ cao điểm), N-A6-S07 (build TEST thiếu cờ Trung tâm mạng) |
| Dữ liệu | L59 (scope toà `rp17-…` sót ở DEMO), L60 (3 dịch vụ DEMO thiếu loại phí), L61 (demo.chunha thiếu sổ tiền mặt riêng), L63 (fixture lương `hhqlfixture` tự giữ mãi), L76 (toà "Test"/"Chung" đã xoá còn scope), N-A4-06 (3 mẫu HĐ `type` NULL không vào hộp in), quy tắc lương điều hành "LN 10%" của quản lý đã xoá (A3) |

Quan sát chưa kết luận (A1): chuyển phòng không ghi mốc chỉ số phòng mới; "Xác nhận ký" thẳng không ghi mốc nhận phòng; nhãn "(30 ngày)" ở tháng đầu trong khi tính theo ngày thật.

## 6. Không phải lỗi (có căn cứ)

| ID | Kết luận | Căn cứ |
|---|---|---|
| L03 | ĐÚNG THIẾT KẾ | `/chi-tieu` không gác ở route vì phục vụ 2 nhóm quyền; trang tự kiểm, máy chủ chặn ghi |
| L08 | ĐÚNG THIẾT KẾ | `/phongtrong` token "demo" là trang thương hiệu của chính công ty (commit 59d984c2); phần sai xem N-A5-06 |
| L09 | ĐÃ SỬA (2) + ĐÚNG THIẾT KẾ (4) | 2 hàm vá ở `20261007003604`; gate ở HEAD xanh 1527 hàm |
| L13b | ĐÚNG THIẾT KẾ | Chỉ số nhập bằng form duyệt ngay (auto-approve có chủ ý) |
| L38 | ĐÚNG THIẾT KẾ | KQKD dồn tích theo phiếu đã duyệt; lệch thực tế 0 đ |
| L43 | ĐÚNG THIẾT KẾ | Ô ngày gốc theo ngôn ngữ trình duyệt (xem N-A6-16) |
| L50 | ĐÚNG THIẾT KẾ | "Chốt số" lấy số dư hôm nay, có chú thích cố ý |
| L52 | ĐÚNG THIẾT KẾ | "Easter egg" có chú thích; đề xuất hiện theo quyền (Q9) |
| L53 | KHÔNG TÁI HIỆN | 1 người dùng 171–1.169 ms; timeout do tải tự gây (rủi ro hiệu năng tính ở P2) |
| L56 | KHÔNG TÁI HIỆN | corpus Copilot khớp 27 userDoc |
| L62 | ĐÚNG THIẾT KẾ | tài khoản hệ thống trong DEMO phục vụ E2E Copilot |
| L68 | ĐÚNG THIẾT KẾ | phiếu khoá cả khi phiên bàn giao đang chờ (chặt hơn tài liệu) |
| L69 | ĐÚNG THIẾT KẾ | ký từ nháp bắt buộc đủ chỉ số (chỉ sửa câu gợi ý "để trống") |
| L70 | ĐÚNG THIẾT KẾ | phiếu thu tiền hoá đơn APPROVED + POSTED ngay (846/846) |
| L72 | KHÔNG TÁI HIỆN | luồng thu chọn sổ đúng |
| L74 | KHÔNG TÁI HIỆN | thông báo nhắc chốt sổ có sinh |

## 7. Chưa kiểm được (làm ở đợt sau)

- A1: nhượng hợp đồng (luồng 5 bước); quyết toán hồ sơ "trả phòng, quyết toán sau"; phiếu "Trả khách thanh lý" chọn sổ → duyệt → chi (W07).
- A2: Mode Excel — Tạo nhanh; sửa nháp hoá đơn; lưu + duyệt một bản điều chỉnh; Thanh toán hàng loạt — Mode Excel.
- A3: toàn bộ Lương (W17), L40(c); "Chi lợi nhuận" (bị N-A3-01 chặn); nhóm lương điều hành TOTAL_GROUP; nhánh "Từ chối & huỷ đề nghị" chốt sổ; đo số lệch L35/L37; màn `/approvals`.
- Lý do: hết thời gian phiên (giới hạn sử dụng làm các nhóm dừng 2 lần) hoặc bị chính lỗi đã xác nhận chặn. Không có bằng chứng các luồng này hỏng.

## 8. Dữ liệu thử còn lại trên TEST

Lần `test-env:sync` sau sẽ xoá sạch; liệt kê để không nhầm là dữ liệu thật:
- A1: khách `AUDIT0710 KH-C`, `KH-D`; sổ `AUDIT0710 Quỹ A1 cọc-thanh lý`; HĐ HD-2026-00389, HD-2026-00390 (+ 2 hoá đơn chưa thu); HĐ bản sao đã đổi: HD-2026-00028 (trả phòng chờ quyết toán), HĐT-074902/02092025 (đã quyết toán), HĐT-074892/02092025 (bỏ cọc); giữ chỗ đã huỷ.
- A2: hoá đơn INV-2026-01294 (đã huỷ, 5 lần thu đã đảo), phiên bàn giao BG2610001 (đã huỷ), 2 thông báo PENDING.
- A3: sổ TK000710 ĐÃ CHỐT VĨNH VIỄN (biên bản #41, đang là sổ mặc định của 45/3 TTT); sổ TK000711; phiếu thử đã huỷ; bản chốt 65NTG T08 ở DRAFT (rev 2); ví "AUDIT0710 ví thử" (ẩn).
- A4: tài khoản `audit0710a` (bị chặn, membership REVOKED); 2 vai trò `AUDIT0710 …` (0 người); 2 lời mời đã dùng/thu hồi; mẫu MHD000011 xoá mềm.
- A6: 2 thông báo DEPOSIT_SHORTFALL gắn HĐ fixture của A1.

## 9. Tài liệu người dùng sai cần sửa (Đợt D)

Danh sách đầy đủ ở plan, mục 7 (Đợt D). Tóm tắt: **D1** — 14 nhóm trang tài liệu đang SAI so với app, sửa ngay
(trong đó câu về danh sách người nhận bàn giao ở `01-bat-dau/quy-trinh-ban-giao` là câu do chính đợt đồng bộ docs 07/10 thêm
vào và đã sai); **D2** — 9 trang mô tả đúng ý đồ nhưng app đang sai, sửa câu sau khi sửa app.
