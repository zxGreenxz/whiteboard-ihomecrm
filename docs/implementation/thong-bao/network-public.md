# H08–H10, H16–H19 — mạng và trang công khai

Chỉ mô phỏng thao tác hạ tầng/quay số/tải giấy cọc trong các ca unit/DOM; không chạy lệnh thiết bị hay quay sự kiện thật.

| Mã | Trước | Sau | Bằng chứng và giới hạn |
|---|---|---|---|
| H08 | Raw command/request/contract errors | networkFeedback giữ lý do nghiệp vụ đã xác minh; lỗi envelope nói chưa nhận được kết quả hợp lệ, yêu cầu tải trạng thái | networkFeedback + repository/execute guard, bộ focused 66 ca |
| H09 | Chỉ lỗi cuối form | NetworkActionDialog/MaintenanceDialog/SettingsTab: lý do, thiết bị xác nhận, cổng, thời gian, chu kỳ có lỗi tại trường + focus; unknown chặn thực hiện lại | Network dialogs DOM3; chưa browser keyboard/mobile |
| H10 | Nhận yêu cầu dễ lẫn hoàn tất | BackupsTab nói tiếp nhận yêu cầu sao lưu; ConfigDiff nêu hai bản cấu hình, lỗi an toàn; IncidentRail không hiện diagnostic | networkFeedback/repository tests; không kiểm worker thật |
| H16 | Lỗi raw/success chưa xác nhận lượt quay | LuckyDrawAdminPage dùng operation cụ thể; QuaySo giữ trạng thái chưa xác nhận, đọc lại trước lượt tiếp; admin missing field đỏ/focus | LuckyDrawAdminPage.feedback 3 ca; luckyAdminFeedback15 và luckyStateReadFeedback15; QuaySoPage.feedback6 |
| H17 | Hướng dẫn6 nhưng validate6–8 | Hướng dẫn mã điểm danh6–8, lỗi inline/aria/focus | publicFeedback + QuaySoPage.feedback |
| H18 | Upload/DB partial chung, tài khoản payout raw | Giữ đường dẫn ảnh đã upload qua remount; tách tệp có biên nhận với tệp chưa xác nhận. Ghi mã object trước gửi; mất phản hồi không cho tải lại/gắn mù. Chỉ nói đã gắn giấy khi đúng event/team/path; payout giữ trường và tệp lỗi | luckyProofTransportFeedback3 RED→GREEN; luckyProofUpload2; payout DOM6 (partial, retry từng tệp đã xác định thất bại, full remount, unknown transport) |
| H19 | Mọi lỗi là mạng | publicFeedback phân biệt network/server/rate limit/expired và malformed; PublicContractInvoice validate payload tiền/ngày trước render | publicFeedback6 và publicInvoicePayload4; chưa E2E QR/public link thật |

Admin quay số giữ marker theo actor/sự kiện và lượt gốc qua reload; đọc trạng thái chung không tự xóa marker. Chỉ kết quả đúng lượt gốc và danh sách người trúng xác nhận mới mở tiếp. RPC không đổi. Anon upload chỉ có INSERT, không có đọc object: kết quả upload mất phản hồi giữ cảnh báo và cần ban tổ chức đối chiếu, không tự gắn đường dẫn chưa xác nhận.

G20/G22/I16: useMyDay phân biệt dữ liệu summary/missions/requests/phiên/count lỗi với rỗng thật; count0 hợp lệ, countnull không giả0. Lập đơn nêu đang chờ duyệt, không nói ngày công đã xác nhận. Inspection chỉ báo ngày công theo tick trả về; replay phiên đã đóng là thông tin; một thông báo tổng kèm công việc sự cố nếu có. myDayFeedbackBoundary18 (11 RED→GREEN ban đầu), MyDayRead1.

Các kết quả trên chưa chứng minh tất cả vai trò trên Preview đúng SHA. Inventory của scope nằm ở `root-feedback-decisions.json` sau lượt đọc cuối.
