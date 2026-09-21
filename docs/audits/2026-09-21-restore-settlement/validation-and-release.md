# Kiểm chứng phục hồi đồng bộ

Mốc mã ứng dụng: `beca6ee8cd0628f2a210918657bdeec09dc45997`, cùng mã ứng dụng với deployment production trước đợt Hợp đồng & quyết toán (`d3a83c6452330d281690948a9ee12de363480f50`). Dữ liệu nghiệp vụ hiện tại phải được giữ nguyên, kể cả dữ liệu tạo sau mốc này.

## Kiểm chứng trước phát hành

- Source runtime khớp mốc đích. Generated types được sinh lại từ catalog hiện hành, không sửa tay.
- 44 test liên quan, 43 test review chọn thêm, typecheck app, build, strict islands và E2E typecheck đạt. Thanh toán E2E headless đạt 7/7; desktop/mobile không có console/page error hoặc gọi reader của trang quyết toán mới.
- Đọc phiếu hoa hồng PC2609079 và hoàn khách PC2609111 qua RPC ghi chú cũ thành công; builder cũ vẫn tạo được nội dung ghi chú tương ứng. Tài khoản headless thiếu quyền menu Thu chi nên chưa xác nhận được dialog thật bằng tài khoản đó; không mở rộng quyền để thử.
- Bản sao PostgreSQL 17 của dữ liệu hiện tại: 59 lượt PostgREST, 15 nhóm kiểm tra đạt. Có tạo/duyệt/thu/chi/đảo; duyệt chưa tạo bút toán; retry cùng khóa không ghi trùng; chi đồng thời chỉ có một bút toán; sai payload cùng khóa bị từ chối; tạo hoa hồng/thưởng sale chờ duyệt; bốn vai trò đọc được phạm vi cho phép, đọc chéo tổ chức bị từ chối. Dữ liệu org THẬT của bản sao không đổi sau fixture DEMO.
- Chưa chạy ca dương tạo hoàn thanh lý/hoàn giữ chỗ qua PostgREST vì bản sao DEMO không có nguồn nghĩa vụ phù hợp. Không bỏ qua kiểm tra nguồn để tạo fixture giả hợp lệ.
- Migration bù thử hai lượt trên bản sao rỗng, có dữ liệu và principal không superuser đều đạt. Năm ca âm (definition, ACL, trigger, ACL sau phục hồi, writer đồng thời) đều bị chặn. Đột biến thêm UPDATE bị witness dữ liệu bắt; file phục hồi đúng SHA256.
- Dry-run và double replay migration trên production đã ROLLBACK thành công; các phép thử này không phải bằng chứng apply.
- Đối chiếu tiền v1: SQL/JWT/RLS/pagination cùng 5.771.739.013 đồng, 1.159 dòng. V2: 20 sổ quỹ khớp, 3.681 dòng bút toán, tổng ròng 3.162.659.559 đồng. Kiểm sandbox: 0/151 bảng đọc được bị rò TEST; 18 bảng bị từ chối SELECT.

## Kiểm tra độc lập gate lịch sử

Gate giữ nguyên 15 file SQL và receipt đã phát hành. Chỉ nhận trạng thái RETIRED khi receipt migration bù và catalog sống khớp toàn bộ 44 vị trí hàm, 5 vị trí trigger và role. Không replay tính năng đã gỡ; không cấp PASS/cache giả cho lịch sử đó. Trạng thái chưa apply vẫn kiểm theo pin cũ. Thiếu receipt, partial/drift hoặc lỗi đọc đều dừng.

Review độc lập của agent chính xác nhận compensation vẫn phải kiểm hai lượt khi mới/explicit/chưa có cache; retirement không bỏ qua kiểm compensation. 50 test gate đạt. Đột biến bỏ so hash/owner/ACL làm suite đỏ đúng AssertionError; helper khôi phục file về SHA256 `1a5b5b3e2af6…`. Migration bù giữ nguyên SHA256 `0574aba685d341fd10140afa751f79b0b09f1b0e26a4919640bbf08e8fa8ab85`.

## Trạng thái phát hành

Chưa áp dụng production tại thời điểm ghi báo cáo này. Thứ tự: draft PR/review → rollback ứng dụng về deployment cũ đã xác minh → lane backup/apply migration bù → receipt/catalog/types/gate → main CI đúng SHA → production → kiểm trình duyệt và tiền sau phục hồi. Không phục hồi dump cũ đè dữ liệu hiện tại.

Backup riêng trước phát hành đã restore thử thành công vào database cục bộ. Lane vẫn phải tạo backup mới ngay trước apply. GitHub Free chưa có branch protection là khoảng trống đã biết, không được gọi là kiểm soát đã đạt.
