# Bổ sung chứng từ / ghi chú cho phiếu thu chi

## Hành vi

Admin, người lập phiếu và người có quyền sửa thu chi thấy nút **Bổ sung chứng từ / ghi chú**, biểu tượng `FilePlus2`, độc lập với nút sửa. Nút có trên danh sách desktop, chi tiết desktop/mobile và trang chi tiết mở riêng. Form chỉ nhận ảnh mới và ghi chú mới; nội dung đã có chỉ xem. Mỗi lần lưu ghi người thực hiện và thời gian từ máy chủ. Có thể chỉ thêm ảnh hoặc chỉ thêm ghi chú.

Phần bổ sung nằm trong `income_expense_supplements`, không UPDATE `income_expenses`. Ghi chú gốc có các dấu hiệu máy đang đọc bằng so sánh nguyên chuỗi nên không được ghép vào cột gốc. Phần hiển thị ghép nội dung theo thứ tự; các đối tượng được chuyển cho chức năng ghi tiền vẫn giữ nguyên `notes` và `attachments`. Ảnh bổ sung trên phiếu hoàn cọc cũng xuất hiện ở chi tiết xử lý cọc trên phiếu thu ban đầu.

RPC `append_income_expense_supplement_v1` khóa phiếu để kiểm quyền và chống lưu trùng, giữ quyền tổ chức/tòa nhà/hạng mục hạn chế, không phụ thuộc trạng thái tiền hay kỳ khóa sổ. Ảnh bổ sung đã lưu không được thay thế/xóa; quyền đọc ảnh đi theo quyền xem phiếu. Không sửa RPC annotate cũ hoặc các guard tài chính.

## Rà soát độc lập

- Backend: phát hiện và sửa quyền đọc Storage phải đi theo phiếu cha; kiểm tra lại bằng role thật. Kiểm tra hai lượt migration phát hiện lỗi replay, sau đó phát hiện thứ tự constraint phụ thuộc locale. Đã sửa replay với kiểm hình dạng chặt, dùng `COLLATE "C"`; reviewer tái hiện khác biệt locale và chạy lại 2/2 ca replay/drift.
- Giao diện: bổ sung action ở trang chi tiết mở riêng và đổi E2E để người quan sát mở phiếu trước khi lưu. Đã rà soát lại hai sửa đổi. Bản in chờ ảnh tải xong và chỉ tự in một lần.
- Giữ tên RPC literal để công cụ kiểm kê thấy được caller. Một fingerprint mới được ghi nhận trong raw-RPC baseline vì input/output đã kiểm Zod ở lib, tên/tham số có generated types, idempotency và bất biến dữ liệu do server thực thi. Không thêm wrapper che tên RPC.

## Bằng chứng trước phát hành

- SQL loopback trên bản khôi phục: **15/15** ca đạt, gồm phiếu hoàn cọc thực tế bị annotate cũ chặn, quyền theo role, bất biến dữ liệu, Storage, ghi đồng thời và replay. Các mutation về immutability/quyền đọc/schema shape đã tạo lỗi đúng dự kiến rồi khôi phục.
- Vitest theo đúng danh sách runtime của CI, 4 workers: **474 file / 7.317 kiểm thử đạt**. Lượt đầu có ba timeout khi tải cao và một lỗi do types chưa sinh; các ca đã được chạy lại trong toàn bộ lượt xanh này.
- E2E headless DEMO local: **2/2**, desktop và mobile, 56,6 giây. Thêm ảnh + ghi chú, thêm tiếp ghi chú, giữ nội dung gốc, người bổ sung, Admin action, phiếu gốc thấy ảnh hoàn trả, phiên kế toán đang mở tự nhận nội dung mới. So sánh toàn bộ JSON phiếu/items/postings/lines trước–sau không đổi. Fixture và tệp thử được dọn.
- HTTP Storage thực: ký URL/tải/render ảnh thành công sau khi gắn bổ sung; PUT, upsert và DELETE không thay đổi tệp đã lưu; SHA256 trước–sau giống nhau.
- Build đạt; typecheck baseline không có fingerprint mới; lint theo ratchet của CI không có lỗi mới (dọn 10 lỗi cũ). Lệnh lint trần còn nợ có sẵn, không phải cửa CI.
- Đối soát tiền legacy và v2 đạt. Definer ACL không thêm hàm cho anonymous. Snapshot quyền sau thay đổi: **0/147 bảng đọc được rò rỉ TEST**, 18 bảng còn lại bị từ chối SELECT; hai ảnh chụp liên tiếp sau thay đổi giữ nguyên số liệu THẬT. Đây không được trình bày là snapshot trước migration.

Kiểm tra mở rộng `check-ie-guard-gates` còn báo nhánh `STOP_RECURRING` từ trước tính năng này. Hash guard trên bản khôi phục trước bổ sung và máy chủ sau bổ sung đều là `fb01ae8c9de7b283d19ade8195eba726`, cùng không có nhánh đó. Tính năng này không mở flex writer hay sửa guard đó; kiểm tra mở rộng này không thuộc workflow CI bắt buộc và được ghi nhận riêng, không tính là xanh.

## Schema đã áp dụng

Migration `20260910042229_income_expense_supplements_v1.sql`, SHA256 `f9b9cd69b86e0783c3a1de5810e99b4a8881cc1e2bb212bc90dab79542f0864b`, đã đi qua lane được kiểm soát: hai lượt rollback, backup đầy đủ 27,8 MB / 523 mục TABLE DATA, rồi apply lúc `2026-09-10T05:02:14Z`. Biên nhận: [schema-change-evidence](../generated/schema-change-evidence/20260910042229_income_expense_supplements_v1.json). Không backfill hoặc sửa nghiệp vụ tổ chức THẬT.

## Phát hành đã xác minh

- [PR #60](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/60) đã gộp. Commit phát hành `10c48a5a049fbb4fde1c3bfc46bce8305010edc3`; [CI main 34441044387](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34441044387) SUCCESS, không có bước fail bị che. Cổng promote kiểm **11 job / 99 bước** rồi fast-forward production. Hai job skipped là promotion trên main và reconcile thiếu test credentials; không tính chúng là đã chạy. Đối soát tiền đã chạy trực tiếp và đạt.
- Schema không đổi trong commit cuối chỉ sửa test. [Restore drill 34440606907](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34440606907) và [migration validation 34440606902](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34440606902) đã đạt trên commit tính năng `5f91152f`. CI đầu phát hiện mock test chuyển tiếp `.rpc(...args)` bị nhận là caller động; đã thay bằng tham chiếu spy trực tiếp, giữ nguyên mọi kiểm tra runtime.
- Preview đúng SHA cuối **2/2 trong 59,6 giây**. Vercel production `dpl_CFVeKX7HQb9Qc5fp1jS4NqhoTZ6S` READY, branch production, đúng SHA cuối. [Trang đang dùng](https://ptcrm.vercel.app/income-expense) được kiểm tra headless bằng tài khoản DEMO, xác nhận build SHA: **2/2 trong 58,9 giây** (desktop 30,7; mobile 25,8). Bao gồm toàn bộ lưu, đọc lại, người bổ sung, ảnh hai phiếu, realtime, Storage HTTP và so sánh JSON tài chính.
- Kiểm tra cleanup độc lập sau production: **0 phòng / 0 phiếu nguồn / 0 phần bổ sung / 0 file / 0 link Storage** fixture; năm trigger bất biến được kiểm tra vẫn bật. Cổng địa phương 5183 và PostgreSQL 55487 không còn listener, giữ nguyên dữ liệu và bằng chứng trên đĩa.
- Reconcile V1/V2 sau production đều PASS. Snapshot quyền vẫn **0/147 bảng đọc được rò TEST**, 18 bảng bị từ chối SELECT. So với ảnh chụp lúc 05:10Z, dữ liệu vận hành tới 05:38Z có thêm một thanh toán 4.908.000 đồng cùng các dòng liên quan; vì vậy không tuyên bố toàn bộ số liệu THẬT bất biến trong cả khoảng này. Bằng chứng không đổi tiền của thao tác bổ sung là JSON đầy đủ của các phiếu fixture được đối chiếu ngay trước–sau từng lần lưu.
- CI production `34441566106` và restore drill production `34441566149` đều SUCCESS. Bản cập nhật biên bản này chỉ thay tài liệu; bản ứng dụng đã kiểm trên production vẫn là SHA nêu trên.

[Biên bản máy đọc của bản phát hành](../audits/2026-09-10-voucher-supplements-production-release.json).
