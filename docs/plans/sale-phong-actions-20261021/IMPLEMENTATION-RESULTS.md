# Sale Phòng và Hermes — triển khai local

Phạm vi: sửa lỗi đã xác nhận, bảng cập nhật nhanh trên máy tính/điện thoại, thao tác Hermes dùng cùng writer nghiệp vụ, kiểm thử cho Chủ trọ, Quản lý, Chủ công ty, Sale Admin và Sale. Chưa push, deploy, bật capability trên production hoặc áp migration lên cơ sở dữ liệu từ xa.

## Đã thực hiện

- Bảng cập nhật nhanh là tab đầu của Sale Phòng: tìm không dấu, lọc tòa/trạng thái, thông tin hiện tại, giá/diện tích/tiện nghi/chính sách/ảnh và người cập nhật có bằng chứng.
- Cập nhật đúng trường vừa sửa; không biến giá trống thành 0. Bản nháp gắn với tài khoản/công ty, giữ khi refetch và khi có xung đột. Lần lưu dựa trên phiên bản cũ bị chặn; mất phản hồi dùng lại mã yêu cầu để đối soát, tránh ghi hai lần.
- Lock, báo cọc, pass và dọn/sửa đi qua luồng nghiệp vụ hiện có. Nút và lần gửi đều xét quyền theo tòa, tình trạng phòng mới nhất; modal đang mở bị chặn nếu mất quyền hoặc không đọc được dữ liệu.
- Ảnh có phản hồi tải/lưu, khóa thao tác chuyển khi đang bận; màn hình thông tin sale cũ giữ nháp khi dữ liệu tự làm mới và chặn lưu dựa trên bản cũ.
- Sửa lệch kỳ hạn/mục tiêu cọc giữa hồ sơ và phiếu; chặn nguồn pass khác phạm vi; không suy số thực nhận từ trạng thái duyệt hoặc mệnh giá. Hàng đợi phân biệt **thực nhận 0**, **chưa xác minh** và **một phần đã xác minh**. Thẻ chờ nhận mở được phiếu và sửa kỳ hạn theo quyền.
- Phiếu cọc được lọc đúng công ty đang chọn. Reader Hermes đã lọc công ty nên thay đổi này làm web khớp reader; chỉ cập nhật hash parity, không sửa reader của Claude.
- Hermes bổ sung 10 tool cho tìm/đọc phiên bản, cập nhật thông tin/ảnh, lock/gỡ, tạo/bổ sung/sửa/gắn khách cọc và tra yêu cầu. Kiểm lại quyền khi gửi lại hoặc sau khi chờ khóa. Chữ công khai mới yêu cầu xác nhận đúng nội dung; capability mới mặc định tắt.
- Nội dung hàng đợi gửi tự động gắn dấu kiểm của thông tin public và mẫu tin; nếu phòng/giá/ảnh/chính sách thay đổi thì chặn bản cũ trước khi gọi provider. Chính sách pass được dùng đúng khi chưa có ghi chú riêng.

## Vai trò được kiểm

| Vai trò | Nhu cầu chính | Giới hạn kiểm |
|---|---|---|
| Chủ trọ | Cập nhật phòng, giữ phòng, báo cọc, kỳ hạn, theo dõi thực nhận | Phạm vi công ty và quyền ghi sổ vẫn được kiểm |
| Quản lý | Xử lý nhanh phòng tại tòa phụ trách | Không xem/sửa tòa ngoài phạm vi |
| Chủ công ty | Nhiều tòa, chính sách, phân quyền và thu hồi quyền | Không ghi chéo công ty |
| Sale Admin | Ảnh, pass, báo cọc, điều phối thông tin | Có ca chỉ được sửa ảnh; không ghép sửa giá vào yêu cầu ảnh |
| Sale | Xem phòng, giữ tạm, báo cọc nếu được cấp quyền | Quyền xem không thành quyền sửa/ghi sổ; ẩn thông tin nội bộ khi thiếu quyền |

Đây là các cấu hình quyền dùng trong test. Sản phẩm quyết định bằng quyền thực tế theo công ty/tòa, không tự cấp quyền chỉ dựa vào tên vai trò.

## Bằng chứng

- [Danh mục yêu cầu và kết quả](ROLE-ACCEPTANCE.md), [mapping máy đọc](ROLE-ACCEPTANCE.json): mỗi mã chỉ tính một yêu cầu, tách rõ component, SQL giả lập và PostgreSQL thật.
- PostgreSQL riêng tại loopback: baseline + forward migrations của HEAD, bốn migration mới áp lại không lỗi; writer và hàm phân quyền nghiệp vụ thật. Native PostgreSQL 17.10, khác bản 17.6 mà Contract ghim.
- [R01–R25 và bốn mutation](quick-final-native.log); 25 yêu cầu và 4 mutant bị bắt, runner còn đếm 2 test cha nên báo 31.
- [Cọc native](deposit-lock-actual-pg-results.json), [ghi sổ thực nhận](deposit-native-posting-results.json): tạo cọc chưa ghi sổ = 0; Sale thiếu quyền bị từ chối; chủ có quyền và chứng từ hợp lệ ghi sổ thành công; gửi lại không tạo posting thứ hai.
- [Hermes native](hermes-local-postgres-results.json), [6 ca web/Hermes đồng thời](hermes-concurrency-postgres-results.json), [bàn giao Hermes](hermes-implementation.md).
- Rà soát chéo đã đóng các lỗi giá trống, modal giữ quyền cũ, mệnh giá bị hiển thị thành thực nhận, thẻ chờ nhận thiếu thao tác và lọc sai công ty.
- Đo SQL local với 503 phòng tổng hợp: khoảng 404 ms lượt đầu, 73–75 ms lượt sau; payload khoảng 409 KB. Đây không phải đo tải production.

Kết quả kiểm kỹ thuật và trình duyệt cuối cùng được ghi riêng trong `FINAL-VALIDATION.md` để không lẫn kết quả kiểm ban đầu với lần xác nhận bản cuối.

## Chưa xác minh và phần kế tiếp

- Chưa kiểm chuỗi đăng nhập JWT → HTTP/PostgREST → trình duyệt trên một hệ thống Supabase đầy đủ; local hiện kiểm SQL bằng claims tổng hợp và UI bằng backend giả lập riêng.
- Chưa tải lên Storage thật, gửi Zalo/provider thật, hoặc kiểm hội thoại LLM hiểu câu tự nhiên. Không tính các phần này là PASS.
- Chưa chứng minh toàn bộ production tối ưu hoặc bao phủ mọi nghiệp vụ. Cần môi trường TEST tương đương và CI đúng commit trước phát hành.
- Chưa triển khai các giai đoạn sau của kế hoạch: sửa hàng loạt có kết quả từng phòng, chương trình chính sách có cấu trúc/thời hạn, quy trình phê duyệt chuyên biệt và mở rộng link chia sẻ theo phạm vi.
- Kiểm dấu nội dung ngay trước provider vẫn có khoảng thời gian đồng thời sau kiểm; không thu hồi được tin provider đã nhận. beforeunload không thay thế cơ chế chặn mọi điều hướng SPA.
- Bộ hồ sơ audit/PLAN/TEST-RESULTS cũ phản ánh thời điểm trước triển khai; xem tài liệu này cho phạm vi hiện đã làm.

## Tách biệt với Claude và đường phát hành

Thực hiện trong worktree `../codex-worktrees/sale-phong-action-audit-20261021`, không sửa checkout/WIP của Claude. Khi gộp cần đối chiếu các hunk đăng ký action trong `broker.mjs`, `server.mjs`, catalog/capability và parity metadata với nhánh reader của Claude. Không tự động ghi đè hoặc ghép nhánh.

Bốn migration mới phải đi qua lane TEST và quy trình phát hành của repository. Migrate trước web/broker/worker sử dụng RPC mới, xác minh quyền bằng tài khoản TEST, chỉ bật các capability cần thiết sau khi nghiệm thu. Bản hiện tại được giữ local để xem và kiểm tiếp.
