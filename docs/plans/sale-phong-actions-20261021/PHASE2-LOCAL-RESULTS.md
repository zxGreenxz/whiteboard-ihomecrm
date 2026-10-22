# Sale Phòng — cập nhật hàng loạt và chính sách có thời hạn trên local

Ngày thực hiện: 21/10/2026. Nhánh `codex/sale-phong-action-audit-20261021`, worktree riêng `C:/Users/Nguyen Tam/codex-worktrees/sale-phong-action-audit-20261021`.

## Quyết định nghiệp vụ cuối cùng

Chủ trọ, Chủ công ty, Quản lý, Sale Admin và Sale được cập nhật trực tiếp thông tin Sale Phòng trong phạm vi được giao. Không có hàng chờ duyệt, bước gửi đề xuất hoặc quyền duyệt mới. Quyền hiện hữu `sale_phong.edit` có nhãn rõ trong cài đặt; các mẫu vai trò nghiệp vụ hiện hữu được cấp mặc định bằng migration local. Cấm rõ ràng ở vai trò/thành viên và phạm vi tòa vẫn được tôn trọng. Việc này không cấp thêm quyền tài chính, quản trị hệ thống hoặc tòa ngoài phân công.

## Chức năng đã triển khai

- Một khu vực có hai cách sửa: **Nhanh** và **Bảng Excel**. Cả hai dùng chung danh sách có phạm vi và cùng lệnh lưu thông tin phòng. Ghi chú thường tách khỏi ưu đãi có thời hạn; ảnh xuất dùng thông tin hiệu lực mới đọc.
- Cập nhật hàng loạt trên web tối đa 50 phòng/lần. Chỉ đổi trường được chọn, cho xem lại nội dung rồi lưu trực tiếp; mỗi phòng có kết quả riêng. Không tải lại toàn bộ danh sách sau từng phòng trong lô.
- Bảo vệ sửa đồng thời bằng phiên bản phòng. Mất phản hồi giữ nguyên mã yêu cầu, dừng các phòng chưa gửi và cho đối chiếu lại; không biến lần lưu chưa rõ thành thất bại chỉ vì quyền bị thu hồi sau đó.
- Nháp và tiến độ được giữ riêng theo người dùng/tổ chức. Không gửi nếu chưa lưu được mã yêu cầu bền vững trong trình duyệt. Đổi người dùng/tổ chức dừng gửi các phòng tiếp theo.
- Chính sách gồm tên, nội dung, giờ bắt đầu/kết thúc theo giờ Việt Nam. Không cho chồng thời gian, cho phép hai chương trình liền nhau. Có thể chọn đúng chương trình đang hoặc sắp áp dụng để ngừng, có lý do và phiên bản.
- Trang phòng trống và ảnh xem trước/xuất không giữ ưu đãi đã hết hạn trong cache. Đồng hồ dựa trên thời gian máy chủ và khoảng thời gian yêu cầu; có thể ẩn sớm tối đa khoảng trễ mạng để tránh hiển thị quá hạn. Đây không phải cam kết đồng bộ thời gian tuyệt đối đến mili giây.
- Hermes có công cụ cập nhật lô tối đa 10 phòng/12 KiB và công cụ xem/lưu/ngừng/đối chiếu chính sách. Các giới hạn kết nối, quyền CRM, phạm vi và kiểm tra nội dung công khai vẫn áp dụng. Xem `HERMES-PHASE2.md` để phân biệt chức năng mới với phần đọc đang do Claude phát triển.

## Kiểm chứng và bằng chứng

Đây là lượt mở rộng tiếp theo; kết quả full gate của lượt trước trong `FINAL-VALIDATION.md` không đại diện cho mã nguồn mới. Không cộng các lượt chạy lại thành số ca mới. Bộ yêu cầu nghiệp vụ 5 vai trò từ lượt trước được giữ tại `ROLE-ACCEPTANCE.md`; đợt này bổ sung các tình huống hàng loạt, chính sách, mất phản hồi và đồng bộ hai bảng.

| Nhóm | Bằng chứng trong `test-results/sale-quick-local/` |
|---|---|
| Bảng nhanh, lô, biên nhận, giờ và quyền UI — 118 ca đạt | `phase2-root-tests.json` |
| Excel, giữ nháp, phiên bản, xuất ảnh, đồng bộ — 95 ca khác nhau đạt | `excel-integration-round4.json`, `excel-integration-preview-final.json` |
| Trình duyệt thật, component thật, dữ liệu tổng hợp — 19 tình huống đạt | `excel-ui-browser-results.json`, `excel-ui-batch-final-results.json` và ảnh `excel-ui-*.png` |
| PostgreSQL local: 25 ca nghiệp vụ và 7 phép thử cài lỗi có chủ ý đạt | `policy-native-final.log`, `policy-mutations.log` |
| Hermes nối lệnh thật tới PostgreSQL local | `hermes-bulk-policy-postgres.log`, `HERMES-PHASE2.md` và `hermes-phase2-postgres-results.json` trong thư mục báo cáo này |
| Lượt kiểm tra tổng: 42/48 nhóm đạt; chưa có full gate xanh | `phase2-initial-gate.log` và `phase2-initial-gate-exit.json` |
| Kiểm lại chính xác 8 tệp từng lỗi, một worker: 250/271 ca đạt; còn 21 timeout | `phase2-exact-recheck.json`, `phase2-exact-recheck.log`, `phase2-exact-recheck-exit.json` |
| Kiểm lại mã nguồn sau sửa fixture — 6/6 nhóm đạt, TypeScript ứng dụng và hai vùng strict không có lỗi | `phase2-final-static-results.json` và các log `phase2-final-check-*.log` |
| Biên dịch bản ứng dụng | `phase2-build.log` |

Các lỗi phát hiện qua review/kiểm thử đã được đưa thành ca hồi quy: ghi đè khi phiên bản cũ; unknown sau mất phản hồi; đọc lại sau thu hồi quyền; khôi phục tab đang gửi; nháp khác tổ chức; lệch múi giờ; ưu đãi hết hạn trong cache/ảnh; cập nhật chỉ thành công một phần; quyền/phạm vi bị đổi; không nhầm ghi chú thường với ưu đãi có hạn.

### Kết quả kiểm tra tổng và phần còn đỏ

Lượt tổng chạy 49 phút, kết thúc ngày 21/10/2026 lúc 15:07 giờ Việt Nam. Bộ native có 3.382 ca đạt, 0 thất bại và 24 ca bỏ qua theo điều kiện nền tảng; không tính 24 ca này là đạt. TypeScript ứng dụng và cả hai vùng strict không có lỗi. Ba kết quả được runner đánh dấu chưa hợp lệ vì tệp kiểm thử được sửa trong lúc chạy, nên không dùng chúng để chứng nhận một full gate xanh cho snapshot cuối.

Lượt Vitest liên quan ban đầu có 223 tệp: 3.371 ca đạt, 36 ca thất bại. Đã sửa tám lỗi lint của fixture, ba tệp còn ghim định nghĩa đọc phòng cũ và fixture cài đặt Hermes thiếu endpoint v9. Sau lượt tổng chỉ có sáu tệp kiểm thử thay đổi, ngoài cập nhật báo cáo này; mã sản phẩm, SQL và đầu vào build không đổi. Giữ lại bằng chứng còn đúng đầu vào, kiểm lại các phần bị ảnh hưởng; không tạo hoặc sửa biên nhận để biến lượt đỏ thành xanh.

Lượt kiểm lại dùng đúng tám đường dẫn tệp hiện hành, một worker và giữ nguyên timeout. Kết quả: 250/271 ca đạt; cả năm tệp kiểm tìm kiếm tài liệu, cài đặt Hermes, tạo cọc, phiếu thu cọc và xe đều đạt. Còn 21 timeout 5 giây tại `deferred-foundation-routing.test.mjs` (17), `gate-e2e-local-evidence.test.mjs` (3) và `gate-plan.test.mjs` (1). Số ca timeout thay đổi giữa các lượt là dấu hiệu cần điều tra điều kiện chạy, chưa đủ chứng minh nguyên nhân; các ca này vẫn là thất bại/chưa xác minh.

Sáu nhóm kiểm lại sau sửa fixture đều exit 0: liveness của kiểm migration, lint theo baseline, TypeScript ứng dụng, hai vùng strict, phạm vi strict của module mới và test matrix. Lint theo baseline chỉ xác nhận không phát sinh lỗi mới, không có nghĩa toàn kho mã sạch mọi lỗi lint lịch sử.

Một lượt chạy riêng trước đó dùng bộ lọc tên của CLI đã lấy thêm bản sao trong `test-results/.../replay-source`; đã dừng riêng tiến trình đó. Không dùng lượt này để đếm ca đạt. Báo cáo `phase2-exact-recheck.json` chỉ gồm tám tệp trong source hiện hành.

**Chức năng local đã triển khai; chưa chứng nhận hoàn tất toàn bộ kiểm thử hoặc đủ điều kiện phát hành.** Phần còn lại là xử lý/kiểm chứng 21 timeout nói trên trong điều kiện chạy kiểm soát được, cùng các kiểm TEST/CI và tích hợp thật trước phát hành. Không nới timeout, bỏ assertion hoặc sửa mã bộ đọc của Claude để làm xanh kết quả.

## Phần chưa xác minh và giới hạn phát hành

Chưa push, merge, deploy hay áp migration lên production. Không sửa checkout chính hoặc worktree Claude. Các tệp types có thay đổi sẵn từ phần đọc được giữ nguyên, không viết tay hoặc thay thế.

Phần hiển thị chính sách của trang nhanh Hermes được bổ sung bằng migration riêng, chỉ thay biểu thức nội dung ưu đãi, giữ phần chọn phòng, phạm vi, thứ tự và phân trang. Có kiểm so sánh PostgreSQL với trang web ở các trạng thái hiệu lực; không sửa tệp bộ đọc của Claude. Nhãn `catalog-proven` của migration thay thế hàm chỉ cho biết tên hàm đã tồn tại trong catalog, không chứng minh phiên bản local đã triển khai.

Kiểm cơ sở dữ liệu dùng PostgreSQL 17.10 riêng tại loopback; đây không phải toàn bộ Supabase HTTP/Auth/Storage. Browser dùng backend/hook tổng hợp, nên không gọi đây là E2E với JWT hoặc nhà cung cấp thật. Chưa kiểm trên tài khoản production, thiết bị thực hoặc gửi tin nhắn thật. Lane TEST/CI và phát hành vẫn là công việc sau khi cho phép triển khai; không suy ra production đã được tối ưu hay không còn mọi lỗi từ bằng chứng local.

Hermes có cổng bật tính năng và chính sách kết nối riêng; migration đăng ký capability theo cơ chế hiện hữu, không tự bật mọi kết nối hoặc gửi tin. Không có cơ chế phê duyệt nghiệp vụ mới. Các kiểm tra Hermes local bật cấu hình trong dữ liệu tổng hợp để kiểm đủ hành vi.

## Cập nhật kiểm chứng 22/10/2026

Người dùng đã cho phép phát hành production sau khi kiểm tra. Bản tích hợp được tạo riêng tại `sale-phong-release-20261022`, nền `36781b3baa0a60eb5ebc8573aa0e46c97253511c`; giữ nguyên worktree cũ và checkout Claude. Các kết quả ngày 21/10 ở trên là lịch sử, không phải trạng thái cuối của lần phát hành này.

- Đã xử lý 21 timeout: đúng ba tệp liên quan đạt 179/179, không bỏ test hoặc tăng timeout. Cache biểu thức glob chỉ sống trong từng lần tạo kế hoạch; bộ routing giảm từ 57,37 giây xuống 1,29 giây. Mutation cố ý làm matcher khớp mọi đường dẫn bị phát hiện; nguồn đã phục hồi đúng hash.
- Đã sửa hai regression của bảng nhanh: mất phản hồi rồi đọc lại bị từ chối/xung đột phải giữ trạng thái chưa xác nhận. 33 test Quick và 16 test tích hợp hook/cache thật đều đạt.
- Trình duyệt trên source tích hợp: 13/13 ca đạt, gồm năm vai trò trên desktop/mobile, hai tab độc lập, chống ghi đè và mất phản hồi. Preview tại cổng 4201 dùng dữ liệu tổng hợp localStorage với hook thật; không phải cơ sở dữ liệu production.
- SQL local mới: 20/20 ca cho năm vai trò qua writer chung và các nguồn inventory/get_my/public/Hermes, replay và revision cũ.
- Bảy migration được kiểm hai lượt trong ROLLBACK trên project TEST riêng, sau đó áp vào TEST bằng lane `test-env:thu-sql`. Không ghi production trong bước này.
- Auth/JWT/PostgREST thực trên TEST: 101/101 ca đạt cho năm vai trò, đọc lại inventory/REST, CAS/replay, chính sách, phạm vi tổ chức/tòa và thu hồi quyền. Cleanup xác nhận không còn tổ chức, phòng hoặc người dùng Auth fixture.
- Build ứng dụng tích hợp đạt. Đối chiếu tiền v1/v2 chỉ đọc trước phát hành đều đạt; số liệu riêng tư không đưa vào báo cáo.

Bằng chứng ngày 22/10 nằm trong `test-results/sale-quick-local/` của worktree tương ứng: `timeout-fixed-20261022.json`, `timeout-mutation-proof-20261022.json`, `board-sync-integration-final.json` (worktree cũ); `sync-ui-browser-results.json`, `release-sale-actual-jwt.json`, `release-test-dry-run.log`, `release-test-apply.log`, `release-app-build.log`, `release-reconcile-v1-before.log`, `release-reconcile-v2-before.log` (worktree tích hợp).

Lượt aggregate trên bản tích hợp hoàn tất: 228/228 tệp Vitest liên quan đạt; native có 3.675 ca đạt, một ca thất bại vì khóa nhãn Hermes bị khai báo trùng và 28 ca bỏ qua theo nền tảng. Đã bỏ khóa trùng (giữ phần Thu Chi của main), sửa một lỗi định dạng test và bốn liên kết log local không được đóng gói. Kiểm lại đúng phần bị ảnh hưởng đều đạt: docs, lint theo baseline, TypeScript, hai vùng strict, native TS 3/3 và labels/đồng bộ 20/20. Không sửa receipt aggregate cũ thành xanh; các ca còn nguyên đầu vào được tái sử dụng, CI của commit phát hành vẫn phải chạy.

Review bổ sung phát hiện và sửa nháp ảnh cũ không cập nhật khi nguồn đổi trong lúc tải ảnh rồi tải lỗi. Hai ca hồi quy tái hiện trước sửa; bộ ảnh cuối đạt 20/20. Build ứng dụng sau sửa hook đạt (`release-app-build-final.log`).

Hermes đã tích hợp một công cụ công khai `crm_sale_action`, phân phối vào 16 thao tác Sale có sẵn theo quyền hiệu lực. Catalogue full-grant thực mount Sale có 66 công cụ, 63.357 byte, giữ nguyên định nghĩa 65 công cụ của main. Bộ bridge 20/20, các kiểm liên quan 37/37 và parity web 72/72 đạt; review độc lập không còn P1/P2. Không tăng ngân sách catalogue hay bỏ bộ đọc của Claude.

Migration activation riêng chỉ bật sáu khóa Sale sau bảy migration schema và bản broker/web tương ứng. Giữ nguyên cờ Thu Chi, chính sách tổ chức, exclusions, ý định phạm vi, session và credentials; kết nối hết hạn vẫn phải đăng nhập lại. Kiểm độc lập xác nhận transaction/guards và phạm vi cập nhật; không coi SQL này là bằng chứng broker đã triển khai.

Tại thời điểm ghi báo cáo này chưa phát hành production. CI đúng SHA, lane migration production, phát hành web/broker/worker và smoke sau phát hành còn phải hoàn tất. Nhật ký mới ở `release-gate.log`, `release-tail-*.log/json`, `review-photo-busy-final.json`, `hermes-compact-affected.log` trong thư mục test-results local; các nhật ký đó không được đóng gói trong Git.

### Bổ sung bằng chứng trước phát hành

Bộ Auth/JWT/PostgREST thứ hai đạt **101/101** ca với năm vai trò: giữ/mở phòng, cọc chưa thu, tạo cọc qua writer canonical, nhận lại kết quả khi gửi lặp, hai hạn giữ chỗ/bổ sung, revision cũ và giới hạn tổ chức/tòa. Mỗi vai trò có ca nhận 500.000 đồng tạo đúng một posting và tổng dòng tiền tương ứng; phiếu chỉ được đánh dấu duyệt mà chưa có posting không bị tính là đã nhận tiền. Dữ liệu kiểm thử thuộc tổ chức tổng hợp trên TEST đã dọn sạch; ba guard bất biến lịch sử tài chính được xác nhận bật lại đúng chế độ. Không tạo giao dịch tổ chức thật.

Suite trình duyệt Auth chính thức trên preview TEST của source `f85ff9887d4259ca9a86b2d957a7f62e82bb14f5` đạt **4/4**, không skip/flaky, đăng nhập thật vai chủ công ty và quản lý. Kiểm trước khi chạy xác nhận build SHA và dữ liệu chỉ tới TEST; config, global setup, auth helper và spec không đổi trước/sau. Lease TEST đã giải phóng và cookie bypass tạm đã xóa. Suite này chỉ kiểm hai vai; không dùng nó thay thế bằng chứng năm vai của hai suite JWT.

Activation được kiểm trên TEST **21/21** ca, gồm guard âm và rollback; không để lại capability bật thêm hoặc lease. Restore Drill CI của đúng source trên đạt; đây là khôi phục baseline/roles shim và replay migration, không phải bằng chứng đã phục hồi toàn bộ dump production mới lên Supabase.

CI lần đầu phát hiện ba assertion cũ trong `reservationHoldDeadlineMigration.test.ts`: writer hiện ủy quyền kiểm phạm vi cho helper chung và phải từ chối phiếu `CANCELLED`. Đã cập nhật test để kiểm cả chuỗi helper đang sống, nhánh từ chối quyền và ngăn lệnh tự hủy/thu thêm; không sửa SQL để đáp ứng test cũ. Kiểm riêng đạt **21/21**, lint và migration-test-liveness đạt. Không coi CI lần đầu là xanh; kết quả CI bản cuối được kiểm riêng khi phát hành.

Bằng chứng local bổ sung: `release-sale-reservation-actual-jwt.json`, `reservation-jwt-recovery-evidence.json`, `preview-test-auth.json`, `sale-activation-test-evidence.json` và `deadline-live-guards-*.log`. Preview local cổng 4201 vẫn là dữ liệu tổng hợp, tách biệt dữ liệu thật.

CI còn phát hiện lỗi dọn PostgreSQL dùng riêng cho test stable binding: `pool.end()` có thể trả về trước khi kết nối vật lý đóng, khiến lệnh dừng cluster phát sinh lỗi muộn. Đã thêm chờ kết nối đóng; test hồi quy đỏ với cách cũ, bộ cuối đạt 13/13. Không thay SQL, timeout hoặc điều kiện quyền. Bộ kỳ hạn cọc sửa ở trên cũng đạt 21/21 trong cả bốn múi giờ; đây là kiểm phần sửa, không thay kết luận full timezone của CI cuối.

Bảy migration schema production đã hoàn tất qua forward-only lane, mỗi lượt có backup và receipt khớp digest nguồn; migration cuối hoàn tất lúc 21:06 ngày 22/10/2026 (UTC+7). Lượt đầu của migration 07 bị ngắt tại backup, chưa apply; đã xác minh live function còn đúng bản trước rồi chạy lại lane đầy đủ. Chưa bật activation sáu Sale keys, chưa chuyển web hoặc runtime trong bước schema này. Receipt được lưu tại `docs/generated/schema-change-evidence/`.
