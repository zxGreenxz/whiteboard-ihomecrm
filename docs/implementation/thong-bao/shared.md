# A01–A13 và F17 — nền tảng phản hồi

Bản làm việc trên nhánh `codex/thong-bao-nguoi-dung`, chưa phát hành. Các ca dưới là unit/DOM mô phỏng, không thay thế E2E Preview. Không sửa quy tắc tiền hoặc quyền.

| Mã | Trước | Sau trong mã hiện tại | Bằng chứng |
|---|---|---|---|
| A01 | Lỗi kỳ tính tiền bị đổi thành câu chung | `friendlyError` giữ code/cause; rule theo operation + nguyên nhân đã xác minh; B01/B02 trả lỗi đúng hai ngày | friendlyError.feedback; contractFeedback; useContractSubmit.focus |
| A02 | Mảng lỗi mất dòng; focus đầu hộp thoại | `formErrors` đi qua nested fields, thứ tự biểu mẫu, mở phần ẩn, tìm điều khiển nhìn thấy, scroll/focus; RHF field error giữ tại ô | formErrors 6 ca DOM; form-controls.feedback 2 ca |
| A03 | Raw lỗi quyền/Auth | Phiên hết hạn → đăng nhập; quyền → thao tác cụ thể, không đoán field từ 42501 | friendlyError và feedback suites |
| A04 | Đoán schema mới/trang cũ | Chỉ nêu lỗi hệ thống; HTTP5xx/timeout/invalid response là chưa xác nhận; giữ nguyên nguyên nhân trong log | friendlyError.feedback; ErrorBoundary.feedback |
| A05 | JSON queryKey/UUID ngoài UI | QueryProvider lấy nhãn danh sách/báo cáo; bổ sung 151 nhãn cho các key còn thiếu; nút tải lại gọi đúng query | QueryProvider.errorPolicy 19 ca |
| A06 | Lỗi tải thành empty/0; stale không đánh dấu | QueryRegion phân biệt loading/error/undefined/empty/cached stale; cached lỗi quyền không hiện; có giờ tải trước và retry | QueryRegion DOM gồm denied cache và undefined source |
| A07 | Hook và form cùng toast; mutation im lặng | MutationCache đón nhánh chưa có owner; meta handlesFeedback/silent và onError tôn trọng owner. Query inline không thêm toast. Form giữ root/field error | QueryProvider.errorPolicy; CategoryCrudPage.feedback |
| A08 | Raw storage/R2, thất bại mất tệp | AttachmentUpload giữ File theo từng dòng, nguyên nhân an toàn và thử lại đúng tệp; CollectPayForm dừng trước ghi tiền nếu upload chứng từ lỗi | AttachmentUpload 6 ca; CollectDrawer.receiving |
| A09 | Nhiều toast, khó biết tệp nào lỗi | Một kết quả tổng cho lượt upload; danh sách các tệp lỗi giữ lại | AttachmentUpload |
| A10 | Xóa storage lỗi vẫn gỡ danh sách | Chỉ gỡ tệp đã lưu sau delete xác nhận; tệp chưa lưu có hành động gỡ riêng | AttachmentUpload |
| A11 | Kích hoạt tải trình duyệt đã báo tải xong; export lỗi bị nuốt | ExportButtons/ExportExcelDialog nói đã chuẩn bị tên tệp/số dòng; empty là thông tin; lỗi query preserve cause, giới hạn dòng có hướng lọc; không đóng lúc đang xuất | ExportButtons.feedback 2 ca; exportReadFeedback 3 ca + fetchAll property9 |
| A12 | Clipboard chưa hoàn tất đã báo success | `copyTextWithFeedback` await clipboard; khi lỗi mở nội dung chọn/copy thủ công; các caller được chuyển theo từng scope | clipboardFeedback 2 ca; caller DOM4 |
| A13 | Boundary thiếu tên trang/raw dev stack | Tên trang + tải lại/về trước; chunk lỗi không tự nói có bản mới; kỹ thuật ở log | ErrorBoundary.feedback 2 ca |
| F17 | CategoryCrud đóng form trước mutation xong | Promise CRUD, giữ draft, lỗi required/server tại ô, floor unique verified focus số tầng; lỗi delete giữ hộp thoại. Floors/Hotlines/Warehouses/AutoDebt validate response ID, list null không thành empty | CategoryCrudPage.feedback 3 ca; categoryResponseFeedback 9 ca đỏ→xanh |

## Còn phải nghiệm thu

- Lượt inventory đã đối chiếu từng caller; trạng thái và bằng chứng tại `feedback-decisions.json` và `plan-status.json`. Kiểm nguồn không thay thế E2E mọi nhánh.
- E2E desktop/mobile: combobox, date, tháng, tiền, tệp, tab thu gọn, dòng ngoài viewport.
- Clipboard thật và tải nhiều file thật; strict upload/permission lỗi server trên TEST/DEMO.
- Các màn có error card riêng được ghi theo caller trong inventory; phần E2E chưa chạy riêng vẫn là giới hạn kiểm chứng.


## A01/A07/A13 và bootstrap sau source freeze 30/09/2026

notifyActionError được tách sang asyncActionFeedback cho Auth/notifications và MutationCache: converter chỉ tải ở lỗi, giữ cùng title/description/options; safe fallback giữ input/đối chiếu trạng thái, financial unknown không khuyên gửi thêm giao dịch. Cause đi diagnostic; sink lỗi thử fallback đúng một lần với cùng Sonner ID và không unhandled. QueryProvider tải nhãn query khi lỗi, fallback không lộ key/UUID; một owner và retry đọc/mutation giữ nguyên. TamTru giữ mã lỗi ở extension và chỉ acknowledge IDs có receipt; leaf keys và guard trước writer không đổi.

A13 giữ41 route/label, custom/explicit/empty pageName và chunk reload budget; chỉ import tên trang sau bắt lỗi, pending/import failure dùng đang mở. AdminOnlyRoute tải chi tiết QueryRegion ở read failure, alert/Tải lại vẫn hiện khi chờ; error không thành denied/redirect hoặc cho cached admin mở trang. asyncFormErrors giữ auth validators/handlers/markup, tải helper ở lỗi và fallback focus input hiện/khả dụng; không tạo call AST giả cho diagnostic reportBoundaryError.

Proof nguồn hiện hành: asyncActionFeedback7; regression Auth/notifications83/83; bootstrap independent239/239; A13 independent101/101; residence20/20; async focus owner33/33 và independent33/33. focused-evidence.json ghi từng lượt/file, không cộng suite chồng nhau. Final inventory1303file/1866call,0pending/0stale master sau review từng16newcall/thay12oldID. Đây là unit/DOM/probe/source, chưa E2E mọi nhánh hoặc SHA phát hành. Bundle20:19 còn249866byte>247384.2, gate đỏ; phải giữ main read/deadline/media/camera khi rebase và kiểm gates cuối.


Bổ sung leaf validation tạm trú sau freeze20:25: RegistrationError class và maHoSoHopLe giữ nguyên, residenceRegistrations import/re-export cùng API; listener vẫn đăng ký ngay và await import writer trước cùng ghiHoSoTamTru/payload/guard/ack. Đã đọc3 file nguồn và leaf, không có call AST mới; focused residence-validation-import-final.json20/20 trên3 suite src. Snapshot1303file/1866call/0pending/0stale master, source hash ghi trong feedback-inventory.json và ignored reconciliation-proof.json. Build/gate sau leaf này do root kiểm, không suy đã xanh từ20 test.
