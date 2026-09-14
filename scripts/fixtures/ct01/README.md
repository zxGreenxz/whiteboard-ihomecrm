# Mẫu CT01 và hợp đồng thuê

Hai file Word trống được giữ làm nguồn tái tạo cho `scripts/build-ct01-template.py`.
CT01 được chuyển từ file `.doc` người dùng cung cấp bằng Word; hợp đồng lấy từ file đính kèm có ghi chú vị trí điền.

Chạy script bằng Python thuộc bộ công cụ documents (có lxml), từ bất kỳ thư mục nào. Đầu ra là `public/templates/ct01.docx`. Mọi cỡ chữ của mẫu được giữ nguyên; theo yêu cầu bổ sung, font hợp đồng chuyển từ Cambria sang Times New Roman.

CT01 giữ khổ A4, bảng số định danh, bảng thành viên và bốn cột ký. Hợp đồng giữ khổ Letter, danh sách và cỡ chữ 11pt/12pt/14pt của bản gốc, bắt đầu bằng section mới. Chỉ xóa dòng chấm tiếp địa chỉ đã được thay bằng nội dung tự xuống dòng và các đoạn trống dư ở ô ký; không thu nhỏ chữ. Ngày ký không kèm địa danh vì không có dữ liệu này. Header của hợp đồng được tách khỏi CT01.

Ngày tải tính theo giờ Việt Nam. Cả hai văn bản dùng cùng lựa chọn 12/24 tháng. Các ô chữ ký và thành viên gia đình không tự điền. Không còn các ghi chú hướng dẫn điền trong file xuất.

Sau khi sửa script/mẫu cần chạy `ct01Document.test.ts`, browser `ct01-download.spec.ts`, xuất mẫu có dữ liệu bằng Word/LibreOffice và xem toàn bộ các trang. Kiểm tra CT01 ở trang 1, hợp đồng bắt đầu trang 2, không cắt chữ hoặc đổi cỡ chữ để vừa trang.
