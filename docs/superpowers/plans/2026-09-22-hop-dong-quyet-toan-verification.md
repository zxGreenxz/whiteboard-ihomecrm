# Kiểm chứng Hợp đồng & quyết toán

Phạm vi: màn Hợp đồng & quyết toán trong `/thanh-toan`, hai tab và hai modal. Base `2932d65fa520194d471c37485cc5edd93c3b3df6`. Không thay schema, công thức tiền hay RPC writer.

## Thay đổi

- Đọc các nhánh phiếu độc lập song song, khử trùng trước hydrate, chia lô UUID và giới hạn 4 lượt đọc. Cache căn cứ theo từng kỳ ký; dùng chung raw cache current/all. Giữ lọc đã chi theo ngày ghi sổ.
- Chỉ tải Biến động khi mở, đọc đủ từng trang theo ngày + id, hiển thị 50 dòng/trang; tìm kiếm/tổng trên tập đầy đủ. Hai modal lazy; khoản chi liên quan theo hợp đồng và mở phiếu bằng UUID riêng.
- Phân biệt loading/error/empty ở nguồn bắt buộc; giữ dữ liệu cơ bản trong khi đối chiếu; khóa duyệt/chi khi nguồn đang tải, refetch hoặc lỗi. Hoãn dữ liệu phí chưa dùng, giữ menu/badge và chờ dữ liệu đầy đủ khi chuyển lại mục phí.
- Chỉ thanh lý APPROVED/COMPLETED có hiệu lực; thiếu hồ sơ/số tiền không thành 0. Nhãn công nợ đưa vào quyết toán giữ số nguồn. Tổng còn chi loại phiếu hủy, hoàn tác, không ghi quỹ và tách chưa xác minh.
- Mỗi yêu cầu bổ sung/hoàn tất có khóa riêng; retry cùng lệnh giữ khóa; kết quả async chỉ tác động phiên phiếu đã phát lệnh. Bỏ khối Ghi chú gốc của phiếu, giữ notes DB, căn cứ và lịch sử bổ sung.
- Realtime gộp các bảng cùng đợt, làm mới cả raw/lifecycle và hai RPC facts của modal. Queries được làm mới khi quay lại cửa sổ nếu stale.

## Bằng chứng

- 19 file / **538 test liên quan đạt**. Các test hồi quy bao phủ status thanh lý, dữ liệu >400/200 dòng, bộ lọc kỳ/ngày ghi sổ, nguồn chậm/lỗi, cache/refetch, UUID, hai thao tác bổ sung liên tiếp và đổi phiếu giữa lúc gửi. Sau refactor envelope nguồn segments, 23 test lifecycle được chạy lại và đạt.
- Test đột biến bắt được các invariant tiền, cách ly org, concurrency và readiness; digest được khôi phục. Các biến thể gồm ép expected/refund thiếu thành 0, bỏ org khỏi key, tăng concurrency quá 4, bỏ guard source/refetch, coi mọi trạng thái thanh lý có hiệu lực và cộng phiếu hủy/hoàn tác vào tổng chưa xử lý.
- Reconcile v1: 1.160 phiếu, SQL = RPC/JWT/RLS = phân trang: 5.772.039.013 VND.
- Reconcile v2: 20 sổ thực khớp; 3.686 dòng posting qua 4 trang khớp SQL: 3.160.517.099 VND.
- E2E đọc trên local bằng DEMO chủ nhà/kế toán: mở màn, đổi tab/kỳ, mở modal; không lỗi app console.
- E2E ghi DEMO bằng fixture riêng: request → done → request, 3 UUID idempotency khác nhau, đúng voucher UUID, 3 note chính xác trong DB. Phiên chủ nhà độc lập nhận đủ realtime, snapshot tài chính không đổi, console sạch, fixture đã dọn. Không kiểm ghi tiền thật trong E2E này.
- Typecheck app theo baseline và E2E đạt; strict islands và lint baseline đạt. Build cuối đạt (38,28 giây); gate bundle đạt: 534 chunk, entry 233 kB, 97 trang lazy. Hai modal có dynamic entry riêng.
- `gate:truoc-push` đầy đủ đạt **44/44 gate trong 315 giây**, gồm đo rò chéo tổ chức; không bỏ nhóm strict/lint hoặc bước đo. `docs:check` đạt sau khi ghi rõ liên kết audit cũ là artifact local chưa nằm trong Git. Lượt gate đầu bắt lỗi cấu trúc return rỗng của nguồn segments; đã chuyển sang envelope rõ trạng thái và chạy lại toàn gate đạt.
- Review độc lập đã xử lý lỗi cache stale, guard realtime, lỗi nguồn tòa, chunk modal, nguồn phí mới bật và invalidation facts.

## Số đo trước/sau

Headless Chromium, cùng DEMO chủ nhà và dữ liệu, 3 lượt/bản, mỗi lượt context lạnh. Before là artifact SHA nêu trên; after là snapshot build local sau các sửa chức năng, trước refactor envelope segments. Cùng hồ sơ biến động và cùng UUID phiếu được kiểm bằng hash. Chỉ đọc; 6/6 lượt hoàn tất, không console/page/request error. Thời gian median dưới đây tính từ thao tác tới UI và các request đã hoàn tất, có cửa sổ yên mạng 500 ms khi có request; không phải LCP hoặc p95.

| Thao tác | Trước → sau | Request nghiệp vụ trước → sau |
|---|---:|---:|
| Mở Hợp đồng & quyết toán | 3,200 → 2,621 giây | 16 → 9 |
| Quay lại màn | 95 → 114 ms | 0 → 0 |
| Mở tab Biến động | 43 → 794 ms | 0 → 4 |
| Biến động sang Mọi kỳ | 1,298 → 1,601 giây | 5 → 7 |
| Mở cùng modal biến động | 1,814 → 1,442 giây | 8 → 12 |
| Đổi kỳ Khoản chi | 1,798 → 0,954 giây | 12 → 5 |
| Khoản chi sang Mọi kỳ | 1,810 giây → 28 ms | 7 → 0 |
| Mở cùng modal phiếu | 2,377 → 2,983 giây | 14 → 21 |

- Mở màn giảm 43,8% request và 18,1% thời gian quan sát; đổi kỳ giảm 58,3% request. Tab Biến động và modal nay trả chi phí đọc khi người dùng mở; modal phiếu tăng khoảng 0,6 giây do đọc mục tiêu/xác minh riêng và tải chunk. Không phải mọi thao tác đều nhanh hơn.
- JS response body lúc vào trang lạnh: 440.424 → 427.954 byte (−2,8%). Khi mở cả hai modal, JS toàn chuỗi: 440.424 → 452.818 byte; request nghiệp vụ toàn chuỗi 80 → 77, body nghiệp vụ median 102.252 → 96.424 byte.
- Đo trên máy phát triển gọi Supabase thật, không throttle, dữ liệu DEMO nhỏ; không suy ra tốc độ của org thật hoặc mạng/thiết bị yếu. Log đã khử dữ liệu nhạy cảm và báo cáo đầy đủ lưu local trong `.superpowers/sdd/2026-09-22-toi-uu-hop-dong-quyet-toan/`.

## Giới hạn

- E2E và đo tốc độ dùng bản build/local cùng tài khoản DEMO, không phải thời gian tải production sau phát hành. Số đo HTTP ban đầu trên org thật chỉ là một lượt read qua JWT/RLS.
- Một số nguồn chưa thuộc publication realtime (extensions, holds, deposit links, postings và cấu hình loại phí). Không đổi schema; quay lại cửa sổ khi cache stale/Thử lại sẽ đọc mới. Không cam kết nhận sự kiện trực tiếp của bảng chưa publish.
- Helper supplements dùng chung chưa nhận AbortSignal cho HTTP đã bắt đầu; job giữ slot tới khi xong và QueryClient bỏ kết quả đã hủy. Queue chưa chạy được hủy sạch.
- Desktop hiện có; không xây mobile mới. Chưa phát hành production.
