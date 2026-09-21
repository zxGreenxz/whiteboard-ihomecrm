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

PR phục hồi: https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/74. Đã rollback ứng dụng về deployment `dpl_AgeR6A28wvNV9mP4hqCP2ce6vdGM`, SHA `d3a83c6452330d281690948a9ee12de363480f50`. API trả success với body rỗng làm helper báo lỗi parse JSON; không retry mutation. Lần GET độc lập xác nhận target và build meta đã đổi đúng.

Lượt lane đầu đã tạo full backup `ihomecrm-full-2026-09-21T09-38-06-795Z.dump` (535 mục TABLE DATA), kiểm digest và double replay đạt. Trong lúc lane chạy, CI phát hiện ba assertion văn bản SQL cũ đòi lặp lại DROP/GRANT và baseline drill thiếu ACL của production. Tiến trình được dừng để xử lý; kiểm catalog sau khi dừng cho thấy transaction DDL đã kịp commit, nhưng runner chưa ghi receipt. Không suy từ việc dừng tiến trình rằng database đã rollback; không tự viết receipt giả. Cần hoàn tất lại lane idempotent nguyên SQL, backup mới, để nhận receipt thật.

Đọc production độc lập sau đó: 14/14 definition/owner/ACL khớp đích, 30/30 hàm mới vắng, role mới vắng. Generated types sinh từ production khớp hoàn toàn mốc ứng dụng cũ. Hai gate tiền sau phục hồi tiếp tục đúng các tổng nêu trên, không đổi số dòng tiền.

Headless đăng nhập DEMO trên production sau phục hồi catalog: desktop/mobile có lại Thanh toán cũ và Thu chi cũ; mở chi tiết phiếu chỉ đọc thành công. Không có console/page error, toast quá khổ hoặc RPC settlement mới. Đọc lại RPC ghi chú cho hai phiếu THẬT nêu trên vẫn đạt. Tab IAB hiện tại trắng root dù reload; trình duyệt độc lập cùng deployment hoạt động bình thường. Chưa coi IAB là đạt và không thay mã ứng dụng để che vấn đề trạng thái trình duyệt này.

Lane hoàn tất lại lúc `2026-09-21T10:01:34.686Z`, trên commit đã review `d9226791c63bcb86e2cd781b731339ee78f48724`, cùng SQL SHA256 đã pin. [Receipt thật](../../generated/schema-change-evidence/20260921085952_restore_before_contract_settlement.json) xác nhận backup mới đủ 535 mục TABLE DATA; apply 18 giây. Catalog trước/sau lượt idempotent cùng `d432e7227b14e6e3…`, đúng vì trạng thái đã phục hồi từ lượt trước. Witness dữ liệu trong transaction không phát hiện thay đổi. Không có restore dump đè production.

Gate lịch sử đọc receipt thật và catalog sống trả RETIRED đúng 15 migration; yêu cầu kiểm file lịch sử được nhận diện và không replay, không ghi PASS giả. [Catalog kiểm sau phục hồi](production-catalog-verification.json) ghi đủ 44 vị trí hàm, 5 vị trí trigger và role vắng.

Đã sửa ba assertion cũ bằng trạng thái chữ ký và quyền tích lũy, vẫn bắt cấp quyền anon hoặc tái tạo overload. 22 test và hai đột biến đạt. Review độc lập của agent chính xác nhận thay đổi chỉ trong test; runtime ứng dụng và generated types vẫn khớp mốc cũ.

Diễn tập baseline có fixture ACL cục bộ: baseline gốc cố ý `--no-acl`, nên phải tái lập quyền lịch sử đã đo trước khi replay 15 SQL immutable. Fixture pin 22 function hash/owner/ACL và đổi đúng 15 ACL, không thay body hoặc dữ liệu; chỉ cho phép database localhost. Toàn bộ 256 file: 220 sạch, 36 dừng đúng kỳ vọng, không lệch. Hai ngoại lệ cascade đã hết nguyên nhân được gỡ khỏi sổ kỳ vọng. Kiểm đầy đủ witness trước/sau, compensation hai lượt, 16 test harness và sáu ca database sai đều đạt; security drill cũng đạt. SQL phục hồi production không thay byte nào để né lỗi baseline.

Lượt Vitest cuối dùng đúng lựa chọn file của workflow CI (tách các suite Node test theo manifest): **556 file, 8.210 test đạt**. Phát hành nhánh production phải đi qua CI của đúng SHA và công cụ promote; trạng thái CI/deployment cuối được ghi tại PR #74. Không phục hồi dump cũ đè dữ liệu hiện tại.

Backup riêng trước phát hành đã restore thử thành công vào database cục bộ. Lane vẫn phải tạo backup mới ngay trước apply. GitHub Free chưa có branch protection là khoảng trống đã biết, không được gọi là kiểm soát đã đạt.
