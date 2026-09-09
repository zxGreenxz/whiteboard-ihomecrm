# Bằng chứng triển khai xử lý bỏ cọc giữ chỗ

Trạng thái: đã hiện thực và kiểm thử; schema đã áp qua lane có backup. Người dùng đã yêu cầu hoàn tất toàn bộ plan và đưa lên production. Đang hoàn tất kiểm tra phát hành; chưa promote app.

## Phạm vi và căn cứ

- Thiết kế: `docs/superpowers/specs/2026-09-10-reservation-deposit-settlement-design.md`.
- Base khảo sát triển khai: `30d086750b5e1ca6980b877a8be7eabc88091ca5`.
- Đã đọc catalog live của 37 hàm nguồn cùng các helper Finance V2; chỉ truy vấn đọc. Graph được refresh và kiểm freshness trước impact của hai hook cọc.
- Dùng lõi `finance_v2_post_voucher_with_source_v1` cho chi thật, không giả provenance hoặc bỏ ranh giới commit của phiếu thủ công. Reversal giữ RPC tài chính hiện hành và kiểm lại quyền trước replay đối với nguồn mới.
- Hạng mục thu chi dùng `PNL` cho doanh thu; từ REVENUE trong thiết kế là khái niệm nghiệp vụ, không phải giá trị hợp lệ của `income_expense_items.accounting_class`.
- Khóa 24h không có FK hoặc audit liên kết phiếu nguồn. Giữ khóa chưa xác định được và trả `UNRELATED_HOLD`, không hủy theo phòng/số tiền.

## Kiểm thử

- PostgreSQL 17 riêng trên loopback; phục hồi schema, chỉ nạp phạm vi DEMO và quyền cần cho fixtures. Không nạp dữ liệu sổ sách của tổ chức thật. Extension vector/cron/vault không có ở máy; các bảng và hàm của luồng tiền đã dựng và chạy được.
- Migration được áp từ đầu trên database thử mới, không chỉ thay lẻ hàm. Ca thành công ép kiểm FK hoãn trước khi rollback. Ca đồng thời dùng database thử riêng rồi dọn cả database.
- Đã chứng minh bỏ toàn bộ không đổi quỹ; partial NOW/LATER và full refund; nguồn trộn chỉ dùng phần cọc; không nhận tiền chưa posting hoặc đã đảo; replay; kỳ khóa; sổ ảo; thiếu quyền; bảo vệ phiếu nguồn và loại cọc; đảo/hoàn lại; phòng còn cọc hoặc hold; explicit/legacy contract.
- Suite SQL cuối đạt **33/33 ca** (47,85 giây), gồm role authenticated và kiểm private helper/DML bị chặn. Hai settlement đồng thời và hai lần chi đồng thời chỉ tạo một kết quả. Cạnh tranh tạo hợp đồng với settlement chỉ có một bên tiêu dùng cọc.
- Kiểm tổng và phân trang trên 1.105 hồ sơ chờ hoàn, có tra cứu trực tiếp theo phiếu nguồn.
- PostgREST **14.17** thật trên loopback đạt **1/1 ca HTTP**: FK embed chỉ rõ nguồn, anti-join trước/sau settlement, history 1:1, preview, settlement, summary/list ở transaction đọc, hoàn tiền và actor thiếu quyền. Chỉ dùng JWT ký riêng cho server thử; không dùng token này trên môi trường dùng chung.
- Ba đột biến **bảo vệ phiếu nguồn / chia số giữ lại / kiểm quyền** đều làm đúng test đỏ; đã khôi phục SHA-256 migration về tiền tố `32008e7d10b7`. Công cụ `scripts/dot-bien.mjs` trả 0 cả ba lần.
- `migrate:forward` dry-run trên catalog dùng chung đạt, đã ROLLBACK (1 giây), sau đó apply thành công bằng chính migration đã review.
- Vitest: **60/60 ca**, gồm biểu mẫu, trạng thái, mở/đóng chi tiết từ phiếu null, bảo vệ ba loại phiếu nội bộ, lỗi tra cứu và preview cọc chưa đủ điều kiện. Các lỗi hồi quy mới đã được tái hiện đỏ trước khi sửa.
- Bộ kiểm đồng bộ dùng chung: **31/31 ca**. CI lượt đầu phát hiện danh sách bảng mong đợi chưa bổ sung `reservation_deposit_settlements`; đã tái hiện tại máy và cập nhật. Hai ca bổ sung kiểm cache cọc, hàng chờ hoàn và lịch sử phiếu thật sự bị đánh dấu cần tải lại sau sự kiện settlement hoặc thu chi, không ảnh hưởng cache khách hàng.
- `gate:timezone` sau cập nhật: **5.888/5.888 ca** ở mỗi múi giờ UTC, Asia/Ho_Chi_Minh, Pacific/Kiritimati và Pacific/Midway; cùng 353 file và cùng kết quả.
- Playwright headless với component/hook thật và PostgREST/PostgreSQL riêng: **4/4 ca** bỏ toàn bộ, hoàn một phần ngay, hoàn sau rồi chi, hoàn toàn bộ trên màn hình điện thoại. Mỗi ca kiểm lại số quỹ và trạng thái từ database. Chặn service worker, WebSocket và mọi request ra ngoài; chỉ chuyển REST sang loopback với JWT thử. Không mock kết quả RPC.
- Playwright đăng nhập DEMO trên **bản build thật**: **1/1 ca** mở Sổ cọc → Phiếu giữ chỗ → preview → đóng, kiểm HTTP 200 và không gọi hai writer. Đã kiểm thẻ build SHA `77818d77cd124af756e8d44e1fe0c57a9ef5020c`. Phiếu cũ có cọc hợp lệ bằng 0 được hiển thị lý do chặn, không lỗi màn hình.
- `typecheck:baseline`: 0 fingerprint; `typecheck:e2e`: đạt; lint ratchet: 0 lỗi mới. Build Node 24: 4.798 module, 14,71 giây. `gate:truoc-push`: **42/42 gate**, gồm strict islands, đạt trong 106 giây.
- Playwright trên DEMO dùng chung: hai browser context độc lập nhận sự kiện WebSocket thật sau settlement và sau chi hoàn. Client thứ hai cập nhật trạng thái, bỏ nút tạo hợp đồng và xóa khoản chờ hoàn; đối chiếu lại posting và phiếu nguồn. Ca này đạt, không mock RPC hoặc Realtime.
- Playwright trên DEMO dùng chung: ngày ghi nhận cuối tháng trước, hoàn ngay vào tháng hiện tại; gọi hai basis của `business_performance_pnl_v1` và `cashflow_by_day_v2` dưới role authenticated. Doanh thu tăng đúng phần giữ lại ở kỳ xử lý; chỉ ngày thực chi có dòng tiền ra; offset và hoàn cọc không tăng chi phí KQKD. Ca này đạt.
- Playwright trên DEMO dùng chung: server đã commit nhưng response bị ngắt; tải lại vẫn chỉ một settlement, nguồn giữ nguyên tiền và cờ KQKD, quỹ không tăng. Ca này đạt.
- Kiểm tra bổ sung tại `19916cf2`: toàn bộ Vitest **465 file / 7.275 ca đạt**; typecheck baseline 0 fingerprint và typecheck E2E đạt. Build **4.798 module / 15,02 giây**; bundle **518 chunk, entry 220 kB, 97 trang lazy** đạt, có chunk dialog xử lý cọc và lịch sử.

## Chạy lại và dọn dữ liệu thử

Runner là `scripts/test-reservation-deposit-settlement.mjs`; chỉ chấp nhận database loopback. Chạy SQL trước khi khởi động PostgREST vì ca race cần clone database không có kết nối khác. Sau đó bật PostgREST trỏ đúng database riêng và chọn `--test-name-pattern='HTTP FK|Browser real RPC'`, cung cấp `RESERVATION_TEST_HTTP_URL` và `RESERVATION_TEST_BROWSER_URL` loopback. HTML fixture dưới `.e2e-fleet/fixtures/` chỉ được dev server phục vụ, không có route sản phẩm nhập vào.

HTTP/browser cần commit để các kết nối nhìn thấy nhau; phải dùng database dùng một lần và xóa cả database trong teardown, không tái sử dụng phần dư sau test lỗi. Các ca SQL thường rollback, các ca race tự xóa database con. Chỉ schema và fixtures DEMO được nạp vào cụm thử.

Teardown database riêng đã hoàn tất: xóa database HTTP/browser, xác nhận không còn database race, dừng PostgREST và cụm PostgreSQL riêng của phiên. Smoke ban đầu chỉ đọc DEMO.

Suite bổ sung `.e2e-fleet/specs/reservation-deposit-settlement.spec.ts` tạo phòng và phiếu mới riêng trong DEMO qua writer hiện hành; companion `reservation-settlement-admin.ts` kiểm UUID, marker và tổ chức trước mỗi thao tác. Cleanup trong `finally` chỉ xóa fixture sở hữu, kiểm mọi FK tham chiếu và phục hồi nguyên trạng trigger `ENABLE ALWAYS` trong cùng transaction. Các ca đã chạy đều dọn thành công, kể cả lượt assertion thất bại khi hoàn thiện test. Không ghi dữ liệu tổ chức thật.

Điều chỉnh artifact so với plan: runner `.mjs` chứa trực tiếp các ca SQL, HTTP, browser và cạnh tranh hai kết nối; không tạo thêm file SQL trùng nội dung hoặc cờ `--concurrency` riêng. Bộ SQL 33 ca đã bao gồm các race; dùng `--test-name-pattern` để chọn nhóm. Bộ browser dùng chung bổ sung ca Realtime, báo cáo và mất response cho những yêu cầu không thể chứng minh bằng database cô lập.

## Review độc lập

Đã sửa các phát hiện: cọc nguồn lẻ VND bị làm tròn; thứ tự khóa tổ chức/phòng; bỏ sót hold APPROVED; quyền chi trên NOW replay; ngày chi NOW bị gắn với ngày doanh thu. Reviewer độc lập xác nhận không còn blocker tiền/quyền trong migration tại SHA `39744488f131eb8c5d1f50322192524cc837840a`, digest `32008e7d10b730ceef4840fb307288e033be5d868842597ed30f27136e6da2e6`.

Review giao diện tìm thêm lỗi truy vấn cột tính toán như cột thật, mất context của Supabase client, hook sau early return, bảo vệ thao tác tiền và invalidation lịch sử. Đã sửa và tái kiểm thử. Rà soát toàn bộ plan bổ sung khả năng phục hồi form hợp đồng cũ, ánh xạ lỗi thực tế, lịch sử người xử lý/lý do/liên kết phiếu, và cộng nguồn giữ chỗ vào tổng tiền bỏ cọc/hoàn cọc. Reviewer độc lập xác nhận **không còn blocker đã phát hiện** tại SHA `19916cf22bdb758b0278c4b01f46a23c0168e770`. SQL không đổi so với bản đã review/applied.

## Phát hành

- Schema đã apply lúc `2026-09-09T17:56:14.163Z` qua `npm run migrate:forward ... --apply`, biên nhận backup `16d825b80277f7e4`. Backup đầy đủ 519 bảng có dữ liệu, 27,8 MB; evidence ở `docs/generated/schema-change-evidence/20260909172332_reservation_deposit_settlement_v1.json`. Không sửa dữ liệu tổ chức thật và không backfill cọc cũ.
- Catalog sau apply: `f70937dcaf8f4f6ba935c8a7f4251fab32bbd2ca59ce2c7d3ca966f837dc2652`; canonical types và manifest bề mặt sinh lại từ database thật.
- Sau apply: `gate:stable-fn-locks`, `gate:definer-acl`, `gate:approver-provenance`, `catalog:check`, `gate:realtime-descriptors` đều đạt. Đối soát V2 khớp 20 sổ thực và 3.434 dòng posting qua 4 trang. Không đưa số tiền công ty vào tài liệu kiểm thử.
- `gate:sandbox-leak` đạt: 146 bảng đọc được, rò rỉ 0; 18 bảng còn lại không cấp SELECT. Số liệu công ty thật không đổi giữa hai snapshot. Baseline được chụp sau migration, nên không dùng nó để khẳng định số liệu trước migration.
- External controls đã kiểm bằng API: cả app và docs theo nhánh `production`; GitHub private Free không có branch protection như giới hạn đã khai trong Contract.
- PR nháp #57 đã mở và review độc lập phần tiền/quyền hoàn tất. Người dùng đã cho phép đưa lên production; app sẽ được promote sau khi các gate trên main đạt và sẽ được kiểm tra lại đúng SHA trên domain production.
