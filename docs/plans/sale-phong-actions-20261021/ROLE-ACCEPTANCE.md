# 103 ca nghiệp vụ — đủ 5 vai trò

Gồm 78 yêu cầu theo vai trò trên web/Hermes và 25 ca đối chiếu quyền/dữ liệu ở PostgreSQL thật. Đã chạy trên local với dữ liệu tổng hợp. Mỗi ID tính một lần; không cộng test cha, số biến thể hay lần chạy lại. Một nghiệp vụ có thể được kiểm lại ở vai trò/kênh/tầng khác, không phải 103 quy trình hoàn toàn khác nhau. PASS chỉ có nghĩa là đạt ở tầng kiểm ghi trong bảng. Bộ này vượt yêu cầu tối thiểu 60 ca, không chứng minh bao phủ mọi nghiệp vụ hoặc production.

Vai trò là hồ sơ quyền được cấp theo công ty/tòa, không phải chỉ kiểm tên vai trò. Sale và Sale Admin đều có ca được phép, bị từ chối và bị thu hồi quyền. Mapping tới test nguồn nằm trong [JSON](ROLE-ACCEPTANCE.json).

| Mã | Vai trò | Yêu cầu nghiệp vụ | Kết quả | Tầng đã kiểm | Bằng chứng |
|---|---|---|---|---|---|
| U01 | Chủ trọ | cho tôi tìm không dấu đúng tòa và cả phòng đã thuê trên máy tính/điện thoại | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U02 | Quản lý | chỉ lưu giá/chính sách vừa sửa, giữ các trường khác và báo đúng phòng đã lưu | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U03 | Quản lý | người khác vừa sửa phòng thì giữ nháp của tôi, đối chiếu giá mới trước khi ghi | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U04 | Chủ công ty | mất phản hồi lưu phải đối chiếu đúng yêu cầu cũ, kể cả sau khi quyền thay đổi | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U05 | Quản lý | nhập giá sai phải chỉ đúng ô, giữ nháp qua đóng/mở và không lộ sang nhân viên khác | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U06 | Chủ công ty | nhân viên chỉ sửa ảnh không được sửa giá, xem thưởng nội bộ hoặc tạo cọc/lock/pass | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U07 | Sale Admin | đang tải ảnh thì không được lưu thiếu ảnh hay chuyển phòng làm mất ảnh | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U08 | Quản lý | mất kết nối đọc thì vẫn xem dữ liệu cũ có cảnh báo, khóa ghi và cho tải lại | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U09 | Sale Admin | bấm pass/lock/cọc trên dòng nào phải mở đúng phòng đó, không nhầm phòng trùng tên | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U10 | Chủ trọ | lọc phòng đang dọn sửa riêng, không gộp thành phòng trống sẵn | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U11 | Sale Admin | liệt kê phòng thiếu ảnh để tôi bổ sung, kể cả phòng đang có khách | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U12 | Quản lý | lọc các bản nháp của tôi để hoàn tất sau, không trộn với phòng chưa sửa | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U13 | Chủ công ty | chuyển tổ chức không được đem nháp hoặc lần lưu của công ty trước sang công ty mới | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U14 | Quản lý | máy chủ từ chối vì dữ liệu đã đổi thì không được bấm lưu lặp dù lần tải lại chưa về | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U15 | Sale Admin | trường hợp bị từ chối rõ ràng phải giữ nội dung cho tôi sửa và gửi yêu cầu mới | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U16 | Chủ trọ | hiện rõ giờ hết lock và chỉ cho người đủ quyền gỡ đúng lock của phòng | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U17 | Chủ công ty | phòng đã thuê không mở tạo cọc nhanh, phòng lock còn đúng quyền vẫn đi qua quy trình cọc | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U18 | Quản lý | cập nhật dọn sửa phải dùng quy trình có lịch sử và tải lại trạng thái, không tự sửa status | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U19 | Quản lý | báo trả phải mở hồ sơ đúng phòng và hợp đồng, không đoán hợp đồng từ số phòng | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U20 | Chủ trọ | danh sách thực sự rỗng phải nói chưa có phòng, còn đang tải không được báo rỗng | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U21 | Chủ công ty | phòng bị thu hồi phạm vi giữa lúc sửa không được ghi sang phòng khác | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U22 | Chủ trọ | phòng khách pass hiển thị giá pass riêng và không làm lẫn với giá niêm yết khi sửa | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U23 | Sale | tôi chỉ xem các tòa được giao, không tìm ra tòa ngoài phạm vi hay được mở sửa nội bộ | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U24 | Sale | được lock phòng không có nghĩa được thu cọc, sửa pass hoặc gỡ lock của người khác | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U25 | Sale Admin | chỉ được cấp sửa ảnh thì vẫn lưu ảnh đúng phòng, không gửi kèm giá hay thưởng sale | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U26 | Sale Admin | cập nhật ảnh phòng cũ thiếu giá không được tự điền giá 0 hoặc chuẩn hóa ghi chú ngoài ý muốn | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U27 | Chủ công ty | form Lock đang mở phải khóa ghi ngay khi dữ liệu lỗi hoặc bị thu quyền | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| U28 | Quản lý | giữ giao diện cha ở nguyên tab khi đang sửa/tải ảnh rồi mở lại chuyển tab sau khi đóng | PASS | Component/helper local với backend giả lập | [Bằng chứng](ui-acceptance-mapping.json) |
| M01 | Chủ trọ | Tôi nhận cọc, thêm cọc, sửa hạn rồi bấm lại yêu cầu cũ: các phiếu phải cùng kỳ hạn, không nhân cọc, bản sửa cũ phải bị chặn. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M02 | Quản lý | Tôi chỉ đổi hạn ký hợp đồng bằng màn hình cũ; hạn bổ sung và cọc cần đủ phải lấy từ hồ sơ đúng, không từ bản chiếu cũ. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M03 | Quản lý | Khách bổ sung tiền sau ngày hẹn; tôi sửa hạn từ phiếu mới mà vẫn giữ được mốc bổ sung đã quá hạn của hồ sơ. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M04 | Sale | Tôi được tạo cọc nhưng không được sửa cọc; hệ thống phải chặn tôi sửa kỳ hạn cả phiếu mới lẫn phiếu cũ. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M05 | Chủ trọ | Hồ sơ không nhận tiền phải giữ hạn; nếu bước lưu kỳ hạn lỗi thì không được để lại hồ sơ hoặc phiếu thu dang dở. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M06 | Sale | Tôi báo cọc chưa duyệt, không có bút toán vào quỹ: không được coi là đã thu. Phiếu duyệt, quỹ ảo hoặc bút toán đã đảo cũng chưa phải tiền thực nhận. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M07 | Chủ công ty | Số tiền thực nhận phải theo đúng quyền xem phiếu/quỹ và công ty; người ngoài, khách ẩn danh hoặc danh sách vượt giới hạn phải bị chặn. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M08 | Sale Admin | Tôi chỉ quản lý tòa A: không được lấy mã tin pass tòa B để sửa qua tòa A, và sửa tin không được chuyển sang phòng khác. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M09 | Chủ trọ | Khi tôi lock phòng, khách và kênh đăng tin phải ngừng thấy phòng đang bán; nội bộ vẫn xem được ai lock và thời hạn. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M10 | Quản lý | Chỉ cho lock 6, 12 hoặc 24 giờ khi phòng còn bán và người thao tác có quyền. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M11 | Sale | Tôi bấm lock hai lần vì mạng chậm: cùng thao tác phải trả cùng lock; lock khác bị chặn, hết hạn thì phòng xuất hiện lại. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M12 | Quản lý | Người lock được gỡ lock của mình; người khác chỉ gỡ khi có quyền tạo cọc đúng phạm vi; bấm lại không sinh thao tác khác. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M13 | Chủ công ty | Danh sách lock là đường đọc, không tự ghi; người ngoài công ty không đọc được. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M14 | Chủ trọ | Khi nhận cọc cho phòng đang lock, hồ sơ cọc và việc đóng lock phải xảy ra trong cùng giao dịch. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M15 | Quản lý | Nếu phòng đã có người thuê qua nghiệp vụ khác, không được vẫn hiển thị là phòng lock đang bán. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-sql-final.json) |
| M16 | Sale Admin | Quyền tạo cọc của tôi chỉ ở tòa A; nút và hộp tạo cọc phải mở đúng tòa A, không mặc định toàn công ty. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M17 | Sale | Tôi chỉ có quyền cọc cũ của Sale Phòng, chưa có deposits.create: không được mở luồng nhận cọc mới. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M18 | Chủ công ty | Người đã đăng xuất dù máy còn cache quyền cũng không được mở hộp tạo cọc. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M19 | Chủ công ty | Tôi thu hồi quyền tòa A trong lúc nhân viên mở hộp cọc; lần cập nhật quyền kế tiếp phải đóng quyền thao tác đó. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M20 | Chủ trọ | Khách mới báo thêm cọc nhưng phiếu chưa duyệt: cảnh báo thiếu cọc của phiếu đã thu phải còn nguyên. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M21 | Quản lý | Hai hồ sơ khác nhau cùng một phòng không được lấy tiền của hồ sơ này bù thiếu cho hồ sơ kia. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M22 | Chủ trọ | Phiếu cọc cũ chưa gắn khách/hồ sơ phải tính riêng, không đoán là cùng khách chỉ vì cùng phòng. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M23 | Chủ công ty | Tôi có hơn 400 phiếu: phải đọc đủ qua nhiều lượt, bỏ trùng ổn định và không suy phiếu thiếu dữ kiện thành đã thu. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M24 | Quản lý | Nếu lượt đọc tiền thứ hai lỗi, phải báo lỗi thay vì hiện số tổng từ phần dữ liệu tải được. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M25 | Sale Admin | Tạo giữ chỗ xong không được gọi thêm bước ghi kỳ hạn cũ làm mất thỏa thuận cọc; thưởng Sale vẫn tách riêng đúng phiếu. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| M26 | Sale | Máy chủ chưa xác nhận tiền vào quỹ thì thông báo phải nói rõ chưa xác nhận, không báo đã thu tiền. | PASS | Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile | [Bằng chứng](deposit-lock-implementation-final.json) |
| H01 | Chủ trọ | Tìm phòng 101 thuộc tòa tôi được sửa. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H02 | Sale | Cho tôi sửa phòng ở tòa ngoài phạm vi được giao. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H03 | Quản lý | Đổi giá phòng 101 thành 3.100.000 đồng theo bản vừa mở. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H04 | Quản lý | Lưu giá theo bản phòng đã cũ. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H05 | Chủ công ty | Đăng chính sách mới: Wifi miễn phí. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H06 | Chủ công ty | Tôi đồng ý nguyên văn bản chính sách vừa xem. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H07 | Sale Admin | Dùng xác nhận cũ nhưng đổi chính sách thành miễn tiền điện. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H08 | Sale Admin | Ghi thưởng sale 500.000 đồng vào ghi chú nội bộ. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H09 | Sale | Tôi chỉ được quản lý ảnh; thay ảnh phòng đã tải lên. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H10 | Sale | Tôi chỉ được quản lý ảnh; đổi thêm giá phòng. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H11 | Chủ trọ | Lock tạm phòng 101 trong 6 giờ để khách đi xem. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H12 | Sale | Lock phòng 101 trong 48 giờ. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H13 | Quản lý | Mạng lỗi lúc lock; gửi lại đúng mã yêu cầu cũ sau ba ngày. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H14 | Sale Admin | Giữ mã yêu cầu đã dùng nhưng đổi thời gian lock. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H15 | Chủ trọ | Kiểm tra mã yêu cầu này đã xử lý chưa. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H16 | Chủ công ty | Đã thu hồi quyền sửa của sale; thử tra lại biên nhận sửa cũ. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H17 | Sale Admin | Báo cọc 2 triệu cho Khách An, mục tiêu cọc 3 triệu. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H18 | Chủ công ty | Cho sale tạo cọc nhưng chưa cấp quyền duyệt qua Hermes. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H19 | Quản lý | Đổi hạn thu thêm và ghi chú cọc theo phiên bản 1. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H20 | Sale Admin | Gắn khách danh bạ vào cọc tên gợi nhớ. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H21 | Quản lý | Gỡ lock của phòng vừa giữ cho khách xem. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H22 | Sale Admin | Thu thêm 2 triệu vào cọc hiện tại. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H23 | Sale | Tôi chỉ có quyền đọc phòng; hãy sửa giá giúp tôi. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| H24 | Sale | Tôi chỉ được quản lý ảnh; xem giá và thưởng nội bộ trước khi sửa ảnh. | PASS | Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật | [Bằng chứng](hermes-acceptance-results.xml) |
| R01 | Chủ trọ | Chủ trọ xem đủ phòng trống và phòng đã thuê | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R02 | Chủ công ty | Chủ công ty xem hai tòa thuộc công ty, không thấy công ty khác | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R03 | Quản lý | Quản lý chỉ xem tòa được giao | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R04 | Sale Admin | Sale Admin chỉ thấy quyền ảnh và báo cọc theo tòa | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R05 | Sale | Sale chỉ xem và giữ tạm; không thấy thưởng nội bộ | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R06 | Chủ trọ | Chủ trọ cập nhật giá, ưu đãi, diện tích trong một lần lưu | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R07 | Quản lý | Quản lý sửa đúng tòa được giao | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R08 | Quản lý | Quản lý không sửa tòa chưa được giao | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R09 | Sale | Sale không đổi giá qua gọi trực tiếp | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R10 | Sale Admin | Sale Admin chỉ có quyền ảnh vẫn tải được ảnh | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R11 | Sale Admin | Sale Admin không ghép thay đổi giá vào lần lưu ảnh | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R12 | Chủ công ty | Chủ công ty không ghi chéo công ty | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R13 | Chủ trọ / chủ công ty | Không cho đổi trạng thái thuê qua sửa thông tin | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R14 | Chủ trọ / chủ công ty | Giá âm hoặc lẻ đồng bị từ chối | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R15 | Chủ trọ / chủ công ty | Ảnh tạm và đường dẫn vượt thư mục bị từ chối | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R16 | Chủ trọ / chủ công ty | Hai quản lý mở cùng dữ liệu: lần lưu sau không ghi đè | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R17 | Chủ trọ / chủ công ty | Mất phản hồi: gửi lại cùng yêu cầu chỉ ghi một lần | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R18 | Chủ trọ / chủ công ty | Không tái sử dụng mã yêu cầu cho nội dung khác | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R19 | Chủ trọ / chủ công ty | Thu hồi quyền có hiệu lực cả với yêu cầu đã lưu | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R20 | Chủ trọ / chủ công ty | Tài khoản chưa đăng nhập không đọc/ghi được | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R21 | Chủ trọ / chủ công ty | Hai phiên lưu đồng thời cùng phiên bản: đúng một thành công | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R22 | Chủ trọ / chủ công ty | Hai phiên gửi đồng thời cùng yêu cầu: cùng biên nhận | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R23 | Chủ trọ / chủ công ty | Không công khai biên nhận và dữ liệu trước thay đổi | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R24 | Sale | Sale bị thu hồi quyền xem không còn thấy phòng | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
| R25 | Chủ trọ / chủ công ty | Thay đổi bằng luồng khác không gán nhầm người vừa cập nhật | PASS | PostgreSQL 17.10 thật; quyền và writer canonical; claims local | [Bằng chứng](quick-final-native.log) |
