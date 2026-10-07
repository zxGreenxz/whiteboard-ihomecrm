# Lịch sử lưu trú của khách hàng

Thiết kế đã được người dùng chỉnh và chốt trong hội thoại ngày 07/10/2026: dùng chính cột **Căn hộ đang ở**, không thêm cột ngày rời đi.

- Khách đang ở: hiển thị tòa/phòng. Khách đã rời: hiển thị **Đã rời · dd/MM/yyyy**; thiếu bằng chứng ngày thực tế: **Đã rời · Chưa rõ ngày**. Khách chưa từng ở: **Chưa có lưu trú**. Bấm ô mở lịch sử, kể cả khách đang ở.
- Lịch sử có ngày hiệu lực, tòa/phòng, hợp đồng, loại sự kiện, lý do/ghi chú và người thực hiện nếu được lưu. Bao gồm ký hợp đồng/nhận phòng, được thêm vào hợp đồng, chuyển phòng, gia hạn, trả phòng hết hạn, trả sớm, bỏ cọc, bị gỡ khỏi hợp đồng, xóa hợp đồng. Khách quay lại vẫn xem được các lần trước.
- Ngày hết hạn hoặc ngày dự kiến trả không được coi là ngày rời thực tế. Nếu còn bất kỳ lần lưu trú hiện tại nào thì không kết luận đã rời. Không suy rằng mất quyền xem một phòng nghĩa là khách đã rời phòng.
- Lưu bền vững biến động ở phía database; xóa liên kết khách/phòng không xóa lịch sử. Sửa tên, ghi chú, người đại diện hoặc lưu lại danh sách không tạo biến động ra/vào giả. Thêm/gỡ khách phải nguyên tử và có kiểm quyền/phạm vi tổ chức, phòng; giữ khách không đổi và chặn ghi đè đồng thời.
- Tận dụng bằng chứng lịch sử hiện có (snapshot ký/ra phòng, thanh lý, chuyển phòng); không gán mốc đầu hợp đồng cho khách được thêm muộn. Dữ liệu cũ không đầy đủ phải có nhãn, không tự bịa sự kiện/ngày/lý do/người thực hiện. Một lần triển khai không thể phục hồi dữ liệu đã mất không có bằng chứng.
- Danh sách chỉ tải tóm tắt theo lô khách trên trang. Chi tiết tải khi mở, phân trang đầy đủ và có loading/error/retry riêng. Không trả rỗng khi lỗi đọc. Giữ quyền xem org/tòa ở phía server.
- Giữ giao diện hiện có, nút có thể dùng bàn phím, xử lý trên desktop và phần thông tin phòng tương ứng của mobile.

Kiểm chứng: SQL hành vi trên database dùng một lần, idempotency migration, ngăn sửa/xóa lịch sử, org/tòa và quyền, các sự kiện vào/ra, sửa thông tin không phát sinh lịch sử giả; hook/parse và UI cho đang ở/đã rời/không rõ ngày/lỗi; kiểm giao diện bằng browser với fixture nếu có. Schema thật chỉ phát hành qua forward lane khi có đủ bằng chứng; thay đổi migration qua draft PR.
