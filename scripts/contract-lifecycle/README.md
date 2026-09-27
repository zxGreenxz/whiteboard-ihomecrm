# Baseline tài chính hiện hành (P0c)

Đây là harness TEST để ghi lại hành vi trước khi đổi lifecycle; không đổi policy,
schema, cờ tính năng hoặc dữ liệu production. Suite local đã nằm trong glob CI
`scripts/tests/contract-lifecycle/*.test.mjs`; CI không chạy baseline có credential.

```powershell
npm exec --yes --package=node@24.18.0 -- node --test scripts/tests/contract-lifecycle/*.test.mjs
npm exec --yes --package=node@24.18.0 -- node scripts/contract-lifecycle/baseline.mjs --test --vault --ca-file "<đường dẫn CA Supabase PEM>"
```

`--vault` đọc đúng các trường TEST từ vault gốc qua loader đã có; bỏ tùy chọn này
để dùng biến môi trường TEST. Không có target mặc định hay chế độ commit. Thiếu
credential, CA, marker hoặc ca bắt buộc thì lệnh thoát khác 0. Evidence được ghi
vào `docs/generated/contract-lifecycle/<timestamp>-financial-baseline.json`.

Mỗi ca có một transaction riêng, kiểm TEST marker trên chính kết nối đó và luôn
ROLLBACK. Một transaction chỉ đọc khác kiểm không còn room/customer/contract,
sổ fixture, personal cashbook và possession fixture. Room/customer có UUID từ
run ID + tên ca; ID nguồn tiền do writer cấp. Sổ fixture có tên/key theo run ID,
số dư đầu 0, tạo qua `create_cashbook_v1`; `set_personal_cash_book_v1` chỉ được gọi
nếu người thu chưa có sổ cá nhân. Harness dừng nếu đã có cấu hình, không thay sổ
dùng chung. Giữ nguyên feature flags và ghi route thực tế vào từng ca.

- FORFEIT: cọc thực thu 1.000.000đ; hóa đơn chưa thu 100.000đ, trả 50.000/200.000đ,
  đã trả đủ 300.000đ; thu dư CREDIT 50.000đ; thu thêm 75.000đ. Kiểm hủy phần nợ,
  giữ phần đã thu, giữ hóa đơn đã trả đủ, cặp nội bộ tự duyệt, credit tiêu hết,
  và tiền thật không đổi.
- REFUND: nợ 200.000đ, cấn cọc và tạo phiếu hoàn 800.000đ UNAPPROVED, chưa chọn
  sổ, chưa chi tiền. Đường duyệt UI hiện tại
  `approve_pending_income_expense_checked_v1` phải từ chối P0001 khi chưa có sổ.
  Probe V2 riêng ghi 55000; không suy ra đây là đường UI hay chỉ riêng lỗi
  cùng transaction. Cả hai probe dùng savepoint và kiểm snapshot không đổi.
- DEBT: nợ 1.500.000đ, cấn cọc 1.000.000đ bằng CT, còn 500.000đ, không thu giả.
- PAID: gạch 1.500.000đ bằng CT, tạo phiếu thu thật và posting 500.000đ.

Các ca kiểm retry cùng key không đổi nguồn và khác payload trả 23505. Các writer
tạo hợp đồng, hóa đơn, thu tiền và thanh lý là writer hiện hành. Snapshot chỉ
chứa nguồn synthetic: hợp đồng/phòng, hóa đơn/payment, phiếu/item/posting/line,
canonical operations, credit lots và termination audit. Evidence ghim Git SHA,
digest mã harness, giờ server, nguồn SQL, số đếm và digest từng ca.

Giới hạn: đây là SQL chạy với claims của DEMO owner, **không phải chứng minh
authorization qua JWT**. Chưa kiểm duyệt/chi hoàn thành công sau commit, JWT
mutation theo vai trò, concurrency, đối chiếu tiền toàn hệ thống hoặc các tổ hợp
flags khác. Credit dương mới chứng minh FORFEIT với route hiện tại. Đột biến local
chỉ thay oracle/copy snapshot; không phải đột biến SQL/permission runtime.
