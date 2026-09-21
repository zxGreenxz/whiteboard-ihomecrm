# Kế hoạch khôi phục đồng bộ trước Hợp đồng & quyết toán

Ngày 21/09/2026. Người dùng đã yêu cầu thi hành: đưa toàn bộ chương trình về trước đợt sửa; giữ nguyên dữ liệu nghiệp vụ đang có, kể cả các phiếu mới.

## Đích phục hồi

- Mã ứng dụng: beca6ee8cd0628f2a210918657bdeec09dc45997. Cùng mã ứng dụng với production trước sự cố, d3a83c6452330d281690948a9ee12de363480f50.
- Deployment cũ đã xác minh: dpl_AgeR6A28wvNV9mP4hqCP2ce6vdGM.
- Thu chi, Thanh toán, ghi chú hoa hồng và bảng hoàn khách trở lại cách hoạt động ở mốc trên.
- Phục hồi 14 hàm đã sửa, gỡ 30 hàm mới và 3 trigger mới, hoàn lại quyền/owner bị thay đổi, gỡ role ie_action_snapshot_reader.
- Giữ hai trigger bảo vệ phiếu cũ; chỉ trả hàm xử lý của chúng về định nghĩa cũ.
- Không thay bảng/cột/enum: 15 migration của tính năng không thêm hoặc bớt những thành phần này.
- Không cập nhật/xóa phiếu, hợp đồng, bút toán, công nợ, ghi chú hoặc quyền được gán cho nhân viên. Không dùng bản sao lưu cũ đè dữ liệu hiện tại.
- Giữ lịch sử 15 migration và biên nhận; khôi phục bằng một migration bù mới. Giữ bản thiết kế để xem lại sau.

Nhánh tự duyệt hoa hồng môi giới đã có trước đợt sửa và thuộc hành vi cũ cần phục hồi. Loại bỏ nhánh này là thay đổi nghiệp vụ khác, không thuộc lần khôi phục này.

## Bằng chứng và giới hạn

Danh sách 14 hàm, hash trước/sau, metadata quyền và kết quả thử nằm trong [evidence.json](../../audits/2026-09-21-restore-settlement/evidence.json) và [pre-feature-metadata.json](../../audits/2026-09-21-restore-settlement/pre-feature-metadata.json).

Cả 14 định nghĩa đã dựng lại đều khớp MD5 trước thay đổi. Snapshot trước triển khai xác minh trực tiếp ACL của 11 hàm; với ba hàm còn lại, migration tính năng không sửa ACL nên giữ nguyên ACL đang có. Hai reader phòng có bằng chứng owner cũ là postgres. Các owner còn lại không đổi trong phạm vi feature hoặc được kiểm bởi preflight của migration đã áp.

Comment lịch sử của list_cashbooks_for_expense_v2 không có trong snapshot. Không tìm được comment cũ trong baseline và lịch sử source; migration phục hồi bỏ comment riêng của tính năng. Không tuyên bố đã chứng minh nguyên trạng comment ngoài phạm vi bằng chứng.

[Review ứng dụng](../../audits/2026-09-21-restore-settlement/application-review.md) và [review SQL](../../audits/2026-09-21-restore-settlement/schema-review.md) ghi nhận kiểm tra độc lập. Những finding về config/test, cửa sổ concurrency, ACL và trigger đã được xử lý; kết quả động ghi trong evidence.

## Các bước thực hiện

1. Tạo worktree riêng từ main hiện hành; giữ nguyên checkout chính và nhánh vá dở. Đã xong.
2. Phục hồi src về mốc cũ, sửa đăng ký strict/E2E/tooling để không trỏ module đã gỡ. Đã xong; không hạ baseline để bỏ qua lỗi.
3. Dựng migration bù; so đủ 14 hash, quyền và phụ thuộc. Đã xong; production đã được đọc lại và khớp cả 14 hash/owner/ACL đích, 30 hàm mới và role mới đã vắng.
4. Tạo backup đầy đủ mới ngoài Git và diễn tập trên database dùng riêng. Đã xong; dữ liệu sao chép chỉ phục vụ kiểm thử, không restore đè production.
5. Chạy hai lượt migration trên database rỗng, database có dữ liệu và principal không superuser. Đã đạt. Sau local commit, số phiếu/hợp đồng/bút toán, tổng tiền và dấu kiểm ghi chú không đổi.
6. Thử tình huống sai hash, sai ACL, trigger bị đổi và giao dịch commit trong lúc migration đợi khóa. Đã bị chặn. Thử chèn DML làm đổi dữ liệu vào migration bằng công cụ đột biến; suite đỏ đúng lỗi và file gốc được khôi phục.
7. Đã kiểm headless desktop/mobile, ghi chú thực tế, 59 lượt PostgREST cục bộ theo vai trò, các luồng tiền và ranh giới tổ chức. Chưa thử ca dương tạo hoàn thanh lý/giữ chỗ do DEMO thiếu nguồn nghiệp vụ phù hợp; không nới guard để giả lập.
8. Đã mở draft PR #74 và review độc lập; 43 gate trước push đạt. Ba unit assertion SQL cũ và baseline thiếu ACL đã được xử lý bằng phép kiểm trạng thái đầy đủ. Full drill 256 file: 220 sạch, 36 dừng đúng kỳ vọng, không lệch; compensation hai lượt đạt. Không sửa SQL phục hồi để né gate.
9. App đã về artifact cũ xác minh SHA d3a83c64; headless đăng nhập production desktop/mobile đạt, RPC ghi chú cũ đạt. Sau lượt runner bị ngắt, lane đã hoàn tất lại nguyên SQL idempotent với backup mới và receipt thật lúc 10:01:34 UTC. Xem audit để phân biệt lịch sử runner và trạng thái database.
10. Đã chụp catalog sau phục hồi, đối chiếu cả hai tổng tiền không đổi, kiểm sandbox lại 0/151 bảng đọc được rò TEST. Receipt + catalog xác nhận 15 migration đã RETIRED; Vitest cuối 556 file/8.210 test đạt. Đồng bộ main/production theo CI đúng SHA, theo dõi kết quả cuối tại PR #74. Tab IAB tại lượt kiểm ghi nhận trắng root, không được tính là đạt dù trình duyệt headless độc lập cùng deployment hoạt động bình thường.

## Bảo vệ dữ liệu khi áp dụng

Migration lấy khóa bảng ngắn hạn, rồi mới kiểm có phiếu hoàn giữ chỗ hoặc thao tác review mới cần xét tương thích hay không. Nếu có, toàn bộ migration dừng; không sửa phiếu để ép chạy.

Trong cùng transaction, migration chụp dấu kiểm các bảng nghiệp vụ public/app_private trước và sau DDL. Bất kỳ sai khác dữ liệu, hash hàm, ACL hoặc phụ thuộc chưa tính đến đều làm transaction rollback. DROP dùng RESTRICT; không dùng CASCADE.

Không có một transaction chung bao phủ Vercel và PostgreSQL. Vì vậy thứ tự chuyển và trạng thái trung gian phải được thử, không gọi hai thao tác là nguyên tử. Tab mở từ bản mới trước khi rollback có thể cần tải lại; các RPC đã gỡ sẽ từ chối lời gọi, không âm thầm chuyển sang flow khác.

## Tiêu chí hoàn thành

- Ứng dụng và database cùng phản ánh mốc phục hồi; không chỉ đổi màn hình tạm thời.
- Ghi chú cũ hiển thị; không còn gọi các reader settlement đã gỡ.
- Đủ 14 hash/ACL đích, 30 hàm và 3 trigger mới được gỡ, hai trigger cũ còn hoạt động, role mới được gỡ.
- Dữ liệu và tiền không bị thay đổi bởi migration; phiếu mới vẫn còn.
- Main, production, deployment và biên nhận thống nhất. Các gate bắt buộc đạt; phần chưa kiểm phải ghi rõ.
