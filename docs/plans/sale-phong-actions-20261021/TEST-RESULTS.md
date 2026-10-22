# Biên bản kiểm Sale Phòng, cọc/lock và Hermes

Hồ sơ dưới đây là kết quả audit trước triển khai. Bản hiện đã làm nằm trong [kết quả triển khai](IMPLEMENTATION-RESULTS.md) và [kiểm chứng local](FINAL-VALIDATION.md).

Ngày: 21/10/2026 (+07). Source: `c095d427eda5078c422c3c529ae1f1329807bb63`.

Worktree: `C:/Users/Nguyen Tam/codex-worktrees/sale-phong-action-audit-20261021`.

Đây là kiểm phục vụ lập kế hoạch, không phải chứng nhận sẵn sàng phát hành. Source sản phẩm không thay đổi; chỉ có tài liệu/probe/evidence mới trong thư mục này. Checkout chính và WIP được giữ nguyên.

## 1. Bộ kiểm có sẵn đã chạy

### Web, nghiệp vụ và worker

- Danh sách đầu vào: [app-test-selection.json](evidence/app-test-selection.json); 40 đối số thư mục/tệp thu được **62 tệp kiểm**.
- Phạm vi: sale-phong/phong-trong, public/pass/ảnh/settings/receipts, cọc/lock/identity/hold/settlement, form tiền, migration/PGlite, room facts, worker automation/lifecycle/render parity.
- Runtime chính: Node **24.19.0**, Vitest **4.0.18**, tối đa hai worker.
- Kết quả lần gom: **798 ca, 797 đạt, 1 lỗi, 0 bỏ qua**. JSON có số suite tính cả nhóm lồng nhau; không dùng số suite đó làm số tệp.
- Evidence: [app-tests.json](evidence/app-tests.json). Tham chiếu log local không đính kèm: `evidence/app-tests.log`.

Ca lỗi: `bảng reservation_hold_deadlines có migration tạo bảng`, trong `src/lib/__tests__/reservationHoldDeadlineMigration.test.ts`; duration `5707.1151ms`. Reporter chỉ ghi `STACK_TRACE_ERROR`, không cho thông báo assertion/nguyên nhân đủ rõ.

Chạy lại **riêng tệp đó, source không đổi, một worker**: **21/21 đạt**, tổng khoảng 475ms. Tham chiếu log local không đính kèm: `evidence/deadline-test-rerun.log`.

Giới hạn kết luận: lỗi lần gom không tái hiện khi tách tệp; có khả năng phụ thuộc tải/môi trường nhưng **chưa chứng minh nguyên nhân**. Giữ nguyên cả hai kết quả. Không báo lần gom là 798/798 đạt, không tăng timeout hoặc sửa test để che lỗi.

### Hermes

- Danh sách: [hermes-test-selection.json](evidence/hermes-test-selection.json), **26 tệp**.
- Node native test runner, concurrency 2, TAP reporter.
- Phạm vi: room-pass contract/core/upsert/mutation/composition/SQL, room read/projection/parity, broadcast, public text guard, quyền/cache admission, broker/server/arguments, requestId, nhóm gửi và reader cọc/quỹ.
- Kết quả: **356/356 đạt**, 0 fail/cancelled/skipped/todo, khoảng 68 giây.
- Evidence: [hermes-tests.tap](evidence/hermes-tests.tap).

Tổng số ca có sẵn là **1.154** (798 + 356). Không cộng 21 ca chạy lại hoặc các lần fixture lỗi vào coverage này.

### Kiểm bổ trợ

| Phép kiểm | Kết quả | Evidence |
|---|---|---|
| TypeScript baseline | Đạt, 0 fingerprint | Log local không đính kèm: `evidence/typecheck.log` |
| Hermes–web parity guard | Đạt, 72 mục: 24 RPC + 48 mirrored; 89 vùng web; 35 nguồn SQL | Log local không đính kèm: `evidence/hermes-web-parity.log` |

Guard parity xác minh registry/cấu trúc đối chiếu; không đồng nghĩa Hermes đã có mọi thao tác web.

## 2. Probe mới để kiểm giả thuyết lỗi

| Probe | Số ca | Hiện tượng xác nhận | Giới hạn |
|---|---:|---|---|
| Pass scope | 1 kịch bản có 3 đối chứng | Actor chỉ tòa A dùng ID listing B và room A vẫn đổi listing B; đọc trực tiếp/ghi trực tiếp/target B bị chặn trong fixture | Primitive quyền/danh tính giả; thân writer/guard/org-trigger lấy source |
| Kỳ hạn tạo hồ sơ | 1 | Reservation có kỳ hạn nhưng bảng kỳ hạn theo phiếu nguồn trả NULL | PGlite, money writer stub |
| Kỳ hạn sửa hồ sơ | 1 | Sửa hạn reservation không đổi hạn phiếu | PGlite |
| Quyền RPC kỳ hạn | 1 | Helper action deny nhưng scope allow, thân RPC vẫn ghi | Không phải test JWT thật |
| Cọc bổ sung pending | 1 | Phiếu chưa duyệt làm mất cảnh báo thiếu của phiếu gốc | Chạy hàm TypeScript mã sản phẩm cục bộ với dữ liệu giả; không chứng minh vượt guard ký |
| Policy pass | 2 | Một ca lệch bảng/tin chữ và một đối chứng có saleNote | Hàm export mã sản phẩm cục bộ, mock canvas/I/O; chưa render/gửi thật |

**Tổng 7 ca cuối đã xác nhận được điều đang kiểm.** Các probe kỳ vọng hiện tượng lỗi xảy ra, vì vậy “pass” ở đây không có nghĩa sản phẩm đã đúng.

Evidence:

- [Pass scope input/chương trình](proofs/pass-listing-scope.mjs), [kết quả](proofs/pass-listing-scope-result.json).
- [Probe cọc/lock lưu trữ](deposit-lock-probe.proof.ts), [bản kết quả cuối 4/4](deposit-lock-probe-final-results.json).
- [Pass policy](proofs/pass-policy.proof.mjs), [quan sát và hash source](proofs/pass-policy-observations.json), [kết quả 2/2](proofs/pass-policy-vitest-result.json).

Các lần đầu xây probe cọc có lỗi fixture: stub/helper thiếu và alias SQL. Đã sửa **fixture**, giữ report cũ để phân biệt, chạy bản cuối 4/4. Không lấy lỗi fixture làm lỗi sản phẩm. Một số proof dùng Node 22.20.0; bộ chính dùng 24.19.0. CI được ghim 24.18.0 nên bằng chứng này chưa thay receipt CI phát hành.

## 3. Database đích: chỉ đọc catalog

Đã chạy [truy vấn SELECT](evidence/live-function-audit.sql) lấy definition/signature/security-definer của bốn hàm, không ghi bảng nghiệp vụ:

- `upsert_room_pass_listing`
- `create_room_reservation_v1`
- `update_room_reservation_v1`
- `set_reservation_hold_terms_v1`

**Bốn thân hàm khớp source** sau chuẩn hóa CRLF/LF. Cả bốn catalog ghi nhận SECURITY DEFINER.

Evidence: [catalog](evidence/live-function-audit.json), [đối chiếu](evidence/live-function-comparison.md), [đối chiếu máy đọc](evidence/live-function-comparison.json).

Phạm vi xác minh chỉ là bốn body và metadata được chọn. Chưa đối chiếu toàn bộ helpers/triggers/ACL/schema deployed, chưa thử thay đổi dữ liệu hoặc hành động sai quyền trên tổ chức thật. Kết luận source-level được củng cố ở body deployed, không suy thành khai thác production đã xảy ra.

## 4. Kiểm UI thật chỉ đọc

Đã mở Chrome với phiên đăng nhập hiện có, vào `https://ptcrm.vercel.app/sale-phong`:

| Màn | Quan sát |
|---|---|
| Link chia sẻ | Danh sách hiển thị; có một nhãn lỗi ký tự như ảnh người dùng. Chưa xác định nguồn lỗi của trường này |
| Cài đặt hiển thị | Form hiện; thấy mô tả sắp trống và cảnh báo công tắc đã thuê chưa áp dụng |
| Thông tin sale | Bộ chọn tòa/phòng và giao diện tải được |
| Khách nhờ sale | Dữ liệu/form tải; mở “Thêm phòng pass”, kiểm trường, bấm Hủy; không lưu |
| Sơ đồ tòa nhà | Màn chọn tòa tải; chưa thao tác chỉnh/lưu sơ đồ |
| Thống kê | Màn thống kê tải |
| Public `/r/demo` | Danh sách phòng public tải và đọc được; tên token không chứng minh đây là org DEMO |

Không thấy console error của app trong các lần lấy log; có cảnh báo extension trình duyệt được phân biệt riêng. Đây không phải kiểm toàn bộ lỗi frontend.

Đã bấm xuất ảnh public để thử nhận file; công cụ chờ download timeout và không thu được receipt/path tệp. **Chưa xác minh file ảnh xuất**, không kết luận tính năng hỏng. Các kiểm renderer/export dạng unit được ghi trong bộ chính.

Thử viewport public hẹp có hiển thị được giao diện; viewport admin quan sát vẫn khoảng 1015 × 956 nên **không chứng nhận mobile admin**. Đã reset viewport. Chưa kiểm tất cả thao tác/scroll/modal trên thiết bị thật.

Không lưu screenshot hoặc DOM chứa thông tin khách, số điện thoại, số tiền của tổ chức vào tài liệu; chỉ ghi quan sát đã lược thông tin riêng. Không tạo/cọc/lock/pass/sửa giá/ảnh/link, không gửi tin thật.

## 5. Phần chưa chạy hoặc chưa xác minh

- PostgreSQL với nhiều connection để thử race/deadlock. Docker có lệnh nhưng daemon không chạy/không truy cập được; không có môi trường DB dùng thử đã xác nhận trong lần kiểm này.
- JWT/PostgREST/RLS/ACL end-to-end, ma trận vai trò/tòa/quỹ/tổ chức thật.
- UI E2E ghi dữ liệu, Hermes commit live, full refresh/logout/recovery trong các vai khác nhau.
- Upload/storage/attach/download đầu cuối, file ảnh export, ảnh/album Zalo thật.
- Gửi provider, webhook/echo nếu có, mất ACK sau gửi, finalize DB lỗi, restart worker khi gửi dở.
- Cân sổ/hoàn tiền/ngân hàng/chứng từ thật. Probe money writer có stub.
- Hiệu năng, độ trễ realtime/polling, nhiều người cùng sửa, thiết bị mobile đầy đủ.
- Frontend deployed SHA chưa được xác định; không gộp quan sát UI thành bằng chứng frontend chính xác cùng SHA source.
- Build/CI toàn repository không chạy cho thay đổi chỉ tài liệu. Khi hiện thực cần chọn gate theo Contract và diff cuối.

Các phần này có checklist và điều kiện hoàn thành trong G8 của [PLAN](PLAN.md). Không báo “đã test toàn bộ hệ thống” từ tập kiểm có chọn phạm vi.

## 6. Cách tái dùng kết quả

Giữ kết quả khi source/đầu vào liên quan không đổi. Khi sửa các lỗi, chuyển probe thành regression kỳ vọng đúng ở vị trí test của domain, không tự nhập cả thư mục audit vào suite sản phẩm. Chỉ chạy lại tập bị ảnh hưởng và các gate do Contract/test matrix yêu cầu.

Các tệp proof/evidence hiện tại là tài liệu làm việc trong worktree audit, chưa commit/push. Khi lập PR thực thi, chỉ đưa artifact phù hợp vào diff và kiểm nội dung trước khi chia sẻ.
