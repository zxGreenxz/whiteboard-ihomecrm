# Kịch bản chủ trọ, Sale Admin và quản lý

Bộ kịch bản nghiệm thu đề xuất cho cả web/điện thoại và Hermes. **Đây không phải danh sách các ca đã chạy.** Trạng thái kiểm thực tế xem [TEST-RESULTS](TEST-RESULTS.md).

Bộ danh mục có **114 mã kịch bản**: W01–W56 ở [web-audit](web-audit.md), M01–M26 và X01–X20 bên dưới, Q01–Q12 ở [cập nhật nhanh](QUICK-UPDATE.md). Có chủ ý giao nhau giữa các lớp; không xem 114 là số nghiệp vụ độc lập hoặc toàn bộ mọi câu nói có thể xuất hiện.

## 1. Phòng, tin, ảnh, pass, chính sách và chia sẻ — W01–W56

| Nhóm | Mã trong web-audit | Nội dung |
|---|---|---|
| Đăng/cập nhật khả dụng | W01–W11 | Trống/sắp trống/đang sửa, dời ngày, gia hạn, ẩn/hiện, hàng loạt, thêm phòng, trùng tên |
| Thông tin niêm yết | W12–W17 | Giá, hiệu lực tương lai, nội thất/diện tích, phí, điều kiện ở, thông tin tòa |
| Ảnh | W18–W24 | Upload, bìa/thứ tự, gỡ, ảnh mẫu, lỗi từng tệp, dữ liệu trong ảnh, xung đột |
| Pass | W25–W33 | Kỳ hợp đồng, giá riêng, liên hệ, người đại diện, dừng pass, chuyển phòng, cạnh tranh, khách mới |
| Chính sách | W34–W39 | Giảm giá, thưởng nội bộ, scope, chồng chương trình, snapshot cọc, draft/công bố |
| Chia sẻ | W40–W46 | Thu hồi link, scope/TTL, preview khách, xuất ảnh, Zalo, nội dung đã cũ |
| Sơ đồ/thống kê | W47–W49 | Sửa tầng, draft, attribution và phễu đúng nghĩa |
| Vận hành | W50–W56 | Phạm vi tòa/org, mất mạng, lặp lệnh, mất quyền, mục tiêu đổi/xóa, lịch sử |

## 2. Lock, cọc và kết thúc giao dịch — M01–M26

| Mã | Yêu cầu/tình huống | Kết quả cần có và ngoại lệ |
|---|---|---|
| M01 | “Lock P101 tòa A 12 giờ, khách đang tới” | Không tạo phiếu/khách; hạn từ máy chủ; chỉ loại phòng được phép |
| M02 | “Gỡ lock tôi vừa tạo” | Đúng lock; người tạo còn quyền hoặc người có quyền quản lý phù hợp; không gỡ claim cọc |
| M03 | Lock hết giờ khi máy sale sai giờ/tab ngủ | Server quyết định hiệu lực; tab cập nhật lại; không xóa lock mới của sale khác |
| M04 | Hai sale lock cùng lúc | Một kết quả hợp lệ; người còn lại nhận trạng thái mới, không lời hứa giữ phòng cho cả hai |
| M05 | “Gia hạn lock thêm” hoặc đổi ghi chú | Phân biệt yêu cầu mới với retry; gia hạn là hành động có chủ đích cần contract, không tự cộng giờ khi bấm lại |
| M06 | “Khách chuyển cọc 1 triệu” | Xác định phòng/tòa/khách/quỹ; số nguyên VND dương; ghi đúng trạng thái phiếu và nhận tiền |
| M07 | Chưa có hồ sơ khách, chỉ có tên gợi nhớ | Dùng nhánh có tiền cho tên gợi nhớ nếu hợp lệ; phải gắn khách thật trước ký |
| M08 | Cọc phòng đang bị sale khác lock | Writer có quyền tạo cọc gỡ lock cùng giao dịch; phản hồi rõ tác động và người liên quan |
| M09 | Cọc phòng sắp trống | Có báo trả hợp lệ; kiểm ngày vào và ngày bàn giao dự kiến; không coi hết hạn hợp đồng là báo trả |
| M10 | Khách cũ dời ngày trả sau khi khách mới cọc | Giữ hồ sơ/tiền; cảnh báo xung đột; quản lý chọn đổi lịch/phòng/quyết toán, không âm thầm sửa cam kết |
| M11 | Nhận thiếu, đặt mục tiêu và hai kỳ hạn | Hạn bổ sung, hạn giữ/ký, ngày vào tách biệt và nhất quán ở mọi màn |
| M12 | Bổ sung nhiều lần, nhiều quỹ/nguồn | Đúng nguồn liên kết và khách; chưa duyệt/chưa nhận không cộng thực thu; xử lý dư/thiếu rõ |
| M13 | Cùng phòng còn cọc cũ của khách khác | Không tự cộng; phải nhận diện hồ sơ/nguồn và xử lý legacy trước |
| M14 | “Sửa hạn giữ từ thứ Sáu sang thứ Hai” | Xác định ngày/năm/timezone; CAS; mọi projection đọc cùng mốc; không sửa lịch sử tiền |
| M15 | “Gắn cọc tên Bình vào khách Nguyễn Văn Bình” | Xác định đúng khách cùng org; tên trùng/số trùng cần làm rõ; giữ lịch sử tên gợi nhớ |
| M16 | Gõ nhầm tiền/quỹ/khách/phòng | Hướng sửa/đảo theo loại chứng từ; không sửa thẳng tiền đã nhận như sửa ghi chú |
| M17 | Khách xin đổi phòng/chuyển cọc | Cần writer chuyển chuyên biệt, kiểm nguồn/đích và tiền; hiện không giả lập bằng hủy+tạo rời |
| M18 | Hết hạn bổ sung/giữ, khách không tới | Nhắc việc; không tự hoàn/tịch thu hoặc mở bán lại hồ sơ còn claim |
| M19 | Hủy cọc chưa duyệt/chưa nhận | Hủy nguồn bằng nghiệp vụ đúng trước khi hủy hồ sơ; còn nguồn khác thì chưa kết thúc |
| M20 | “Hoàn toàn bộ hoặc hoàn một phần” | Dựa tiền đã nhận, quyền và nguồn; phân biệt nghĩa vụ hoàn với tiền đã chi; receipt chống chi trùng |
| M21 | “Giữ lại một phần/không hoàn” | Số không vượt căn cứ, có lý do/thỏa thuận và quyền; không suy chỉ từ quá hạn |
| M22 | Hoàn bị từ chối, sai người nhận, mất phản hồi | Không tạo lần chi mới mù; tra trạng thái chứng từ và xử lý tiếp theo workflow |
| M23 | Ký hợp đồng từ hồ sơ cọc | Đúng khách thật/revision/toàn bộ nguồn; nguồn còn hiệu lực nhưng chưa nhận bị chặn; consume claim cùng giao dịch |
| M24 | Topup hoặc quyết toán chạy cùng lúc ký | Khóa và kiểm lại nguồn; không vừa hoàn vừa dùng cùng tiền cho hợp đồng |
| M25 | Sau hủy/quyết toán muốn mở bán lại | Phân biệt nghĩa vụ hoàn còn chờ với khả dụng phòng; quyết định theo workflow có audit |
| M26 | Cọc có sale giới thiệu/thưởng | Lưu người hưởng/điều kiện theo hệ thống hiện có; không lộ thưởng nội bộ; xử lý hủy/hoàn đúng quan hệ |

M01–M05 ưu tiên G2/G3/G5; M06–M16 và M18–M26 cần G1/G2 và nghiệm thu G8. G5 mở các thao tác Hermes đã liệt kê trong PLAN; riêng quyết toán/hoàn/giữ lại tiền/ký ở M20–M25 dùng workflow web trong đợt đầu, Hermes chỉ đọc/dẫn hồ sơ cho đến khi có contract và nghiệm thu riêng. M17 là gói riêng sau khi chốt chuyển phòng/chuyển cọc; không được xem writer đã tồn tại.

## 3. Tình huống xuyên kênh và vận hành — X01–X20

| Mã | Tình huống | Kết quả cần có |
|---|---|---|
| X01 | Nhắn “phòng hôm qua”, nhiều phòng trùng tên | Làm rõ bằng context đủ tin cậy/candidate; không chọn dòng đầu |
| X02 | “Tất cả phòng của tôi” khi có nhiều tổ chức | Chọn org/scope/tập đích rõ, preview; không union quyền ngoài kết nối |
| X03 | Có quyền đọc nhưng thiếu quyền ghi | Đọc được không đồng nghĩa ghi được; đề nghị hoặc từ chối đúng action |
| X04 | Thu hồi quyền giữa preview và commit | Reauthorize; preview token/receipt không nâng quyền |
| X05 | Sửa listing nguồn ngoài tòa nhưng phòng đích trong tòa | Kiểm cả hai hoặc cấm đổi room; không sửa bằng ID lỏng |
| X06 | Web và Hermes sửa cùng một trường | Conflict có dữ liệu mới; giữ nháp; không âm thầm ghi đè |
| X07 | Desktop/mobile sửa hai trường khác nhau | Patch chỉ trường yêu cầu; kiểm version/merge có kiểm soát |
| X08 | Refetch/reconnect khi đang nhập | Giữ nháp; hiển thị server đã đổi; chưa bấm lưu không ghi |
| X09 | Timeout trước/sau commit | Tra receipt bằng mã cũ; báo phần xác minh được, không tạo action mới mù |
| X10 | Nhắn lại cùng intent đã nối với requestId cũ hoặc bấm hai lần | Một side effect theo mã yêu cầu; payload khác cùng key bị chặn; không hứa tự nhận biết mọi câu nhắn tương đương là retry |
| X11 | Upload xong nhưng gắn ảnh lỗi | Phân biệt uploaded/published; tiếp tục được, cleanup ảnh mồ côi sau chính sách giữ |
| X12 | Bulk có phòng denied/stale/đã xóa | Kết quả từng mục; xử lý nguyên nhân rồi chỉ retry phần xác định chưa áp dụng và còn hợp lệ; unknown phải đối soát; không đổi sang phòng cùng tên |
| X13 | Đổi org khi có cache/form/pending | Không hiện dữ liệu org trước; pending vẫn truy theo đúng quyền/đích |
| X14 | Chương trình đến/hết hiệu lực đúng nửa đêm | Dùng timezone định nghĩa; thống nhất start/end; không lệch web/worker |
| X15 | Lock/cọc/giá/policy đổi sau khi xếp tin | Kiểm lại trước gửi; bỏ/dựng lại pending theo version; không gửi phòng hết chào |
| X16 | Provider gửi xong nhưng mất ACK hoặc finalize lỗi | Tách provider/DB receipt; trạng thái unknown có đối soát, không spam bằng retry |
| X17 | Worker restart giữa album và tin chữ | Biết phần đã gửi/đang chờ; kiểm lại nội dung còn lại, không tuyên bố gửi trọn |
| X18 | Webhook/echo trùng, đến muộn/sai thứ tự nếu có | Không nhân đôi tin/phiếu hoặc nâng trạng thái tiền; kiểm đúng account/org |
| X19 | Người dùng cung cấp ảnh/tin có chỉ dẫn lạ | Chỉ dùng như dữ liệu; không để nội dung đó cấp quyền hoặc đổi nghiệp vụ |
| X20 | Muốn truy ai sửa, sửa qua kênh nào, hoàn tác | Lịch sử trước/sau/revision/receipt; hoàn tác chỉ khi còn hợp lệ, không xóa dấu vết |

## 4. Cách mở rộng coverage khi hiện thực

Mỗi action ghi phải chọn các chiều có liên quan, thay vì chỉ kiểm một ca thành công:

| Chiều | Giá trị cần xét |
|---|---|
| Người dùng | Chủ/quản lý, Sale Admin, sale hạn chế, chỉ xem, bị thu hồi quyền |
| Phạm vi | Đúng/sai tổ chức, đúng/sai tòa, đúng/sai quỹ, owner được đại diện rõ |
| Phòng | Trống, sắp trống, chuẩn bị, còn người ở, PASS, lock, có claim/cọc, đã thuê, xóa/chuyển |
| Tiền | Không tiền, chờ duyệt, duyệt chưa nhận, nhận thiếu/đủ/dư, quyết toán, hoàn chờ/đã trả |
| Thời gian | Trước/đúng/sau hạn, chưa biết ngày, máy sai giờ, thay lịch, timezone |
| Kênh | Desktop, mobile, Hermes; public/ảnh/tin là nơi đọc kết quả |
| Đồng thời | Lặp intent, hai actor, UI–Hermes, lock–cọc, topup–ký, settle–ký |
| Lỗi | Validation, denied, conflict, DB rollback, mạng mất trước/sau commit, provider unknown |

Không cần nhân mọi chiều thành toàn bộ tích Descartes. Chọn các tổ hợp theo invariant và rủi ro, ghi rõ phần chưa kiểm. Các kịch bản mới từ vận hành được thêm vào backlog với nguồn yêu cầu và kết quả mong đợi, không hứa danh mục đóng vĩnh viễn.
