# Bằng chứng triển khai xử lý bỏ cọc giữ chỗ

Trạng thái: tính năng ban đầu phát hành tại `90d89b2829bf65391b1def4e2b19c2e5dfac04e6`; phần bổ sung người xử lý, ghi chú trực tiếp và chứng từ hoàn tiền đã phát hành tại `045830ee86d29c660a8162b0a88891de47567189`. Browser production và đối soát sau mỗi lần phát hành đều đạt, dữ liệu thử đã dọn. Ngoại lệ migration ban đầu đã áp được ghi riêng bên dưới, không coi là idempotent PASS.

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
- Bộ ba ca DEMO Realtime / báo cáo / mất response chạy lại cùng lượt đạt **3/3 trong 1 phút**. Bộ `.e2e-fleet/specs/reservation-contract-recovery.spec.ts` đạt **2/2 trong 23,3 giây**: form hợp đồng đang mở gặp source đã settle thì server chặn, UI chờ tải lại cọc rồi giữ nguyên ghi chú đang nhập; tài khoản kế toán DEMO thiếu quyền không thấy nút xử lý. Đã kiểm lỗi console mong đợi của lần server từ chối, không có lỗi khác.
- Trước phát hành: `gate:truoc-push` **42/42 đạt trong 100 giây**, lint 0 lỗi mới, `docs:check:links` **260 file / 0 lỗi**. Catalog, stable-fn-locks, definer-acl và view-invoker chạy lại đều đạt; **12/12 view** có security_invoker.

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
- Đối soát cuối sau toàn bộ ca DEMO: V1 **PASS**, ba nguồn SQL/RPC dưới RLS/phân trang khớp trên **1.068 dòng**; V2 **PASS**, **20 sổ thực / 3.435 posting lines**. Đây là lần đo mới, không thay số liệu lịch sử sau migration. Kiểm cleanup độc lập trả **0 phòng / 0 phiếu** mang marker fixture; trigger sở hữu vẫn `ENABLE ALWAYS`.
- `gate:sandbox-leak` đạt: 146 bảng đọc được, rò rỉ 0; 18 bảng còn lại không cấp SELECT. Số liệu công ty thật không đổi giữa hai snapshot. Baseline được chụp sau migration, nên không dùng nó để khẳng định số liệu trước migration.
- External controls đã kiểm bằng API: cả app và docs theo nhánh `production`; GitHub private Free không có branch protection như giới hạn đã khai trong Contract.
- PR #57 và bản sửa quy trình phát hành #58 đã gộp sau review độc lập. Người dùng đã cho phép đưa lên production; việc promote và kiểm tra đúng SHA trên domain production đã hoàn tất, xem bằng chứng cuối dưới đây.

## Lỗi phát hành phát hiện trên main

PR #57 gộp vào `0364a6a825c1a4db68b2a8c2be27c7ec56e4f3f1`. CI `34394725428`, job `102611509728` chặn tại idempotency: chạy lại migration đã áp ném `42P07`, bảng `reservation_deposit_settlements` đã tồn tại. Đây là lỗi migration thật đã bỏ sót trước apply, không phải lỗi giả của CI. Production giữ bản cũ trong lúc xử lý.

Giữ nguyên file SQL và digest đã áp. Theo tiền lệ lỗi lịch sử bất biến trong migration-policy, ghi ngoại lệ ghim filename, SHA-256, lỗi SQL cụ thể và evidence có backup; kết quả phải là **EXEMPT**, không phải chứng minh raw migration chạy lặp được. Lỗi khác, digest khác hoặc bằng chứng không khớp vẫn chặn. Gate phải kiểm ngoại lệ này cả khi diff không thêm migration và không được lấy cache để che lỗi mới.

Không chạy lại file đã áp, không sửa cutoff hoặc ledger. Phục hồi từ baseline chưa có tính năng cần quy trình phục hồi một lần được review riêng; lane thông thường sau khi siết sẽ từ chối file này ngay cả trên baseline sạch. Trường hợp không chắc commit đã xảy ra phải đối chiếu catalog/biên nhận. Lần sửa SQL tiếp theo dùng migration mới. Lane apply được bổ sung kiểm hai lượt ROLLBACK trước khi áp và không nhận ngoại lệ ở chốt này, để lỗi tương tự không được đưa vào lịch sử mới.

Sửa chốt đã được review độc lập tại `2033544967d68b91bd68a53ef4180e7231f6d832` (tích hợp thành `899f847c`): Vitest **31/31**, Node authorization/transaction **18/18** đạt. Đo scoped trên database thật với diff thêm **0 migration** vẫn kiểm lại đúng file và trả **0 idempotent PASS / 1 EXEMPT**; không dựa vào cache. Chốt trước apply thử riêng cùng file trả HTTP 400/42P07 và chỉ gửi transaction ROLLBACK, chứng minh ngoại lệ không cho phép re-apply. Không apply SQL trong đợt sửa này, digest migration giữ nguyên.

## Xác minh production

- Commit tính năng phát hành: `90d89b2829bf65391b1def4e2b19c2e5dfac04e6`, sau PR #57/#58. Cổng promote đã kiểm **12 job / 111 bước**, không có bước fail bị `continue-on-error` che, rồi fast-forward nhánh production.
- [CI main 34396714392](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34396714392) **SUCCESS**: Vitest **467 file / 7.291 ca**, Node **620/620**; quality, strict, timezone, secret, realtime, types, security và cách ly tenant đạt. Restore drill main `34396714303` đạt. Job reconcile trên CI được bỏ qua vì thiếu test credentials của workflow; đối soát V1/V2 thực tế tại máy trước và sau phát hành đều đạt, không tính job bị bỏ qua là đã chạy.
- Vercel deployment `dpl_6oBCPsch4wy7QJYdrWFeb5tped3m` **READY**, branch production, đúng SHA trên. Domain kiểm: [ptcrm.vercel.app](https://ptcrm.vercel.app). Cả app và docs vẫn theo nhánh production; hai preview trước promote đã đạt.
- Browser headless trên domain production, đăng nhập DEMO với `FLEET_EXPECT_BUILD_SHA` đúng SHA: **6/6 trong 1,8 phút**. Bao gồm form hợp đồng cũ, người thiếu quyền, ledger/preview/cancel, hai client Realtime, báo cáo KQKD/cashflow đúng kỳ và mất response sau commit rồi tải lại.
- Sau browser: cleanup độc lập **0 phòng / 0 phiếu fixture**, trigger sở hữu vẫn `ENABLE ALWAYS`; reconcile V1/V2 **PASS**, sandbox **PASS**, số liệu công ty thật không xê dịch so với snapshot. CI production `34397369973` và restore drill production `34397370023` đều **SUCCESS**.
- Bản cập nhật checklist/biên bản sau phát hành chỉ thay tài liệu trong `docs/superpowers/`, không thay mã ứng dụng hoặc schema đã được kiểm trên production.

## Bổ sung người xử lý và chứng từ hoàn tiền — 10/09/2026

Phiếu phát sinh điền người tạo từ người thực hiện. Phiếu cũ thiếu tên đọc bổ sung theo user_id; không backfill phiếu thật. Chi tiết phiếu thu, cả desktop/mobile/trang riêng, hiển thị “Khách đã bỏ cọc”, số giữ thành doanh thu, số đã hoàn/còn phải hoàn, ngày, người, lý do và ảnh trên các phiếu hoàn liên quan. Ảnh phiếu đã hoàn tác được phân biệt rõ.

- [PR #59](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/59) đã merge. Ảnh được chọn/kéo/dán khi hoàn ngay hoặc trả khoản hoàn sau; form khóa khi tải/ghi. Lưu tham chiếu ảnh cùng transaction của phiếu chi; xác minh đối tượng Storage thật và gắn đúng tổ chức để nhân viên khác xem được. Không giả lập file hoặc chuyển ảnh đã thuộc tổ chức khác.
- Migration `20260910015750_reservation_refund_evidence_and_creator_v1.sql`, SHA256 `91bf3d5206d8159b12855f8b2f438f85eb5d4fc42280c1736e8243cfa56daa51`, áp dụng `2026-09-10T02:29:36.055Z` qua lane sau hai lượt ROLLBACK và backup 523 bảng / 27,8 MB; receipt `97b3a862c0a88191`. Catalog đổi `f70937dcaf8f…` → `1c43f99ca352…`. File này đã áp dụng và là lịch sử bất biến.
- SQL trong root: **50/50**; có storage objects thật, role nhân viên thứ hai, khác tổ chức, rollback, retry, tiền/phòng/hợp đồng và concurrency. Review độc lập backend/frontend đạt; đột biến chứng minh phát hiện mất ảnh/tên, bỏ binding, bỏ kiểm quyền sở hữu và chiếm link khác tổ chức.
- Browser phát hiện checkbox trong dialog portal đóng cả chi tiết mobile. Đã tái hiện đỏ, sửa chỉ đóng khi chạm trực tiếp nền và chạy lại xanh. Local app + DEMO thật **2/2**; preview đúng SHA `82510478` **2/2** (27,6 giây), kể cả kế toán khác ký URL và hiển thị ảnh riêng tư.
- Restore harness bổ sung metadata Storage của nền tảng, FK gốc và RLS đóng; không nới quyền hoặc sửa SQL đã áp. Test thật **1/1**, unit liên quan **22/22**, đột biến FK/RLS bị phát hiện. Dựng lại toàn bộ **209 file: 173 sạch / 36 dừng đúng kỳ vọng / 0 lệch**; kiểm bảo mật sau restore đạt. CI PostgreSQL 17.6 xác nhận sau kiểm local PostgreSQL 17.10.
- [CI main 34431457696](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34431457696) SUCCESS: **469 file / 7.299 Vitest, 620 Node tests**. Strict, timezone, Realtime, types, security, tenant isolation và secret scan đạt; restore `34431457578` và migration validation `34431457618` đạt. Job reconcile CI bị bỏ qua do thiếu credentials; đối soát V1/V2 thực tế tại máy trước và sau release đều đạt, không tính job bỏ qua là đã chạy.
- Cổng promote kiểm **13 job / 123 bước**, không có lỗi bị `continue-on-error` che. Vercel `dpl_HtRyBa2wv3t84KCgfKM9wDYKLWJy` READY từ production tại `045830ee86d29c660a8162b0a88891de47567189`. Public [ptcrm.vercel.app](https://ptcrm.vercel.app) E2E headless với đúng build SHA: **2/2 trong 36,5 giây**, desktop/một phần và mobile/toàn bộ, ảnh ở cả hai phiếu, creator và nhân viên khác xem ảnh.
- Sau release: reconcile V1/V2, sandbox đều đạt; cleanup độc lập **0 phòng / 0 phiếu / 0 file Storage / 0 link Storage** fixture, ownership guard vẫn ENABLE ALWAYS. CI production `34431998373` và restore `34431998350` SUCCESS. Các tiến trình Vite/PostgreSQL do task mở đã dừng, giữ nguyên dữ liệu và bằng chứng trên đĩa.
