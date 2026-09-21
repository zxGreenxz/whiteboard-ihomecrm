# Review độc lập migration phục hồi schema

Ngày: 2026-09-21. File: `supabase/migrations/20260921085952_restore_before_contract_settlement.sql`. Review chỉ đọc; không chạy SQL ghi kể cả database local, không gọi production mutation, không sửa file nào ngoài report này.

## Kết luận tại bản đã đọc cuối

Digest SHA256: `0574aba685d341fd10140afa751f79b0b09f1b0e26a4919640bbf08e8fa8ab85`.

Ba thiếu sót guard của bản đầu đã được báo cho agent chính và được sửa trong source. Không còn finding chặn ở ba điểm đó sau rà tĩnh. Đây là kết luận về cấu trúc SQL, **chưa phải phê duyệt phát hành**: review này không chạy test database, không chứng minh concurrency hoặc dữ liệu production được bảo toàn sau apply. Agent chính đang sở hữu các kiểm thử và evidence đó.

## Finding đã yêu cầu sửa và trạng thái

### P1 — Khoảng đua giữa compatibility guard và khóa bảng — đã sửa trong source

Bản đầu kiểm pending reservation refund và operation mới trước vòng `LOCK TABLE`. Writer có thể commit sau guard rồi trước khi khóa được lấy. Witness khi đó chỉ chụp trạng thái mới, không phát hiện rằng nó không tương thích với việc gỡ dispatcher. Cần kiểm sau khi đã lấy đủ khóa, không sửa/xóa phiếu để vượt guard.

Bản đã đọc cuối đặt hai kiểm tra sau vòng SHARE lock tại dòng 76–79. Với transaction READ COMMITTED, kiểm tra này nhìn thấy writer đã commit trong lúc đợi khóa. Cần concurrency negative test chứng minh writer commit trước thời điểm khóa cuối làm migration từ chối, thay vì chỉ kiểm ca dữ liệu đã tồn tại trước khi bắt đầu migration.

### P1 — Nhánh idempotent bỏ qua owner/ACL đã drift — đã sửa bằng verify cuối

Bản đầu chỉ kiểm owner/ACL nếu hash bằng current_hash. Nếu body đã bằng restored_hash, owner/ACL khác vẫn được chấp nhận; verify cuối cũng chỉ kiểm body. Ví dụ cấp thêm EXECUTE cho anon/PUBLIC sau lượt đầu có thể tồn tại qua lượt chạy lại mà báo đạt.

Bản cuối có vòng đối chiếu owner/ACL đầy đủ cho 14 function tại dòng 1782–1799; ACL thừa hoặc owner sai làm toàn transaction thất bại. Verify cuối đủ chặn commit sai ngay cả khi preflight nhánh restored chưa kiểm riêng. Cần negative test bắt đúng lỗi sau lượt đầu với ACL thừa; không chỉ test idempotency trạng thái sạch.

### P2 — DROP TRIGGER không kiểm trigger đang gỡ — đã sửa trong source

Bản đầu gỡ ba trigger theo tên mà không kiểm definition/tgenabled; trigger cùng tên đã đổi chức năng vẫn bị gỡ. Bản cuối pin hash pg_get_triggerdef và enabled mode tại dòng 64–70, chấp nhận absence phục vụ chạy lại. Cần ca đổi trigger definition hoặc mode làm guard đỏ.

## Kiểm định phạm vi và definition

- Đã đọc Project Contract, MIGRATION_STRATEGY, `reconstructed.json`, `verified-pre-feature-metadata.json`, `restore-metadata.json`, `local-current-verification.json`, các audit trong checkout chính và runner `apply-reviewed-migration.mjs`.
- Tự tính MD5 từ chuỗi `definition` của `reconstructed.json`: 14/14 khớp beforeMd5; 14/14 definition có nguyên văn trong SQL phục hồi.
- `local-current-verification.json` chứa 44/44 match. Đây là evidence được agent chính tạo, không phải lần kết nối DB độc lập của reviewer.
- Bốn definition được đảo patch có pin hash đích, còn lại lấy lịch sử và chuẩn hóa bằng pg_get_functiondef. Không lấy file lịch sử CREATE cuối một cách mù quáng làm “bản trước”; cách pin hash phục hồi giải quyết đúng rủi ro dynamic patch.
- Không mở rộng review thành thiết kế lại 14 body cũ. Những rủi ro vốn có trong body cũ không được ghi là lỗi restorationintroduced.

## Bảo toàn dữ liệu và khóa

- Các lệnh chạy ở top level chỉ thay named functions, grants/owners, comment, ba trigger và role chuyên biệt; không có DML nghiệp vụ, DROP TABLE/COLUMN, CASCADE hay restore dump đè dữ liệu. INSERT/UPDATE/DELETE trong body function là định nghĩa được cài lại, không tự chạy khi CREATE OR REPLACE.
- Witness chứa count và hai tổng nửa MD5 của toàn bộ `to_jsonb(row)` trên bảng public/app_private. Khóa SHARE được lấy theo schema/name, giữ đến hết transaction; child partitions được bao phủ qua parent. Witness cuối so cùng bảng đã chụp trước.
- Đây là bằng chứng chống thay đổi dòng ngoài ý muốn trong transaction, không phải bằng chứng tính đúng nghiệp vụ, số dư tiền hay tương thích mọi dòng với writer cũ. Cần reconcile tiền và kiểm dòng mới hợp lệ riêng.
- Khóa toàn bảng sẽ chặn writer thật trong khoảng migration. Thứ tự có tính xác định giữa các lượt restore nhưng không bảo đảm trùng thứ tự khóa của mọi RPC đang chạy; deadlock/timeout vẫn có thể làm apply thất bại an toàn. Không được tự retry ngầm.
- Runner forward dùng advisory transaction lock, lock_timeout 5s, statement_timeout 120s và gỡ BEGIN/COMMIT của file để chỉ giữ một transaction kết thúc đúng COMMIT hoặc ROLLBACK. Không có lỗi nested-COMMIT trong cách dùng lane đã đọc.
- Reviewer chưa đo chi phí witness trên dữ liệu có thật/đủ kích thước; schema clone rỗng không chứng minh thời gian giữ khóa production. Lần dry-run cũng lấy khóa, cần tính vào trình tự vận hành.

## Quyền, role và phụ thuộc

- CREATE OR REPLACE bảo toàn identity/ACL của 14 hàm. Những thay đổi quyền bổ sung giới hạn vào service_role của request/resubmit và hai room reader; owner của hai room reader về postgres. Metadata trước feature xác nhận hai owner và các ACL liên quan này.
- Metadata trước feature không chụp owner/comment cho mọi hàm; report nguồn đã phân biệt “chưa chụp” với NULL. Không tuyên bố đã có pre-feature catalog đầy đủ cho cả 14 hàm. Việc giữ owner/ACL chưa đổi dựa trên current metadata và phạm vi thay đổi của 15 migration.
- DROP nhiều hàm cùng một câu RESTRICT giữ đúng tập 30 hàm cần gỡ. Dependency cứng ngoài tập làm abort; không dùng CASCADE. Postcheck tìm body surviving function tham chiếu tên helper bổ sung lớp bảo vệ cho dependency runtime không nằm trong catalog.
- Regex postcheck không phải chứng minh tuyệt đối đối với dynamic SQL hoặc caller ngoài database; nguồn ứng dụng đã được đối chiếu với mốc cũ trong application-review. Overload 4 tham số của create_termination_refund_voucher_v1 được giữ, overload 7 tham số bị gỡ.
- Role cleanup chỉ revoke các quyền schema/cột đã biết và membership authenticated rồi DROP ROLE; dependency object chưa giải quyết làm DROP ROLE thất bại. Không DROP OWNED/REASSIGN OWNED nên không xóa lan object ngoài phạm vi.
- NOTIFY pgrst reload schema chỉ có hiệu lực khi commit; cần kiểm lại qua PostgREST sau apply, không coi notification là biên nhận endpoint đã sẵn sàng.

## Những bằng chứng còn cần trước phát hành

1. Chạy lại đúng digest cuối trên clone có dữ liệu: lần đầu, lần thứ hai, role giống production thay vì chỉ superuser; negative tests cho drift hash/ACL/trigger, dependency thừa, pending refund và concurrent writer.
2. Kiểm quyền authenticated/service_role, từ chối cross-tenant và gọi RPC qua PostgREST; reconcile tiền v1/v2, sandbox leak và gate theo Contract. Reviewer chưa chạy các kiểm này.
3. Diễn tập trạng thái chuyển tiếp. App settlement đang mở có thể tiếp tục gọi RPC mới sau khi DB đã drop; không có transaction nguyên tử bao trùm Vercel và PostgreSQL. Cần thứ tự chuyển đã kiểm và cách xử lý phiên trình duyệt cũ/in-flight request; nếu không chứng minh trạng thái trung gian an toàn thì cần khoảng chặn ghi có hiệu lực như kế hoạch đã nêu.
4. Kiểm lại catalog/types theo database cuối, backup từ chính lane apply và row witness/reconcile trước sau. Source cũ khớp Git và DDL hợp lệ không tự chứng minh dữ liệu đã an toàn trên production.

Các test/dry-run trên database được agent chính báo đã chạy không được reviewer ghi lại thành kết quả tự xác minh. Báo cáo chỉ xác nhận đọc mã, đối chiếu artifacts và tính hash độc lập nêu trên.
