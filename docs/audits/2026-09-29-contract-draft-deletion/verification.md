# Xóa hợp đồng nháp

Thêm Xóa nháp tại danh sách, xác nhận tên khách trước khi thực hiện. Dùng quyền `contracts.delete` hiện có theo tòa, giữ nguyên form và nghiệp vụ ký/thu chi. Thành công làm mới danh sách và số lượng trên tab; lỗi giữ hộp xác nhận để đọc và thử lại.

Máy chủ chuyển nháp chưa ký sang `DELETED`, ghi người/thời điểm xóa và giữ phiên bản để đối soát. Chặn bản đã ký, phiên bản cũ và liên kết nhượng còn `LINKED`. Nháp đã xóa không xuất hiện ở danh sách và không thể sửa/ký/xuất/tải bằng cửa sổ cũ. Gọi xóa lại trả thành công, không đổi dấu vết ban đầu.

## Kiểm chứng trước phát hành

- Migration `20260929034044_contract_draft_deletion.sql`, SHA-256 `985e00c18220c41b0b39b01e0476d7edea5ea390a45271566b2becec57111505`: áp hai lần trong TEST rollback đạt.
- RPC chạy dưới role authenticated: xóa/lặp lại, sai tổ chức, thiếu thành viên, anon, stale revision, signed, active transfer link; chặn save/replay/export và Storage sau xóa. Fixture rollback hoàn toàn.
- Đột biến bằng `scripts/dot-bien.mjs`: bỏ CAS và bỏ kiểm quyền đều làm suite đỏ đúng nguyên nhân; khôi phục SHA ban đầu.
- Trình duyệt TEST chủ nhà và quản lý: hủy không gửi yêu cầu; xác nhận gọi RPC thật, dòng nháp biến mất và số lượng giảm; reload không hiện lại. Fixture đã dọn, không gọi production. Lượt đầu gặp timeout ở truy vấn danh sách hợp đồng nền; lượt chạy lại sạch lỗi.
- 56 ca trong 13 file test component hợp đồng đạt; app/E2E TypeScript, build và bundle đạt.
- Review độc lập schema: không có P0/P1. Giới hạn lưu trữ: file đang upload mà xóa nháp đồng thời có thể được giữ trong thư mục nháp đã xóa do quyền đọc/xóa Storage đã bị chặn. Chúng không được đăng ký thành tài liệu và không thể dùng ký; thao tác này giữ lịch sử/file, không có nhiệm vụ purge vật lý.

Chưa tính kết quả CI hoặc production là đạt ở thời điểm ghi tài liệu này. Biên nhận apply được forward lane ghi riêng; phát hành app phải qua CI đúng SHA.

## Kiểm chứng phát hành 30/09/2026

- Rebase trên `924b522b`, giữ thay đổi ghi chú trả phòng và hộp xử lý hoa hồng của main. Review độc lập bản `cca94be4`: không có P0/P1; digest SQL không đổi.
- Forward lane chạy thử thành công và áp hai lượt trong transaction rollback trước khi ghi thật. Sao lưu đầy đủ thành công trong 199 giây, 27,2 MB, đọc lại được 567 mục TABLE DATA; không loại dữ liệu bảng nào.
- Production đã áp migration lúc `2026-09-29T17:19:06Z`; biên nhận ở `docs/generated/schema-change-evidence/20260929034044_contract_draft_deletion.json`. Catalog trước/sau khác nhau đúng lần thay schema này.
- Trên mã sau rebase: 83 ca trong 16 file test component hợp đồng đạt; app TypeScript và Vite build đạt. E2E TEST chủ nhà và quản lý đều đạt: hủy, xác nhận xóa, số đếm, tải lại; không lỗi console, fixture đã dọn.
- Log phát hành chi tiết lưu ngoài Git trong `.superpowers/sdd/2026-09-30-draft-delete-release/`. Kiểm CI và promote app là bước riêng sau khi commit; không suy từ biên nhận database rằng app đã lên production.
