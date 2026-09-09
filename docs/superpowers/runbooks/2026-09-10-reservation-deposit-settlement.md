# Bằng chứng triển khai xử lý bỏ cọc giữ chỗ

Trạng thái: đã áp schema qua lane có backup; đang kiểm tra giao diện, chưa phát hành app.

## Phạm vi và căn cứ

- Thiết kế: `docs/superpowers/specs/2026-09-10-reservation-deposit-settlement-design.md`.
- Base khảo sát triển khai: `30d086750b5e1ca6980b877a8be7eabc88091ca5`.
- Đã đọc catalog live của 37 hàm nguồn cùng các helper Finance V2; chỉ truy vấn đọc. Graph được refresh và kiểm freshness trước impact của hai hook cọc.
- Dùng lõi `finance_v2_post_voucher_with_source_v1` cho chi thật, không giả provenance hoặc bỏ ranh giới commit của phiếu thủ công. Reversal giữ RPC tài chính hiện hành và kiểm lại quyền trước replay đối với nguồn mới.
- Hạng mục thu chi dùng `PNL` cho doanh thu; từ REVENUE trong thiết kế là khái niệm nghiệp vụ, không phải giá trị hợp lệ của `income_expense_items.accounting_class`.
- Khóa 24h không có FK hoặc audit liên kết phiếu nguồn. Giữ khóa chưa xác định được và trả `UNRELATED_HOLD`, không hủy theo phòng/số tiền.

## Kiểm thử đang thực hiện

- PostgreSQL 17 riêng trên loopback; phục hồi schema, chỉ nạp phạm vi DEMO và quyền cần cho fixtures. Không nạp dữ liệu sổ sách của tổ chức thật. Extension vector/cron/vault không có ở máy; các bảng và hàm của luồng tiền đã dựng và chạy được.
- Migration được áp từ đầu trên database thử mới, không chỉ thay lẻ hàm. Ca thành công ép kiểm FK hoãn trước khi rollback. Ca đồng thời dùng database thử riêng rồi dọn cả database.
- Đã chứng minh bỏ toàn bộ không đổi quỹ; partial NOW/LATER và full refund; nguồn trộn chỉ dùng phần cọc; không nhận tiền chưa posting hoặc đã đảo; replay; kỳ khóa; sổ ảo; thiếu quyền; bảo vệ phiếu nguồn và loại cọc; đảo/hoàn lại; phòng còn cọc hoặc hold; explicit/legacy contract.
- Suite SQL hiện đạt **33/33 ca** (41,25 giây), gồm role authenticated và kiểm private helper/DML bị chặn. Hai settlement đồng thời và hai lần chi đồng thời chỉ tạo một kết quả. Cạnh tranh tạo hợp đồng với settlement chỉ có một bên tiêu dùng cọc.
- Kiểm tổng và phân trang trên 1.105 hồ sơ chờ hoàn, có tra cứu trực tiếp theo phiếu nguồn.
- PostgREST **14.17** thật trên loopback đạt **1/1 ca HTTP**: FK embed chỉ rõ nguồn, anti-join trước/sau settlement, history 1:1, preview, settlement, summary/list ở transaction đọc, hoàn tiền và actor thiếu quyền. Chỉ dùng JWT ký riêng cho server thử; không dùng token này trên môi trường dùng chung.
- Ba đột biến **bảo vệ phiếu nguồn / chia số giữ lại / kiểm quyền** đều làm đúng test đỏ; đã khôi phục SHA-256 migration về tiền tố `32008e7d10b7`. Công cụ `scripts/dot-bien.mjs` trả 0 cả ba lần.
- `migrate:forward` dry-run trên catalog dùng chung đạt, đã ROLLBACK (1 giây), sau đó apply thành công bằng chính migration đã review.
- Build đầu tiên sau cài dependency riêng: 4.798 module, bundle thành công. Typecheck baseline giao diện lần sửa đầu không thêm fingerprint. Gate strict và thử trình duyệt sau đó phát hiện truy vấn cột không tồn tại / history chưa cập nhật; đang sửa, không coi kết quả cũ là kiểm chứng bản cuối.

## Review độc lập

Đã sửa các phát hiện: cọc nguồn lẻ VND bị làm tròn; thứ tự khóa tổ chức/phòng; bỏ sót hold APPROVED; quyền chi trên NOW replay; ngày chi NOW bị gắn với ngày doanh thu. Reviewer độc lập xác nhận không còn blocker tiền/quyền trong migration tại SHA `39744488f131eb8c5d1f50322192524cc837840a`, digest `32008e7d10b730ceef4840fb307288e033be5d868842597ed30f27136e6da2e6`.

Review giao diện tìm thêm lỗi truy vấn cột tính toán như cột thật và mất context của Supabase client; đã tái hiện HTTP 400 bằng trình duyệt đăng nhập DEMO. Các phát hiện này phải được sửa và chạy lại trước phát hành. Kiểm thử tương tác Vitest dùng jsdom không được gọi là E2E trình duyệt.

## Phát hành

- Schema đã apply lúc `2026-09-09T17:56:14.163Z` qua `npm run migrate:forward ... --apply`, biên nhận backup `16d825b80277f7e4`. Backup đầy đủ 519 bảng có dữ liệu, 27,8 MB; evidence ở `docs/generated/schema-change-evidence/20260909172332_reservation_deposit_settlement_v1.json`. Không sửa dữ liệu tổ chức thật và không backfill cọc cũ.
- Catalog sau apply: `f70937dcaf8f4f6ba935c8a7f4251fab32bbd2ca59ce2c7d3ca966f837dc2652`; canonical types và manifest bề mặt sinh lại từ database thật.
- Sau apply: `gate:stable-fn-locks`, `gate:definer-acl`, `gate:approver-provenance`, `catalog:check`, `gate:realtime-descriptors` đều đạt. Đối soát V2 khớp 20 sổ thực và 3.434 dòng posting qua 4 trang. Không đưa số tiền công ty vào tài liệu kiểm thử.
- Phép đo sandbox đọc được 146 bảng, rò rỉ 0; 18 bảng còn lại không cấp SELECT. Lượt đầu thiếu snapshot before nên exit 1, không được gọi là pass. Đã chụp baseline sau migration riêng để so trước/sau kiểm tra giao diện; baseline đó không phải bằng chứng trước migration.
- External controls đã kiểm bằng API: cả app và docs theo nhánh `production`; GitHub private Free không có branch protection như giới hạn đã khai trong Contract.
- Chưa mở PR hoặc promote app. Bản web hiện hành vẫn là bản trước tính năng này.
