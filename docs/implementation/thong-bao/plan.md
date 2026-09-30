# Triển khai thông báo người dùng — kế hoạch đã duyệt

Nguồn yêu cầu: kế hoạch A–I được người dùng duyệt trong chat ngày 30/09/2026. Phạm vi gồm toàn bộ 187 nhóm; mỗi nhóm cần bằng chứng riêng. Không coi đổi chuỗi hoặc test cũ xanh là hoàn tất.

## Ràng buộc

- Không đổi quy tắc tiền, quyền, giới hạn nghiệp vụ. Không sửa migration cũ.
- Phản hồi: thành công / chờ duyệt / không thay đổi / hoàn tất một phần / thất bại / chưa xác nhận kết quả. Dựa kết quả máy chủ; timeout giao dịch không khuyên tạo lại.
- Form: inline đỏ + aria-invalid, focus lỗi đầu theo thứ tự kể cả tab ẩn; ref thực cho chọn/ngày/tiền/tệp; giữ draft, chỉ đóng khi thành công.
- Ánh xạ lỗi theo thao tác + nguyên nhân đã xác minh, không theo SQLSTATE đơn lẻ để đoán field; không lộ SQL/JSON/tên hàm.
- Partial: giữ ID và phần đã ghi, không chạy lại toàn bộ. Chặn retry nguy hiểm sau lỗi nhiều bước.
- Query: phân biệt tải đầu lỗi, dữ liệu cũ không cập nhật, thiếu nguồn, rỗng thật; quyền chặn dữ liệu; nhãn dễ hiểu + tải lại.
- Một chủ sở hữu thông báo mỗi mutation. Tác vụ nền có chủ ý không thành toast lỗi.
- E2E chỉ TEST/DEMO; Zalo/email/push/hạ tầng dùng mock, không gửi người thật.
- Typecheck/build/bundle/gates và review độc lập; draft PR trước tích hợp; không promote khi thiếu bằng chứng.

## Danh mục

### Nhóm A

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| A01 | Bộ chuyển đổi lỗi nghiệp vụ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A02 | Thiếu/sai/trùng dữ liệu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A03 | Quyền và phiên đăng nhập | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A04 | Lỗi hệ thống không đoán nguyên nhân | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A05 | Lỗi truy vấn dùng nhãn dễ hiểu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A06 | Giữ dữ liệu cũ có cảnh báo; quyền khóa dữ liệu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A07 | Một nơi phát kết quả; lỗi form bền vững | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A08 | Tải tệp: lỗi từng tệp | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A09 | Tải nhiều tệp: kết quả tổng và thử lại riêng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A10 | Gỡ khỏi form khác xóa tệp | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A11 | Xuất/tải: đã chuẩn bị tệp, không khẳng định đã lưu máy | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A12 | Clipboard chờ hoàn tất, có fallback | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| A13 | ErrorBoundary có tên trang | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm B

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| B01 | Kỳ đầu: ngày bắt đầu >= ngày bắt đầu hợp đồng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B02 | Kỳ đầu: ngày cuối <= ngày kết thúc hợp đồng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B03 | Ref/focus ngày/phòng theo thứ tự | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B04 | Khách hàng thiếu đỏ/focus nút chọn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B05 | Phòng có hợp đồng/đang xử lý | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B06 | Khách trùng/người đại diện | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B07 | Giá thuê/cọc/dịch vụ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B08 | Mẫu không hợp lệ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B09 | Phiếu cọc cũ/trùng/đã dùng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B10 | Cọc nhận vượt hợp đồng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B11 | Cách xử lý nợ cọc/lý do/ngày hẹn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B12 | Dòng cọc hóa đơn đầu lệch | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B13 | Dòng/ngày hóa đơn đầu không lộ loại nội bộ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B14 | CRUD hợp đồng có mã/phòng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B15 | Hợp đồng lưu một phần khách/dịch vụ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B16 | Gia hạn/chuyển phòng/nhượng/hẹn đi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B17 | Thanh lý không suy ra đã hoàn tiền | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B18 | Thanh lý thiếu nguồn công nợ/tiền dư | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B19 | Lý do quyết toán đúng ô | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B20 | In/QR/clipboard hợp đồng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| B21 | Nhập hợp đồng: partial liên kết và ID | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm C

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| C01 | Tạo phiếu: trạng thái thật chờ duyệt/ghi sổ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C02 | Tạo/sửa: mọi exception có phản hồi giữ draft | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C03 | Tên ô Tòa nhà/Sổ quỹ/ngày và focus | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C04 | Lỗi items từng dòng/cột | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C05 | Lặp hữu hạn số nguyên 1–240 | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C06 | Duyệt chưa thu/chi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C07 | Ghi sổ không posting | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C08 | Duyệt và ghi sổ không atomic | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C09 | Duyệt nhiều bước dựa state | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C10 | Từ chối/thu hồi không đoán về nháp | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C11 | Thiếu lý do đỏ/focus | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C12 | Phiếu thay đổi giữ draft/tải lại | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C13 | Bỏ duyệt không canonical | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C14 | Hoàn tác đúng thu/chi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C15 | Hủy đúng kết quả không suy ra chiều số dư | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C16 | Hủy rồi cập nhật payment lỗi: partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C17 | Hủy lại no-op | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C18 | Khôi phục đúng trạng thái | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C19 | Đánh dấu/bỏ đã kiểm | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C20 | Ghi chú/chứng từ/KQKD/no-op | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C21 | Phiếu định kỳ số lượng/no-op | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C22 | Nhập Excel partial từng dòng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C23 | Phiếu tổng tạo dở giữ IDs chặn tạo lại | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C24 | Hủy/đổi sổ batch một tổng kết | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C25 | Intent/finalize chứng từ không lộ thuật ngữ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C26 | Thiếu chứng từ đỏ focus upload | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C27 | Lỗi kiểm chứng từ/quyền sổ không empty | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| C28 | Metadata nội bộ không yêu cầu user sửa | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm D

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| D01 | Tạo/sửa hóa đơn có mã/phòng/kỳ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D02 | Trùng hóa đơn kỳ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D03 | Duyệt/bỏ/hủy/khôi phục hóa đơn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D04 | Ghi chỉ số từ hóa đơn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D05 | Thu một hóa đơn số tiền/nợ đã xác nhận | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D06 | Tiền/sổ nhận/sổ thối lỗi từng dòng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D07 | Giữ dư cần hợp đồng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D08 | Không kiểm tra được thu gần đây: chặn gửi lại mù | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D09 | Thu hàng loạt partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D10 | Tạo hàng loạt/Excel partial chỉ số | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D11 | Hoàn hóa đơn theo trạng thái thật | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D12 | CRUD cọc | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D13 | Cọc đã tạo nhưng kỳ hạn/thưởng lỗi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D14 | Xử lý/hoàn cọc lỗi từng trường | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D15 | Tải sổ hoàn cọc lỗi khác không có sổ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D16 | Kỳ hạn giữ chỗ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| D17 | Hoa hồng/thưởng/chi tặng partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm E

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| E01 | CRUD sổ quỹ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E02 | Cấu hình sổ nhận/hình thức thu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E03 | Gửi/xác nhận/hủy chốt sổ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E04 | Chốt sổ ngày dễ đọc | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E05 | Bàn giao/đối soát | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E06 | Điều chỉnh lương/thưởng/trừ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E07 | Chốt/mở bảng lương kiểm từng bước | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E08 | Chi lương batch giữ form partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E09 | Cấu hình lương/ngày lễ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E10 | Tác vụ lương/ngày công không jargon | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E11 | Duyệt/từ chối nghỉ phép | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E12 | Điều hành/quy tắc lương partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E13 | Cổ đông/tỷ lệ/tài khoản | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E14 | Chốt/lại/mở lợi nhuận đủ nguồn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E15 | Chia lợi nhuận/chi lương field validation | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E16 | Điện/nước/phí: chờ duyệt không báo đã chi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E17 | Đồng hồ/ảnh/phí | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E18 | Dự kiến/bật áp dụng rollback toggle | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E19 | Sinh phí batch no-op/partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E20 | Giá/công bố/quy tắc duyệt | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E21 | Ví cá nhân | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E22 | Chuẩn kế toán/no-op | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| E23 | Loại/mẫu thu chi partial mặc định | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm F

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| F01 | Khách hẹn/hoạt động | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F02 | Khách hẹn chuyển cọc partial giữ ID | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F03 | Khách hàng trùng phone/CCCD | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F04 | Khách và phương tiện partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F05 | Import khách/ảnh partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F06 | Phương tiện | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F07 | Khu vực/gán tòa partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F08 | Tòa mã trùng/one toast | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F09 | Tòa/chủ/dịch vụ partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F10 | Phòng/batch | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F11 | Dịch vụ áp dụng tòa partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F12 | Định mức/bậc giá partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F13 | Công tơ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F14 | Chỉ số lỗi từng dòng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F15 | Import chỉ số malformed unknown | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F16 | Tài sản/bàn giao/di chuyển/bảo trì | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F17 | Kho/tầng/hotline/gạch nợ chờ mutation | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F18 | Vật tư/danh mục | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F19 | Phiếu vật tư không lọc bỏ dòng dở | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F20 | Phiếu vật tư header/lines partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F21 | Pháp lý/CT01/cư trú | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F22 | Mã cư trú không đóng sớm | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| F23 | Ảnh hồ sơ/công tơ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm G

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| G01 | Đăng nhập thiếu/sai thông tin focus | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G02 | Quên/đặt/đổi mật khẩu giữ riêng tư | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G03 | Đăng xuất theo phiên cục bộ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G04 | Lời mời trạng thái rõ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G05 | Hồ sơ/ảnh đại diện partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G06 | Tạo tài khoản email/password fields | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G07 | Tổ chức/vai trò/thành viên | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G08 | Phạm vi vai trò/ngoại lệ tab/dòng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G09 | Cài đặt theo tên; toggle rollback | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G10 | Logo URL bền vững chờ lưu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G11 | Gói cước theo tên | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G12 | Mẫu tài liệu | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G13 | Tệp mẫu .docx <=5MB focus nút | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G14 | Chữ ký chưa có chức năng disable | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G15 | CRUD/trạng thái công việc | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G16 | Công việc nhanh lỗi danh mục không sai mã | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G17 | Công việc+vật tư partial giữ ID | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G18 | Hoàn việc+ảnh/thưởng/công partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G19 | Loại/nhóm công việc | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G20 | Nghỉ chờ duyệt không nói đã nghỉ; tải công lỗi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G21 | Tuyến làm việc giữ thứ tự | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G22 | Kiểm tra tòa/ảnh/sự cố | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G23 | CRUD/đọc thông báo | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G24 | Tùy chọn thông báo tải lỗi không mặc định thật | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G25 | Push/gửi thử partial không HTTP/body | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| G26 | Chuông reconnect trạng thái nhỏ | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |

### Nhóm H

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| H01 | Zalo batch đã xếp hàng khác đã gửi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H02 | Tin/ảnh/tệp/sticker/cảm xúc | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H03 | Thu hồi/tải lịch sử đúng trạng thái | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H04 | Kết nối/ngắt Zalo | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H05 | Tự động/lịch/dừng gửi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H06 | Liên kết hồ sơ/mẫu/tìm phone | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H07 | Gửi nhiều/gửi mới fields | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H08 | Network payload không hợp lệ: unknown | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H09 | Network xác nhận/bảo trì/cài đặt fields | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H10 | Sao lưu/so sánh/sự cố: tiếp nhận khác hoàn tất | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H11 | Copilot tool errors safe | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H12 | Copilot thực hiện phiếu unknown step | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H13 | Copilot lịch sử/ghi nhớ/ảnh partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H14 | Copilot config/quyền/provider fields | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H15 | PIN/xác nhận fields | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H16 | Quay số sự kiện/đội/lượt unknown | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H17 | Mã điểm danh 6–8 số | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H18 | Giấy cọc/tài khoản thưởng partial | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H19 | Public quay số/hóa đơn tải lỗi phân loại | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| H20 | Voice lab lỗi từng bước | [Không còn dùng trên main (H20)](plan-status.json) |

### Nhóm I

| Mã | Tiêu chí / phạm vi | Trạng thái |
|---|---|---|
| I01 | Dashboard từng khối | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I02 | Danh sách khách hẹn/khu/tòa/phòng/khách/xe | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I03 | Chi tiết tòa/phòng/khách từng tab | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I04 | Dịch vụ/công tơ/chỉ số/tài sản/vật tư | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I05 | Phiếu danh sách/đợt/hạng mục/tổng | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I06 | Hóa đơn/cọc desktop/mobile | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I07 | In phiếu/lịch sử tiền thối | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I08 | Lương/ví/lợi nhuận đủ nguồn | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I09 | Báo cáo lịch thu/dư/cọc/sổ/dòng tiền/bàn giao | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I10 | Phân tích tài chính từng khối | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I11 | BĐS reports đủ nguồn trước tính/xuất | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I12 | Lấp đầy/cư trú bỏ jargon | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I13 | Tài khoản/cài đặt/danh mục không ghi mặc định | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I14 | Danh mục trong form tải lỗi | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I15 | Duyệt/thông báo/chuông số chưa biết | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
| I16 | Ngày công/ảnh/sự kiện | [Đã đối chiếu nguồn/kiểm thử phạm vi; xem bằng chứng](plan-status.json) |
