# Bộ câu chuẩn đo tốc độ Hermes (A-min §10, 20/10/2026)

Chỉ dùng cho replay, CLI oneshot trên profile thử và chat thử có kiểm soát; **không gửi hàng loạt tin thật, không tạo dữ liệu trong công ty thật**. Câu đọc có thể chạy trên profile production vì chỉ đọc theo quyền của kết nối; câu ghi/gửi chỉ chạy trên TEST hoặc chỉ tới bước xem trước. Nhãn do người lập đặt độc lập với model; khi đo, công bố n, phiên mới/ấm, model/effort, phiên bản connector.

| # | Nhóm | Câu (tiếng Việt) | Kỳ vọng tối thiểu |
|---|---|---|---|
| 1 | đọc rõ | Đọc giúp tôi tối đa 1 khách hàng trong CRM, tóm tắt một dòng, không nêu số điện thoại. | gọi `crm_read_customers`, 1 bản ghi |
| 2 | đọc rõ | Đọc tối đa 1 hợp đồng, tóm tắt một dòng, không nêu tên người. | `crm_read_contracts` |
| 3 | đọc rõ | Đọc tối đa 1 hoá đơn gần nhất, tóm tắt một dòng. | `crm_read_invoices` |
| 4 | đọc rõ | Tòa nào đang có phòng trống? Liệt kê tối đa 5 phòng. | `crm_available_rooms` |
| 5 | đọc rõ | Còn bao nhiêu phòng trống toàn công ty? Chỉ cần con số. | tổng từ RPC, không đếm trang |
| 6 | đọc rõ | Có việc nào đang chờ tôi duyệt không? | `crm_read_pending_approvals` |
| 7 | đọc rõ | Thống kê hoá đơn tháng này: tổng phải thu, đã thu, còn nợ. | `crm_read_invoice_report` |
| 8 | đọc rõ | Danh sách hợp đồng sắp hết hạn trong 30 ngày, tối đa 5. | `crm_read_contracts` có lọc |
| 9 | đọc rõ | Công nợ phải thu hiện tại, tối đa 5 dòng. | `crm_read_receivables` |
| 10 | đọc rõ | Tỉ lệ lấp đầy hiện tại là bao nhiêu? | `crm_read_occupancy` |
| 11 | đọc rõ | Tôi có bao nhiêu việc đang theo dõi? | `crm_task_follow_list` |
| 12 | đọc rõ | Tháng trước lãi lỗ thế nào, một dòng. | `crm_read_monthly_pnl`, tháng do code tính |
| 13 | đọc rõ | Tài sản gần đây nhất được thêm là gì? | `crm_read_assets` |
| 14 | đọc rõ | Có khoản chi nào trong 7 ngày qua không, tối đa 3 dòng. | `crm_read_income_expenses` có ngày |
| 15 | đọc rõ | Kết nối CRM của tôi đang có những quyền gì? | `crm_auth_context` |
| 16 | hiểu tham số | tim khach ten nguyen (không dấu) | chuẩn hoá hoặc hỏi lại một câu |
| 17 | hiểu tham số | Phòng trống ở tòa có tên gần giống "Nha A" | tòa trùng/gần giống → làm rõ |
| 18 | hiểu tham số | Hoá đơn kỳ tháng trước còn nợ, tối đa 3. | "tháng trước" do code tính |
| 19 | hiểu tham số | Hợp đồng của phòng 201 là gì? | `crm_read_contract_search` hoặc hỏi tòa |
| 20 | hiểu tham số | Khách tên có chữ "Trân" đang ở phòng nào? | khách → HĐ hiệu lực; trống = "không thấy HĐ đang hiệu lực trong phạm vi được xem" |
| 21 | hiểu tham số | Doanh thu tháng 9 bao nhiêu? | báo cáo theo tháng cụ thể |
| 22 | hiểu tham số | Phòng nào sắp trống trong 14 ngày tới? | `crm_available_rooms`/occupancy_upcoming |
| 23 | hiểu tham số | Có hoá đơn nào quá hạn trên 10 ngày không? | lọc theo ngày |
| 24 | nối tiếp | (sau #4) Phòng thứ hai giá bao nhiêu? | tham chiếu đúng phòng #2 vừa liệt kê |
| 25 | nối tiếp | (sau #1) Khách đó có hợp đồng nào không? | `crm_read_customer_detail` đúng id |
| 26 | nối tiếp | (sau #7) Còn tháng trước thì sao? | đổi tháng, giữ loại báo cáo |
| 27 | mơ hồ | Tình hình thế nào? | hỏi lại ngắn, không gọi bừa |
| 28 | mơ hồ | Cho tôi xem phòng. | hỏi tòa hoặc liệt kê trang đầu có ghi rõ là trang đầu |
| 29 | mơ hồ | Kiểm tra giúp cái hợp đồng hôm qua. | hỏi lại tham chiếu |
| 30 | phủ định | Phòng nào KHÔNG trống ở tòa A? | không nhầm với phòng trống |
| 31 | lập lịch (xem trước) | Soạn bản tin phòng trống gửi nhóm Web nội bộ, chỉ xem trước, chưa gửi. | `crm_group_room_preview`, không gửi |
| 32 | lập lịch (xem trước) | Lịch gửi bản tin hiện có là gì? | `crm_room_schedule_list` |
| 33 | lập lịch (TEST) | Đặt lịch gửi phòng trống 8:30 sáng mai cho nhóm Web nội bộ. | chỉ TEST; `crm_room_schedule_create` với giờ do code tính |
| 34 | ghi (TEST) | Tạo việc "kiểm tra điện phòng 101" cho tôi, hạn ngày mai. | chỉ TEST; `crm_task_create` + requestId |
| 35 | ghi (TEST) | Ghi chi 200.000 tiền sửa ống nước tòa A hôm nay. | chỉ TEST; xem trước/xác nhận theo quy tắc hiện có |
| 36 | chat | Bot có nhận được tin này không? Trả lời một câu. | không gọi tool |
| 37 | chat | Hôm nay ngày mấy? | trả lời từ prompt, **không** chạy terminal |
| 38 | chat | 1.250.000 chia 3 bằng bao nhiêu? | không bắt buộc tool; nếu dùng `execute_code` cũng chấp nhận |
| 39 | ngoài CRM | Tóm tắt giúp tôi 3 ý về cách giữ khách thuê lâu dài. | không gọi CRM |
| 40 | ngoài CRM | Giá vàng hôm nay bao nhiêu? | dùng web nếu bật, không chạy CRM |

Cách đo (CLI oneshot trên VPS, trace SQLite chỉ đọc): số lượt model, số và tên tool, thời gian từ lượt model đầu đến câu trả lời cuối (bỏ khởi động CLI), thời gian tool CRM; ghi `source` riêng cho từng đợt để lọc. Không ghi nội dung câu trả lời vào receipt công khai.
