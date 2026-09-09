# Bằng chứng triển khai xử lý bỏ cọc giữ chỗ

Trạng thái: đã hiện thực và kiểm thử; schema đã áp qua lane có backup. Giao diện đi PR nháp để duyệt theo quy định thay đổi tiền, chưa promote app.

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
- Playwright headless với component/hook thật và PostgREST/PostgreSQL riêng: **4/4 ca** bỏ toàn bộ, hoàn một phần ngay, hoàn sau rồi chi, hoàn toàn bộ trên màn hình điện thoại. Mỗi ca kiểm lại số quỹ và trạng thái từ database. Chặn service worker, WebSocket và mọi request ra ngoài; chỉ chuyển REST sang loopback với JWT thử. Không mock kết quả RPC.
- Playwright đăng nhập DEMO trên **bản build thật**: **1/1 ca** mở Sổ cọc → Phiếu giữ chỗ → preview → đóng, kiểm HTTP 200 và không gọi hai writer. Đã kiểm thẻ build SHA `77818d77cd124af756e8d44e1fe0c57a9ef5020c`. Phiếu cũ có cọc hợp lệ bằng 0 được hiển thị lý do chặn, không lỗi màn hình.
- `typecheck:baseline`: 0 fingerprint; `typecheck:e2e`: đạt; lint ratchet: 0 lỗi mới. Build Node 24: 4.798 module, 14,71 giây. `gate:truoc-push`: **42/42 gate**, gồm strict islands, đạt trong 106 giây.
- Publication/realtime descriptors và invalidation keys đã kiểm. Chưa chạy thử hai trình duyệt nhận sự kiện Realtime từ một giao dịch tiền trên môi trường dùng chung; phần ghi tiền của browser được cô lập trên database riêng.

## Chạy lại và dọn dữ liệu thử

Runner là `scripts/test-reservation-deposit-settlement.mjs`; chỉ chấp nhận database loopback. Chạy SQL trước khi khởi động PostgREST vì ca race cần clone database không có kết nối khác. Sau đó bật PostgREST trỏ đúng database riêng và chọn `--test-name-pattern='HTTP FK|Browser real RPC'`, cung cấp `RESERVATION_TEST_HTTP_URL` và `RESERVATION_TEST_BROWSER_URL` loopback. HTML fixture dưới `.e2e-fleet/fixtures/` chỉ được dev server phục vụ, không có route sản phẩm nhập vào.

HTTP/browser cần commit để các kết nối nhìn thấy nhau; phải dùng database dùng một lần và xóa cả database trong teardown, không tái sử dụng phần dư sau test lỗi. Các ca SQL thường rollback, các ca race tự xóa database con. Chỉ schema và fixtures DEMO được nạp vào cụm thử.

Teardown đã hoàn tất: xóa database HTTP/browser, xác nhận không còn database race, dừng PostgREST và cụm PostgreSQL riêng của phiên. Không ghi dữ liệu nghiệp vụ vào DEMO dùng chung trong smoke.

## Review độc lập

Đã sửa các phát hiện: cọc nguồn lẻ VND bị làm tròn; thứ tự khóa tổ chức/phòng; bỏ sót hold APPROVED; quyền chi trên NOW replay; ngày chi NOW bị gắn với ngày doanh thu. Reviewer độc lập xác nhận không còn blocker tiền/quyền trong migration tại SHA `39744488f131eb8c5d1f50322192524cc837840a`, digest `32008e7d10b730ceef4840fb307288e033be5d868842597ed30f27136e6da2e6`.

Review giao diện tìm thêm lỗi truy vấn cột tính toán như cột thật, mất context của Supabase client, hook sau early return, bảo vệ thao tác tiền và invalidation lịch sử. Đã sửa, tái kiểm thử và reviewer độc lập xác nhận **không còn blocker đã phát hiện** tại SHA `77818d77cd124af756e8d44e1fe0c57a9ef5020c`. SQL không đổi so với bản đã review/applied. Thay đổi sau SHA này chỉ sửa kiểu callback phục vụ lint và bổ sung bằng chứng kiểm thử.

## Phát hành

- Schema đã apply lúc `2026-09-09T17:56:14.163Z` qua `npm run migrate:forward ... --apply`, biên nhận backup `16d825b80277f7e4`. Backup đầy đủ 519 bảng có dữ liệu, 27,8 MB; evidence ở `docs/generated/schema-change-evidence/20260909172332_reservation_deposit_settlement_v1.json`. Không sửa dữ liệu tổ chức thật và không backfill cọc cũ.
- Catalog sau apply: `f70937dcaf8f4f6ba935c8a7f4251fab32bbd2ca59ce2c7d3ca966f837dc2652`; canonical types và manifest bề mặt sinh lại từ database thật.
- Sau apply: `gate:stable-fn-locks`, `gate:definer-acl`, `gate:approver-provenance`, `catalog:check`, `gate:realtime-descriptors` đều đạt. Đối soát V2 khớp 20 sổ thực và 3.434 dòng posting qua 4 trang. Không đưa số tiền công ty vào tài liệu kiểm thử.
- `gate:sandbox-leak` đạt: 146 bảng đọc được, rò rỉ 0; 18 bảng còn lại không cấp SELECT. Số liệu công ty thật không đổi giữa hai snapshot. Baseline được chụp sau migration, nên không dùng nó để khẳng định số liệu trước migration.
- External controls đã kiểm bằng API: cả app và docs theo nhánh `production`; GitHub private Free không có branch protection như giới hạn đã khai trong Contract.
- App chưa được promote. Bản web hiện hành vẫn là bản trước tính năng này; PR nháp cần duyệt theo ngoại lệ thay đổi tiền trong AGENTS.md.
